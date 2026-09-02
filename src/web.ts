/**
 * Dashboard + JSON API.
 *   GET  /                 -> public/index.html
 *   GET  /api/stats?days=N -> daily/model/tool aggregates (+ per-platform bill compare)
 *   GET  /api/perf?minutes=N  -> per-upstream perf: TTFT, decode tok/s, cache-hit, error rate
 *   GET  /api/x99/metrics  -> proxied live vLLM Prometheus metrics (server-side panel)
 *   GET  /api/x99/hardware -> GPU probe via ssh nvidia-smi (5s TTL cache)
 *   GET  /api/stream?days=N&minutes=M -> SSE live push (2s snapshots: stats+perf+x99+hw)
 *   GET  /api/bills        -> ledger rows
 *   POST /api/bills        -> {platform, day, amountCny, note?}
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AppConfig, RequestRecord } from "./types.ts";
import { readRange, lastNDays, readBills, appendBill, dataDir } from "./store.ts";
import { makeProxyHandler } from "./proxy.ts";
import { liveView, startLiveTracker } from "./live.ts";
import { loadPrices } from "./prices.ts";
import { nowDay } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

interface Counts {
	reqs: number; errs: number; unmetered: number;
	tokIn: number; tokOut: number;
	cacheRead: number; cacheWrite: number; reasoning: number;
	cost: number;
}

interface DayAgg extends Counts {
	day?: string;
	unverifiedPrice?: boolean;
}

export function makeRequestHandler(cfg: AppConfig) {
	const proxy = makeProxyHandler(cfg);
	startHwRecorder(cfg);
	startPerfRecorder(cfg);
	startLiveTracker(cfg.upstreams.x99?.metricsUrl); // 1Hz prefix-cache sampler for /api/live (no-op without metricsUrl)

	return async function handler(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const p = url.pathname;

		if (p === "/" || p === "/index.html") return serve("index.html", "text/html; charset=utf-8");

		if (p === "/api/stats") {
			const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "14", 10) || 14, 1), 90);
			return Response.json(buildStats(readRange(lastNDays(days)), days));
		}

		if (p === "/api/perf") {
			const minutes = Math.min(Math.max(parseInt(url.searchParams.get("minutes") ?? "5", 10) || 5, 1), 1440);
			const since = Date.now() - minutes * 60000;
			const recs = readRange(lastNDays(2)).filter((r) => r.ts >= since);
			return Response.json(buildPerf(recs, minutes));
		}

		if (p === "/api/live") {
			return Response.json(liveView()); // in-flight x99 chat requests: prefill progress estimates (PiTask page polls this)
		}

		if (p === "/api/x99/metrics") {
			const mu = cfg.upstreams.x99?.metricsUrl;
			if (!mu) return Response.json({ ok: false, reason: "upstream x99 has no metricsUrl" }, { status: 404 });
			try {
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), 4000);
				const res = await fetch(mu, { signal: ac.signal, headers: { accept: "text/plain" } });
				clearTimeout(timer);
				if (!res.ok) return Response.json({ ok: false, reason: `metrics HTTP ${res.status}` });
				return Response.json({ ok: true, data: parseVllmMetrics(await res.text()) });
			} catch (e) {
				return Response.json({ ok: false, reason: `metrics unreachable: ${String(e).slice(0, 120)}` });
			}
		}

		if (p === "/api/x99/hardware") {
			const hw = cfg.upstreams.x99?.hardware;
			if (!hw) return Response.json({ ok: false, reason: "upstream x99 has no hardware probe" }, { status: 404 });
			return Response.json(await probeHardware(hw.sshHost));
		}

		if (p === "/api/hw/history") {
			const minutes = Math.min(Math.max(parseInt(url.searchParams.get("minutes") ?? "60", 10) || 60, 1), 1440);
			const since = Date.now() - minutes * 60000;
			const rows: any[] = [];
			for (const day of lastNDays(2)) {
				let text: string;
				try {
					text = fs.readFileSync(hwLogFilePath(cfg, day), "utf8");
				} catch {
					continue;
				}
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					try {
						const r = JSON.parse(line);
						if (r.ts >= since) rows.push(r);
					} catch {
						// torn tail write on crash — ignore partial line
					}
				}
			}
			return Response.json({ ok: true, minutes, rows });
		}

		if (p === "/api/x99/perf-history") {
			const minutes = Math.min(Math.max(parseInt(url.searchParams.get("minutes") ?? "60", 10) || 60, 1), 1440);
			const since = Date.now() - minutes * 60000;
			const rows: any[] = [];
			for (const day of lastNDays(2)) {
				let text: string;
				try {
					text = fs.readFileSync(perfLogFilePath(cfg, day), "utf8");
				} catch {
					continue;
				}
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					try {
						const r = JSON.parse(line);
						if (r.ts >= since) rows.push(r);
					} catch {
						// torn tail write on crash — ignore partial line
					}
				}
			}
			return Response.json({ ok: true, minutes, rows });
		}

		if (p === "/api/stream") {
			const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "14", 10) || 14, 1), 90);
			const minutes = Math.min(Math.max(parseInt(url.searchParams.get("minutes") ?? "5", 10) || 5, 1), 1440);
			return liveStream(cfg, days, minutes);
		}

		if (p === "/api/bills" && req.method === "GET") {
			return Response.json({ bills: readBills().sort((a, b) => a.day.localeCompare(b.day)) });
		}

		if (p === "/api/bills" && req.method === "POST") {
			try {
				const j = (await req.json()) as any;
				if (!j?.platform || !j?.day || typeof j.amountCny !== "number") {
					return Response.json({ error: "need platform, day, amountCny" }, { status: 400 });
				}
				appendBill({
					platform: String(j.platform).slice(0, 40),
					day: String(j.day).slice(0, 10),
					amountCny: j.amountCny,
					source: String(j.source ?? "manual").slice(0, 30),
					note: j.note ? String(j.note).slice(0, 200) : undefined,
				});
				return Response.json({ ok: true });
			} catch (e) {
				return Response.json({ error: String(e) }, { status: 400 });
			}
		}

		if (p.slice(1).includes("/")) {
			// anything shaped like /{tool}/{upstream}/... goes to the metering proxy
			return proxy(req);
		}

		return new Response("not found", { status: 404 });
	};
}

function serve(file: string, ctype: string): Response {
	try {
		const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
		return new Response(body, { headers: { "content-type": ctype } });
	} catch {
		return new Response(`${file} missing`, { status: 404 });
	}
}

// ── aggregation ──────────────────────────────────────────────────────────

export interface DayRow extends Counts {
	day: string;
}

function zero(): Counts {
	return { reqs: 0, errs: 0, unmetered: 0, tokIn: 0, tokOut: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
}

function countsOf(r: RequestRecord): Counts {
	return {
		reqs: 1,
		errs: r.status >= 400 || r.status === 0 ? 1 : 0,
		unmetered: r.usage ? 0 : 1,
		tokIn: r.usage?.tokIn ?? 0,
		tokOut: r.usage?.tokOut ?? 0,
		cacheRead: r.usage?.cacheRead ?? 0,
		cacheWrite: r.usage?.cacheWrite ?? 0,
		reasoning: r.usage?.reasoning ?? 0,
		cost: r.costCny ?? 0,
	};
}

function addTo(a: Counts, v: Counts): void {
	a.reqs += v.reqs;
	a.errs += v.errs;
	a.unmetered += v.unmetered;
	a.tokIn += v.tokIn;
	a.tokOut += v.tokOut;
	a.cacheRead += v.cacheRead;
	a.cacheWrite += v.cacheWrite;
	a.reasoning += v.reasoning;
	a.cost += v.cost;
}

function rowUnverified(provider: string, model: string): boolean {
	try {
		const rows = loadPrices().rows.filter((x) => x.provider === provider);
		const exact = rows.find((r) => r.model === model);
		if (exact) return !!exact.unverified;
		const w = rows
			.filter((r) => r.model.endsWith("*") && model.startsWith(r.model.slice(0, -1)))
			.sort((a, b) => b.model.length - a.model.length)[0];
		return w ? !!w.unverified : true;
	} catch {
		return true;
	}
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const round2 = (v: number) => Math.round(v * 100) / 100;

export function buildStats(records: RequestRecord[], windowDays: number) {
	const byDay = new Map<string, DayAgg>();
	const byModel = new Map<string, DayAgg & { upstream: string; model: string }>();
	const byTool = new Map<string, DayAgg>();

	for (const r of records) {
		let d = byDay.get(r.day);
		if (!d) byDay.set(r.day, (d = { day: r.day, ...zero() }));
		addTo(d, countsOf(r));

		const mk = `${r.upstream}/${r.model ?? "?"}`;
		let m = byModel.get(mk);
		if (!m) byModel.set(mk, (m = { upstream: r.upstream, model: r.model ?? "?", ...zero() }));
		addTo(m, countsOf(r));

		let t = byTool.get(r.tool);
		if (!t) byTool.set(r.tool, (t = { ...zero() }));
		addTo(t, countsOf(r));
	}

	const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) as DayRow[];
	const models = [...byModel.values()]
		.map((m) => ({ ...m, unverifiedPrice: rowUnverified(m.upstream, m.model), cost: round4(m.cost) }))
		.sort((a, b) => b.cost - a.cost || b.tokOut - a.tokOut);
	const tools = [...byTool.entries()]
		.map(([tool, agg]) => ({ tool, ...agg, cost: round4(agg.cost) }))
		.sort((a, b) => b.cost - a.cost);

	const totalsInWindow = zero();
	for (const d of days) addTo(totalsInWindow, d);

	// platform-level bill comparison (window covers stats only)
	const estByPlatform = new Map<string, number>();
	for (const r of records) if (r.costCny != null) estByPlatform.set(r.upstream, (estByPlatform.get(r.upstream) ?? 0) + r.costCny);
	const billByPlatform = new Map<string, number>();
	for (const b of readBills()) if (byDay.has(b.day)) billByPlatform.set(b.platform, (billByPlatform.get(b.platform) ?? 0) + b.amountCny);
	const platforms = [...new Set([...estByPlatform.keys(), ...billByPlatform.keys()])].map((pf) => ({
		platform: pf,
		gatewayEstimate: round4(estByPlatform.get(pf) ?? 0),
		billAmount: round4(billByPlatform.get(pf) ?? 0),
		deviationPct:
			billByPlatform.get(pf) && (billByPlatform.get(pf) as number) > 0
				? round2((((estByPlatform.get(pf) ?? 0) - (billByPlatform.get(pf) as number)) / (billByPlatform.get(pf) as number)) * 100)
				: null,
	}));

	let priceUnverified = false;
	try {
		priceUnverified = !!loadPrices().rows.some((row: any) => row.unverified);
	} catch {
		priceUnverified = true;
	}

	return {
		windowDays,
		today: nowDay(),
		generatedAt: new Date().toISOString(),
		totals: { ...totalsInWindow, cost: round4(totalsInWindow.cost) },
		days: days.map((d) => ({ ...d, cost: round4(d.cost) })),
		models,
		tools,
		platforms,
		priceUnverified,
	};
}

// ── live perf window (TTFT / decode tok/s / cache hit / errors) ──────────

interface PerfAgg {
	upstream: string;
	model: string;
	reqs: number;
	errs: number;
	streamReqs: number;
	ttftAvgMs: number | null; // streaming requests only
	ttftP50Ms: number | null;
	ttftP90Ms: number | null;
	tpsWeighted: number | null; // ΣtokOut / Σdecode_s  (streaming, usage+ttft known)
	tpsMedian: number | null; // per-request median
	tpsN: number;
	cacheHitPct: number | null; // ΣcacheRead / ΣtokIn
	avgTokIn: number | null;
	avgTokOut: number | null;
	reqPerMin: number;
	lastTs: number | null;
}

function pctile(sorted: number[], q: number): number | null {
	if (!sorted.length) return null;
	const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5));
	return sorted[idx];
}

export function buildPerf(records: RequestRecord[], minutes: number) {
	interface Acc extends Omit<PerfAgg, "upstream" | "model" | "ttftAvgMs" | "ttftP50Ms" | "ttftP90Ms" | "tpsWeighted" | "tpsMedian" | "cacheHitPct" | "avgTokIn" | "avgTokOut" | "reqPerMin"> {
		ttfts: number[];
		tpss: number[];
		decodeS: number;
		tpsTokOutS: number;
		tokInS: number;
		tokOutS: number;
		cacheS: number;
	}
	const byKey = new Map<string, Acc>();
	for (const r of records) {
		const key = `${r.upstream}/${r.model ?? "?"}`;
		let a = byKey.get(key);
		if (!a) byKey.set(key, (a = { upstream: r.upstream, model: r.model ?? "?", reqs: 0, errs: 0, streamReqs: 0, ttfts: [], tpss: [], decodeS: 0, tpsTokOutS: 0, tokInS: 0, tokOutS: 0, cacheS: 0, tpsN: 0, lastTs: null }));
		a.reqs++;
		if (r.status >= 400 || r.status === 0) a.errs++;
		if (r.usage) {
			a.tokInS += r.usage.tokIn ?? 0;
			a.tokOutS += r.usage.tokOut ?? 0;
			a.cacheS += r.usage.cacheRead ?? 0;
		}
		if (r.stream && r.ttftMs != null) a.ttfts.push(r.ttftMs);
		// decode speed needs a streaming request with usage: tokOut over the post-first-byte window.
		// Cap at 2000 tok/s per request: engine-crash-aborted streams yield huge tokOut over a tiny
		// window and would poison the aggregate (real single-request peak is a few hundred).
		if (r.stream && r.ttftMs != null && r.usage?.tokOut) {
			const decodeS = (r.latencyMs - r.ttftMs) / 1000;
			const out = r.usage.tokOut ?? 0;
			if (decodeS > 0.05 && out / decodeS < 2000) {
				a.tpss.push(out / decodeS);
				a.decodeS += decodeS;
				a.tpsTokOutS += out;
				a.tpsN++;
			}
		}
		if (r.ts > (a.lastTs ?? 0)) a.lastTs = r.ts;
	}

	const rows: PerfAgg[] = [...byKey.values()].map((a) => {
		const tSorted = [...a.ttfts].sort((x, y) => x - y);
		const tpSorted = [...a.tpss].sort((x, y) => x - y);
		return {
			upstream: a.upstream,
			model: a.model,
			reqs: a.reqs,
			errs: a.errs,
			streamReqs: a.ttfts.length,
			ttftAvgMs: tSorted.length ? Math.round(tSorted.reduce((s, v) => s + v, 0) / tSorted.length) : null,
			ttftP50Ms: Math.round(pctile(tSorted, 0.5) ?? 0) || null,
			ttftP90Ms: Math.round(pctile(tSorted, 0.9) ?? 0) || null,
			tpsWeighted: a.decodeS > 0 ? Math.round((a.tpsTokOutS / a.decodeS) * 10) / 10 : null,
			tpsMedian: tpSorted.length ? Math.round((pctile(tpSorted, 0.5) ?? 0) * 10) / 10 : null,
			tpsN: a.tpsN,
			cacheHitPct: a.tokInS > 0 ? Math.round((a.cacheS / a.tokInS) * 1000) / 10 : null,
			avgTokIn: a.reqs ? Math.round(a.tokInS / a.reqs) : null,
			avgTokOut: a.reqs ? Math.round(a.tokOutS / a.reqs) : null,
			reqPerMin: Math.round((a.reqs / minutes) * 100) / 100,
			lastTs: a.lastTs,
		};
	});
	rows.sort((x, y) => y.reqs - x.reqs);

	return {
		minutes,
		generatedAt: new Date().toISOString(),
		totalReqs: rows.reduce((s, r) => s + r.reqs, 0),
		rows,
	};
}

// ── x99 vLLM Prometheus metrics (server-side view) ───────────────────────

type PromSeries = { labels: Record<string, string>; value: number };

export function parseVllmMetrics(text: string) {
	const series = new Map<string, PromSeries[]>();
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("#")) continue;
		const sp = line.lastIndexOf(" ");
		if (sp <= 0) continue;
		const value = parseFloat(line.slice(sp + 1));
		if (!isFinite(value)) continue;
		const head = line.slice(0, sp).trim();
		let name = head;
		let labels: Record<string, string> = {};
		const brace = head.indexOf("{");
		if (brace >= 0 && head.endsWith("}")) {
			name = head.slice(0, brace);
			const inner = head.slice(brace + 1, -1);
			for (const m of inner.matchAll(/([a-zA-Z_][a-zA-Z_0-9]*)="((?:[^"\\]|\\.)*)"/g)) {
				labels[m[1]] = m[2];
			}
		}
		if (!name.startsWith("vllm:")) continue;
		const list = series.get(name) ?? [];
		list.push({ labels, value });
		series.set(name, list);
	}

	const sum = (name: string, filter?: (l: Record<string, string>) => boolean): number => {
		const list = series.get(name) ?? [];
		return list.filter((s) => !filter || filter(s.labels)).reduce((s, x) => s + x.value, 0);
	};
	const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
	const avgMs = (sumName: string, cntName: string): number | null => {
		const s = sum(sumName);
		const c = sum(cntName);
		return c > 0 ? Math.round((s / c) * 1000 * 100) / 100 : null;
	};
	const model = series.get("vllm:num_requests_running")?.[0]?.labels.model_name ?? null;

	// kv usage: per-worker gauge — report the busiest worker
	const kvList = (series.get("vllm:kv_cache_usage_perc") ?? []).map((s) => s.value);
	const kvMax = kvList.length ? Math.round(Math.max(...kvList) * 1000) / 10 : null;

	// KV pool capacity: vLLM exposes num_gpu_blocks / block_size / kv_cache_size_tokens
	// as labels of the info metric. usage = 1 - free/(num_gpu_blocks-1).
	const cfg = series.get("vllm:cache_config_info")?.[0]?.labels ?? {};
	const numGpuBlocks = cfg.num_gpu_blocks && cfg.num_gpu_blocks !== "None" ? parseInt(cfg.num_gpu_blocks, 10) : null;
	const kvCacheSizeTokens = cfg.kv_cache_size_tokens ? parseInt(cfg.kv_cache_size_tokens, 10) : null;
	// hybrid-architecture engines expose a block_size label that is NOT "tokens per block"
	// (e.g. 1648 vs true pool 718,636 tokens / 477 blocks), so derive used tokens from the real pool size.
	const kvInUseTokens = kvCacheSizeTokens != null && kvMax != null ? Math.round(kvCacheSizeTokens * kvMax / 100) : null;

	const cacheHits = sum("vllm:prefix_cache_hits_total");
	const cacheQueries = sum("vllm:prefix_cache_queries_total");
	const specAccepted = sum("vllm:spec_decode_num_accepted_tokens_total");
	const specDraft = sum("vllm:spec_decode_num_draft_tokens_total");
	const specDrafts = sum("vllm:spec_decode_num_drafts_total");
	const genTokens = sum("vllm:generation_tokens_total");
	const promptCacheHit = sum("vllm:prompt_tokens_by_source_total", (l) => l.source === "local_cache_hit");
	const promptCompute = sum("vllm:prompt_tokens_by_source_total", (l) => l.source === "local_compute");
	const promptTotal = sum("vllm:prompt_tokens_total");

	return {
		model,
		online: true,
		numRunning: sum("vllm:num_requests_running"),
		numWaiting: sum("vllm:num_requests_waiting"),
		kvCacheUsagePct: kvMax,
		kvCacheTotalTokens: kvCacheSizeTokens,
		specPerDraft: specDrafts > 0 ? Math.round((specAccepted / specDrafts) * 10) / 10 : null,
		avgPromptTokens: (() => {
			const c = sum("vllm:request_prompt_tokens_count");
			return c > 0 ? Math.round(promptTotal / c) : null;
		})(),
		avgGenTokens: (() => {
			const c = sum("vllm:request_generation_tokens_count");
			return c > 0 ? Math.round(genTokens / c) : null;
		})(),
		kvCacheUsedTokens: kvInUseTokens,
		kvCacheNumBlocks: numGpuBlocks,
		prefixCacheHitPct: ratio(cacheHits, cacheQueries),
		promptCacheHitPct: ratio(promptCacheHit, promptTotal),
		specAcceptPct: specDraft > 0 ? ratio(specAccepted, specDraft) : null, // null = spec disabled (scheme A)
		specAcceptedTokens: specAccepted,
		specDraftTokens: specDraft,
		ttftAvgMs: avgMs("vllm:time_to_first_token_seconds_sum", "vllm:time_to_first_token_seconds_count"),
		itlAvgMs: avgMs("vllm:inter_token_latency_seconds_sum", "vllm:inter_token_latency_seconds_count"),
		e2eAvgMs: avgMs("vllm:e2e_request_latency_seconds_sum", "vllm:e2e_request_latency_seconds_count"),
		prefillAvgMs: avgMs("vllm:request_prefill_time_seconds_sum", "vllm:request_prefill_time_seconds_count"),
		decodeAvgS: (() => {
			const s = sum("vllm:request_decode_time_seconds_sum");
			const c = sum("vllm:request_decode_time_seconds_count");
			return c > 0 ? Math.round((s / c) * 100) / 100 : null;
		})(),
		promptTokensTotal: promptTotal,
		promptComputeTokens: promptCompute,
		generationTokensTotal: genTokens,
		preemptionsTotal: sum("vllm:num_preemptions_total"),
		successTotal: sum("vllm:request_success_total"),
		generatedAt: new Date().toISOString(),
	};
}

// ── x99 实时窗口吞吐（近 6s 整体速率，计数器差分，非累计均值）─────────────
// vLLM 的 Prometheus 只有进程启动起的累计计数器，无窗口口径；这里在 collector
// 的 2s 节拍上自己记一条 ring（窗口 3 个采样点，~300 token/窗口），差分出「当前这一刻」的吞吐。
// 空闲即回落，vLLM 重启（计数器归零）时自动清 ring 重新预热 6s。
const X99_WINDOW_MS = 6_000;
interface X99Sample {
	ts: number;
	gen: number;
	prompt: number;
	compute: number;
}
const x99Ring: X99Sample[] = [];

function trackX99Window(d: any): void {
	if (d.online !== true) return;
	const ts = Date.now();
	const s: X99Sample = {
		ts,
		gen: d.generationTokensTotal ?? 0,
		prompt: d.promptTokensTotal ?? 0,
		compute: d.promptComputeTokens ?? 0,
	};
	const last = x99Ring[x99Ring.length - 1];
	if (last && (s.gen < last.gen || s.prompt < last.prompt || s.compute < last.compute)) x99Ring.length = 0; // 计数器回退 = 引擎重启
	x99Ring.push(s);
	const cutoff = ts - X99_WINDOW_MS - 4_000; // 2s 节拍，4s 余量
	while (x99Ring.length > 2 && x99Ring[0].ts < cutoff) x99Ring.shift();
	// 基线 = 不晚于 now-6s 的最新样本（实际窗口 6~8s）
	let base: X99Sample | null = null;
	for (const x of x99Ring) if (x.ts <= ts - X99_WINDOW_MS) base = x;
	if (!base) return; // 预热中（<6s）
	const el = (ts - base.ts) / 1000;
	if (ts - base.ts < X99_WINDOW_MS / 2) return;
	const r1 = (v: number) => Math.round(v * 10) / 10;
	d.perfWindow = {
		seconds: X99_WINDOW_MS / 1000,
		elapsedS: r1(el),
		decodeTokS: r1(Math.max(0, s.gen - base.gen) / el),
		prefillTokS: r1(Math.max(0, s.compute - base.compute) / el),
		promptTokS: r1(Math.max(0, s.prompt - base.prompt) / el),
	};
}

// ── GPU hardware probe via ssh + nvidia-smi (15s TTL cache) ──────────────

const NVML_PY = `
import subprocess, json, re
csv = subprocess.run(["nvidia-smi","--query-gpu=index,temperature.gpu,clocks.sm,power.draw,fan.speed,memory.used,memory.total,utilization.gpu","--format=csv,noheader,nounits"],capture_output=True,text=True).stdout
gpus=[]
for line in csv.strip().split("\\n"):
    p=[x.strip() for x in line.split(",")]
    if len(p)<8: continue
    gpus.append({"index":int(float(p[0])),"tempC":float(p[1]),"smMHz":float(p[2]),"powerW":float(p[3]),"fanPct":float(p[4]),"memUsedMiB":float(p[5]),"memTotalMiB":float(p[6]),"utilPct":float(p[7])})
q = subprocess.run(["nvidia-smi","-q","-d","PERFORMANCE"],capture_output=True,text=True).stdout
gidx=-1; reasons={}
for line in q.split("\\n"):
    if re.match(r"\\s*GPU\\s+[0-9A-Fa-f:\\-.]+",line): gidx+=1
    rm=re.match(r"\\s+(SW Power Cap|SW Thermal Slowdown|HW Slowdown|HW Thermal Slowdown)\\s*:\\s*(Active|Not Active)",line)
    if rm and gidx>=0: reasons.setdefault(gidx,{})[rm.group(1)]=(rm.group(2)=="Active")
for g in gpus:
    r=reasons.get(g["index"],{})
    g["throttleActive"]=[k for k,v in r.items() if v]
tq = subprocess.run(["nvidia-smi","-q","-d","TEMPERATURE"],capture_output=True,text=True).stdout
tidx=-1; tmap={}
for line in tq.split("\\n"):
    if re.match(r"\\s*GPU\\s+[0-9A-Fa-f:\\-.]+",line): tidx+=1
    tm=re.match(r"\\s+(GPU Current Temp\\w*|GPU Memory Temperature|Memory Junction Temperature|GPU Slowdown Temp\\w*)\\s*:\\s*([0-9]+)",line)
    if tm and tidx>=0: tmap.setdefault(tidx,{})[tm.group(1)]=int(tm.group(2))
for g in gpus:
    tt=tmap.get(g["index"],{})
    g["memTempC"]=tt.get("GPU Memory Temperature", tt.get("Memory Junction Temperature"))
    g["slowdownTempC"]=tt.get("GPU Slowdown Temp")
print(json.dumps(gpus))
`;

interface HardwareCache {
	at: number;
	data: any;
}
let hwCache: HardwareCache | null = null;
const HW_TTL_MS = 5000;

function sshProbe(sshHost: string, timeoutMs: number): Promise<any> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes", sshHost, "python3", "-"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`ssh probe timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(`ssh exit ${code}: ${err.slice(0, 120)}`));
			try {
				resolve(JSON.parse(out));
			} catch {
				reject(new Error(`bad probe output: ${out.slice(0, 120)}`));
			}
		});
		child.stdin.end(NVML_PY);
	});
}

/** Single-flight ssh refresh; resolves with gpus, rejects on failure. */
function refreshHardwareOnce(sshHost: string): Promise<any> {
	const p = sshProbe(sshHost, 6000).then((gpus) => {
		hwCache = { at: Date.now(), data: gpus };
		return gpus;
	});
	hwRefreshing = p.then(() => {}, () => {});
	return p;
}

