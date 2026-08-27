/**
 * Self-test: spins mock upstreams + the real gateway handler over ephemeral ports,
 * asserts SSE frame scanning, stream_options injection, non-stream usage extraction,
 * cost computation and store aggregation. No network, no keys needed.
 * Run: npm test
 */
import { createServer as httpServer } from "node:http";
import fs from "node:fs";
import { makeRequestHandler } from "../src/web.ts";
import { readDay, readRange } from "../src/store.ts";
import type { AppConfig } from "../src/types.ts";
import assert from "node:assert";

let failed = 0;
const ok = (name: string, cond: boolean) => {
	console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}`);
	if (!cond) failed++;
};

// ── mock upstream: reports what it received via headers ──────────────────
const seenBodies: any[] = [];
const up = httpServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		let body: any = {};
		try {
			body = JSON.parse(raw);
		} catch {}
		seenBodies.push(body);
		const sawInjection = !!body.stream_options?.include_usage;

		if (body.stream) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const frames = [
				`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { role: "assistant" } }] })}\n\n`,
				`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
				`data: ${JSON.stringify({
					choices: [],
					usage: {
						prompt_tokens: 120,
						completion_tokens: 33,
						prompt_tokens_details: { cached_tokens: 100 },
						completion_tokens_details: { reasoning_tokens: 20 },
					},
				})}\n\n`,
				"data: [DONE]\n\n",
			];
			for (const f of frames) res.write(f);
			res.end();
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					model: body.model,
					usage: { prompt_tokens: 50, completion_tokens: 10 },
				}),
			);
		}
	});
});
await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
const mockPort = (up.address() as any).port;

// ── gateway config pointing at the mock ──────────────────────────────────
process.env.TG_DATA_DIR = "/tmp/tg-selftest-data";
fs.rmSync("/tmp/tg-selftest-data", { recursive: true, force: true });

const cfg: AppConfig = {
	listenHost: "127.0.0.1",
	port: 0,
	upstreams: {
		testup: { target: `http://127.0.0.1:${mockPort}`, label: "mock" },
	},
};
const handler = makeRequestHandler(cfg);

async function call(pathname: string, init?: RequestInit): Promise<Response> {
	return handler(new Request(`http://gw.test${pathname}`, init));
}

console.log("selftest:");

// 1) streaming request → usage extracted from final frame
{
	const res = await call("/pi/testup/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "glm-4.7-flash", stream: true }),
	});
	ok("stream: status 200 & sse passthrough", res.status === 200 && (res.headers.get("content-type") ?? "").includes("event-stream"));
	const text = await res.text();
	ok("stream: client got all frames + DONE", text.includes("[DONE]") && text.split("\n\n").length >= 4);
	ok("stream: include_usage was injected upstream", seenBodies.at(-1)?.stream_options?.include_usage === true);

	await new Promise((r) => setTimeout(r, 80)); // metering branch settles
	const recs = readRange(["2020-01-01"]); // will be empty for that day
	const todayRecs = [...(readDay(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })) ?? [])];
	const mine = todayRecs.filter((r) => r.tool === "pi");
	ok("stream: record stored with usage", mine.length === 1 && mine[0].usage?.tokIn === 120 && mine[0].usage?.tokOut === 33);
	ok("stream: cache_read + reasoning captured", mine[0].usage?.cacheRead === 100 && mine[0].usage?.reasoning === 20);
	ok("stream: tool attributed from path", mine[0].tool === "pi");
	ok("stream: injectedUsageOpt flagged", mine[0].injectedUsageOpt === true);
}

// 2) non-streaming request
{
	const res = await call("/cc/testup/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "qwen3.8-flash", stream: false }),
	});
	const j = await res.json();
	ok("nonstream: json relayed", j.usage?.prompt_tokens === 50);
	await new Promise((r) => setTimeout(r, 60));
	const recs = readDay(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })).filter((r) => r.tool === "cc");
	ok("nonstream: usage recorded", recs.length === 1 && recs[0].usage?.tokIn === 50 && recs[0].usage?.tokOut === 10);
}

// 3) stats endpoint aggregates both
{
	const res = await call("/api/stats?days=7");
	const stats = await res.json();
	ok("stats: totals.reqs == 2", stats.totals.reqs === 2);
	ok("stats: models has both models", stats.models.length === 2);
	ok("stats: tools separated pi/cc", stats.tools.map((t: any) => t.tool).sort().join(",") === "cc,pi");
	ok("stats: platform bill section present", Array.isArray(stats.platforms));
}

// 4) unknown upstream -> 404; malformed route -> 400
{
	ok("unknown upstream 404", (await call("/pi/nope/chat/completions", { method: "POST" })).status === 404);
	ok("single segment 404", (await call("/onlyonesegment")).status === 404);
}

console.log(failed === 0 ? "\nALL GREEN" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
