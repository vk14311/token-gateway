/**
 * Transparent metering proxy.
 * Route shape: /{tool}/{upstream}/rest — the tool segment is for attribution only.
 *
 * Metering strategy:
 *  - POST …/chat/completions is the interesting one:
 *      · non-stream: buffer JSON response, read .usage
 *      · stream:     inject stream_options.include_usage when missing,
 *                    relay bytes unchanged while scanning SSE frames for usage
 *  - everything else relays untouched (header hygiene only).
 */
import type { AppConfig, UsageRecord } from "./types.ts";
import { normalizeUsage, usageFromJsonBody, SseScanner, type SseScanResult } from "./usage.ts";
import { append } from "./store.ts";
import { computeCost } from "./prices.ts";
import { nowDay } from "./types.ts";

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length", // recomputed by fetch / re-serve layer
]);

function stripClientHeaders(h: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	h.forEach((v, k) => {
		if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
	});
	return out;
}

interface FinishArgs {
	tool: string;
	upstream: string;
	model: string | null;
	restPath: string;
	method: string;
	startedAt: number;
	status: number;
	scan: SseScanResult | null;
	injectedUsageOpt: boolean;
	errorNote?: string;
}

export function makeProxyHandler(cfg: AppConfig) {
	const upstreams = cfg.upstreams;

	function finish(args: FinishArgs): void {
		const usage: UsageRecord | null = args.scan?.usage ?? null;
		const model = args.model ?? args.scan?.model ?? null;
		let costCny: number | null = null;
		if (usage) {
			costCny = computeCost(args.upstream, model, {
				tokIn: usage.tokIn,
				tokOut: usage.tokOut,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			}).cost;
		}
		append({
			ts: Date.now(),
			day: nowDay(),
			tool: args.tool,
			upstream: args.upstream,
			model,
			method: args.method,
			path: args.restPath,
			status: args.status,
			latencyMs: Date.now() - args.startedAt,
			usage: usage ? { ...usage, raw: undefined } : null,
			costCny,
			error: args.status >= 400 || args.errorNote ? (args.errorNote ?? `HTTP ${args.status}`).slice(0, 300) : undefined,
			injectedUsageOpt: args.injectedUsageOpt || undefined,
		});
	}

	return async function handle(req: Request): Promise<Response> {
		const startedAt = Date.now();
		const url = new URL(req.url);
		const parts = url.pathname.split("/").filter(Boolean); // [tool, upstream, ...rest]
		if (parts.length < 2) {
			return Response.json({ error: "route must be /{tool}/{upstream}/..." }, { status: 400 });
		}
		const [tool, upName, ...rest] = parts;
		const def = upstreams[upName];
		if (!def) {
			return Response.json({ error: `unknown upstream "${upName}"`, known: Object.keys(upstreams) }, { status: 404 });
		}
		const restPath = "/" + rest.join("/");
		const targetUrl = def.target.replace(/\/$/, "") + restPath + url.search;

		// ── request preparation ───────────────────────────────────────────
		const fwdHeaders = stripClientHeaders(req.headers);
		const envKey = process.env[`TG_KEY_${upName.toUpperCase()}`];
		if (envKey) fwdHeaders["authorization"] = `Bearer ${envKey}`;
		else if (!fwdHeaders["authorization"] && def.key) fwdHeaders["authorization"] = `Bearer ${def.key}`;

		let bodyInit: ArrayBuffer | undefined;
		let injectedUsageOpt = false;
		let reqModel: string | null = null;

		if (req.method !== "GET" && req.method !== "HEAD") {
			bodyInit = await req.arrayBuffer();
			const ctype = fwdHeaders["content-type"] ?? "";
			if (
				ctype.includes("application/json") &&
				bodyInit.byteLength > 0 &&
				bodyInit.byteLength < 4 * 1024 * 1024 &&
				restPath.endsWith("/chat/completions")
			) {
				try {
					const j = JSON.parse(new TextDecoder().decode(bodyInit)) as Record<string, any>;
					if (typeof j.model === "string") reqModel = j.model;
					if (j.stream === true && !j.stream_options?.include_usage) {
						j.stream_options = { ...(j.stream_options ?? {}), include_usage: true };
						injectedUsageOpt = true;
						bodyInit = new TextEncoder().encode(JSON.stringify(j)).buffer as ArrayBuffer;
					}
				} catch {
					/* opaque body — pass through */
				}
			}
		}

		// ── outbound fetch ────────────────────────────────────────────────
		let upRes: Response;
		try {
			upRes = await fetch(targetUrl, {
				method: req.method,
				headers: fwdHeaders,
				body: bodyInit,
				redirect: "manual",
			});
		} catch (err) {
			finish({
				tool, upstream: upName, model: reqModel, restPath, method: req.method,
				startedAt, status: 0, scan: null, injectedUsageOpt,
				errorNote: `upstream unreachable: ${(err as Error).message}`.slice(0, 300),
			});
			return Response.json({ error: "upstream unreachable", detail: String(err) }, { status: 502 });
		}

		// ── response header hygiene ───────────────────────────────────────
		const resHeaders = new Headers();
		upRes.headers.forEach((v, k) => {
			const lk = k.toLowerCase();
			if (HOP_BY_HOP.has(lk)) return;
			if (lk === "content-encoding") return; // undici hands us decoded bytes
			resHeaders.set(k, v);
		});
		resHeaders.delete("content-length"); // we may re-chunk

		const ctype = upRes.headers.get("content-type") ?? "";
		const isSse = ctype.includes("text/event-stream");

		// ── streaming path ────────────────────────────────────────────────
		if (isSse && upRes.body) {
			const scanner = new SseScanner();
			const decoder = new TextDecoder("utf-8");
			let done = false;
			const onDone = () => {
				if (done) return;
				done = true;
				scanner.end();
				finish({
					tool, upstream: upName, model: scanner.result.model ?? reqModel, restPath,
					method: req.method, startedAt, status: upRes.status,
					scan: scanner.result, injectedUsageOpt,
				});
			};
			const meteringStream = upRes.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, ctrl) {
						scanner.push(decoder.decode(chunk, { stream: true }));
						ctrl.enqueue(chunk);
					},
					flush() {
						decoder.decode(); // flush decoder state
					},
				}),
			);
			// Tee: one branch to the client, one to a silent consumer for metering.
			const [toClient, toMeter] = meteringStream.tee();
			toMeter
				.pipeTo(new WritableStream<Uint8Array>({ write() {} }))
				.then(onDone)
				.catch((e) => {
					done = true;
					finish({
						tool, upstream: upName, model: scanner.result.model ?? reqModel, restPath,
						method: req.method, startedAt, status: upRes.status,
						scan: scanner.end(), injectedUsageOpt, errorNote: `relay: ${e}`.slice(0, 300),
					});
				});
			return new Response(toClient, { status: upRes.status, headers: resHeaders });
		}

		// ── buffered path (JSON / text / everything else) ────────────────
		const text = await upRes.text();
		let usage: UsageRecord | null = null;
		let respModel: string | null = null;
		if (ctype.includes("application/json")) {
			const got = usageFromJsonBody(text);
			usage = got.usage;
			respModel = got.model;
		}
		finish({
			tool, upstream: upName, model: respModel ?? reqModel, restPath,
			method: req.method, startedAt, status: upRes.status,
			scan: usage ? { usage, model: respModel, sawDone: false, frames: 1 } : null,
			injectedUsageOpt,
		});
		return new Response(text, { status: upRes.status, headers: resHeaders });
	};
}