/** Fire-and-forget refresh used by the live collector loop; keeps stale data on failure. */
function hardwareTick(sshHost: string | undefined): void {
	if (!sshHost) return;
	if (hwCache && Date.now() - hwCache.at < HW_TTL_MS) return;
	refreshHardwareOnce(sshHost).catch(() => {});
}

async function probeHardware(sshHost: string) {
	if (hwCache && Date.now() - hwCache.at < HW_TTL_MS) {
		return { ok: true, cached: true, gpus: hwCache.data, generatedAt: new Date(hwCache.at).toISOString() };
	}
	try {
		const gpus = await refreshHardwareOnce(sshHost);
		return { ok: true, cached: false, gpus, generatedAt: new Date().toISOString() };
	} catch (e) {
		return { ok: false, reason: `hardware probe failed: ${String(e).slice(0, 120)}` };
	}
}

// ── persistent hardware recorder: 15s cadence -> data/hw/YYYY-MM-DD.jsonl ──

const HW_LOG_INTERVAL_MS = 15000;
const HW_RETENTION_DAYS = 30;
let hwRecorderTimer: ReturnType<typeof setInterval> | null = null;
let lastHwLoggedAt = 0;
let hwCleanupDay: string | null = null;

function hwLogFilePath(cfg: AppConfig, day: string): string {
	return path.join(dataDir(), "hw", `${day}.jsonl`);
}

