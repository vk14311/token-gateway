/**
 * token-gateway entrypoint.
 *  env overrides: TG_PORT, TG_HOST, TG_DATA_DIR, TG_PRICES_FILE, TG_CONFIG_FILE, TG_KEY_<UPSTREAM>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { AppConfig } from "./types.ts";
import { makeRequestHandler } from "./web.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgFile = process.env.TG_CONFIG_FILE ?? path.join(__dirname, "..", "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as AppConfig;

cfg.port = parseInt(process.env.TG_PORT ?? String(cfg.port), 10);
cfg.listenHost = process.env.TG_HOST ?? cfg.listenHost;

const handler = makeRequestHandler(cfg);

async function toWebRequest(nreq: import("node:http").IncomingMessage): Promise<Request> {
	const host = nreq.headers.host ?? "127.0.0.1";
	const url = `http://${host}${nreq.url ?? "/"}`;
	const headers = new Headers();
	for (const [k, v] of Object.entries(nreq.headers)) {
		if (v == null) continue;
		headers.set(k, Array.isArray(v) ? v.join(",") : String(v));
	}
	if (nreq.method === "GET" || nreq.method === "HEAD") {
		return new Request(url, { method: nreq.method, headers });
	}
	const chunks: Buffer[] = [];
	for await (const c of nreq) chunks.push(c as Buffer);
	return new Request(url, {
		method: nreq.method,
		headers,
		body: Buffer.concat(chunks),
	});
}

const server = createServer(async (nreq, res) => {
	try {
		const r = await handler(await toWebRequest(nreq));
		res.statusCode = r.status;
		r.headers.forEach((v, k) => {
			if (k.toLowerCase() === "content-length") return; // node manages framing (chunked for streams)
			res.setHeader(k, v);
		});
		if (r.body) Readable.fromWeb(r.body as any).pipe(res);
		else res.end();
	} catch (e) {
		if (!res.headersSent) {
			res.statusCode = 500;
			res.setHeader("content-type", "application/json");
		}
		res.end(JSON.stringify({ error: "gateway bug", detail: String(e) }));
	}
});

server.listen(cfg.port, cfg.listenHost, () => {
	console.log(`[token-gateway] listening on http://${cfg.listenHost}:${cfg.port}`);
	console.log(`[token-gateway] upstreams: ${Object.keys(cfg.upstreams).join(", ")}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