/** Always-on recorder: history survives dashboard close; ssh failures leave gaps, not junk. */
function startHwRecorder(cfg: AppConfig): void {
	const sshHost = cfg.upstreams.x99?.hardware?.sshHost;
	if (!sshHost || hwRecorderTimer) return;
	recordHardwareOnce(cfg, sshHost).catch(() => {});
	hwRecorderTimer = setInterval(() => {
		recordHardwareOnce(cfg, sshHost).catch(() => {});
	}, HW_LOG_INTERVAL_MS);
	hwRecorderTimer.unref?.();
}

async function recordHardwareOnce(cfg: AppConfig, sshHost: string): Promise<void> {
	const now = Date.now();
	if (now - lastHwLoggedAt < HW_LOG_INTERVAL_MS - 1000) return;
	let gpus: any;
	try {
		gpus = await refreshHardwareOnce(sshHost);
	} catch {
		return; // probe failed — skip this cadence
	}
	lastHwLoggedAt = Date.now();
	const day = nowDay(new Date(now));
	const file = hwLogFilePath(cfg, day);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify({ ts: lastHwLoggedAt, gpus }) + "\n");
	if (hwCleanupDay !== day) {
		hwCleanupDay = day;
		try {
			const cutoff = nowDay(new Date(now - HW_RETENTION_DAYS * 86400000));
			for (const f of fs.readdirSync(path.join(dataDir(), "hw"))) {
				const d = f.replace(/\.jsonl$/, "");
				if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) fs.rmSync(path.join(dataDir(), "hw", f), { force: true });
			}
		} catch {
			// retention sweep is best effort
		}
	}
}

// ── persistent x99 throughput recorder: 6s cadence -> data/x99perf/YYYY-MM-DD.jsonl ──
// 独立于 dashboard SSE collector（那个只在有人开页面时跑）：这个常驻采样器保证
// 6s 吞吐历史在无人看时也持续落盘，事后可与 data/hw（15s 温度）对照。

const PERF_LOG_INTERVAL_MS = 6000;
const PERF_RETENTION_DAYS = 30;
let perfRecorderTimer: ReturnType<typeof setInterval> | null = null;
let perfCleanupDay: string | null = null;
interface PerfSample {
	ts: number;
	gen: number;
	prompt: number;
	compute: number;
	running: number;
	ctx: number; // KV 池已用 token（瞬时 gauge，含前缀缓存留存）——「上下文长度」口径
}
const perfRing: PerfSample[] = [];

function perfLogFilePath(cfg: AppConfig, day: string): string {
	return path.join(dataDir(), "x99perf", `${day}.jsonl`);
}

function startPerfRecorder(cfg: AppConfig): void {
	const metricsUrl = cfg.upstreams.x99?.metricsUrl;
	if (!metricsUrl || perfRecorderTimer) return;
	const tick = () => recordPerfOnce(cfg, metricsUrl).catch(() => {});
	tick();
	perfRecorderTimer = setInterval(tick, PERF_LOG_INTERVAL_MS);
	perfRecorderTimer.unref?.();
}

async function recordPerfOnce(cfg: AppConfig, metricsUrl: string): Promise<void> {
	let text: string;
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 3000);
		const res = await fetch(metricsUrl, { signal: ac.signal, headers: { accept: "text/plain" } });
		clearTimeout(timer);
		if (!res.ok) return;
		text = await res.text();
	} catch {
		return; // unreachable — skip this cadence, ring keeps the gap
	}
	const d = parseVllmMetrics(text);
	if (d.online !== true) return;
	const ts = Date.now();
	const s: PerfSample = {
		ts,
		gen: d.generationTokensTotal ?? 0,
		prompt: d.promptTokensTotal ?? 0,
		compute: d.promptComputeTokens ?? 0,
		running: d.numRunning ?? 0,
		ctx: d.kvCacheUsedTokens ?? 0,
	};
	const last = perfRing[perfRing.length - 1];
	if (last && (s.gen < last.gen || s.prompt < last.prompt || s.compute < last.compute)) perfRing.length = 0; // 引擎重启
	perfRing.push(s);
	const cutoff = ts - PERF_LOG_INTERVAL_MS * 3;
	while (perfRing.length > 2 && perfRing[0].ts < cutoff) perfRing.shift();
	// 基线 = 不晚于 now-6s 的最新样本（实际窗口 6~12s，随 tick 抖动）
	let base: PerfSample | null = null;
	for (const x of perfRing) if (x.ts <= ts - PERF_LOG_INTERVAL_MS) base = x;
	if (!base || ts - base.ts < PERF_LOG_INTERVAL_MS / 2) return; // 预热中
	const el = (ts - base.ts) / 1000;
	const r1 = (v: number) => Math.round(v * 10) / 10;
	const day = nowDay(new Date(ts));
	const file = perfLogFilePath(cfg, day);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(
		file,
		JSON.stringify({
			ts,
			decodeTokS: r1(Math.max(0, s.gen - base.gen) / el),
			prefillTokS: r1(Math.max(0, s.compute - base.compute) / el),
			running: s.running,
			ctxTokens: s.ctx,
		}) + "\n",
	);
	if (perfCleanupDay !== day) {
		perfCleanupDay = day;
		try {
			const cutoffDay = nowDay(new Date(ts - PERF_RETENTION_DAYS * 86400000));
			for (const f of fs.readdirSync(path.join(dataDir(), "x99perf"))) {
				const dd = f.replace(/\.jsonl$/, "");
				if (/^\d{4}-\d{2}-\d{2}$/.test(dd) && dd < cutoffDay) fs.rmSync(path.join(dataDir(), "x99perf", f), { force: true });
			}
		} catch {
			// retention sweep is best effort
		}
	}
}

// ── live push: unified collector + SSE fan-out ───────────────────────────

const SNAP_INTERVAL_MS = 2000;
let hwRefreshing: Promise<void> = Promise.resolve();

interface LiveSnapshotFrame {
	ts: number;
	x99: any;
	hw: any;
	stats: any;
	perf: any;
}

interface LiveClient {
	days: number;
	minutes: number;
	send: (f: LiveSnapshotFrame) => void;
}

const liveClients = new Map<string, LiveClient>();
const lastFrameByWindow = new Map<string, LiveSnapshotFrame>();
let collectorTimer: ReturnType<typeof setInterval> | null = null;
let collecting = false;

function ensureCollector(cfg: AppConfig): void {
	if (collectorTimer) return;
	collectorTimer = setInterval(() => {
		collectOnce(cfg).catch(() => {});
	}, SNAP_INTERVAL_MS);
	collectorTimer.unref?.();
}

async function collectOnce(cfg: AppConfig): Promise<void> {
	if (collecting || liveClients.size === 0) return;
	collecting = true;
	try {
		const x99hw = cfg.upstreams.x99;
		let x99: any = { ok: false, reason: "upstream x99 has no metricsUrl" };
		if (x99hw?.metricsUrl) {
			try {
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), 3000);
				const res = await fetch(x99hw.metricsUrl, { signal: ac.signal, headers: { accept: "text/plain" } });
				clearTimeout(timer);
				x99 = res.ok ? { ok: true, data: parseVllmMetrics(await res.text()) } : { ok: false, reason: `metrics HTTP ${res.status}` };
				if (x99.ok) trackX99Window(x99.data);
			} catch (e) {
				x99 = { ok: false, reason: `metrics unreachable: ${String(e).slice(0, 120)}` };
			}
		}
		hardwareTick(x99hw?.hardware?.sshHost);
		const hw = hwCache
			? { ok: true, cached: true, gpus: hwCache.data, generatedAt: new Date(hwCache.at).toISOString() }
			: { ok: false, reason: "hardware probe pending" };

		// aggregate once per distinct window actually in use
		const dayWins = [...new Set([...liveClients.values()].map((c) => c.days))];
		const minWins = [...new Set([...liveClients.values()].map((c) => c.minutes))];
		const statsByWin = new Map<number, any>();
		for (const d of dayWins) statsByWin.set(d, buildStats(readRange(lastNDays(d)), d));
		const perfByWin = new Map<number, any>();
		for (const m of minWins) {
			const since = Date.now() - m * 60000;
			perfByWin.set(m, buildPerf(readRange(lastNDays(2)).filter((r) => r.ts >= since), m));
		}

		const ts = Date.now();
		for (const [key, c] of liveClients) {
			const frame: LiveSnapshotFrame = { ts, x99, hw, stats: statsByWin.get(c.days), perf: perfByWin.get(c.minutes) };
			lastFrameByWindow.set(`${c.days}/${c.minutes}`, frame);
			try {
				c.send(frame);
			} catch {
				liveClients.delete(key);
			}
		}
	} finally {
		collecting = false;
	}
}

function liveStream(cfg: AppConfig, days: number, minutes: number): Response {
	const key = `${days}/${minutes}/${Math.random().toString(36).slice(2, 8)}`;
	const enc = new TextEncoder();
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const client: LiveClient = {
				days,
				minutes,
				send: (f) => {
					if (closed) return;
					controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
				},
			};
			liveClients.set(key, client);
			ensureCollector(cfg);
			const warm = lastFrameByWindow.get(`${days}/${minutes}`);
			if (warm) {
				try {
					controller.enqueue(enc.encode(`data: ${JSON.stringify(warm)}\n\n`));
				} catch {
					closed = true;
					liveClients.delete(key);
				}
			}
		},
		cancel() {
			closed = true;
			liveClients.delete(key);
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no",
		},
	});
}
