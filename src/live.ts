/**
 * Live prefill-progress tracker for vLLM upstreams (currently x99).
 *
 * Research findings (2026-09-02, measured against x99 vLLM v0.28 while sampling /metrics at 1Hz):
 *  - vllm:prefix_cache_queries_total / vllm:prefix_cache_hits_total jump at REQUEST ADMISSION
 *    (within ~1s of submit): queries Δ = total prompt tokens, hits Δ = tokens already in prefix cache.
 *  - vllm:prompt_tokens_total / prompt_tokens_by_source_total (local_compute / local_cache_hit)
 *    jump only at COMPLETION — there is NO live "tokens computed so far" counter.
 *  - So per-request progress during prefill is an ESTIMATE:
 *      miss = queriesΔ − hitsΔ at admission;  progress = elapsed / (miss / measured prefill tok/s).
 *  - Measured prefill rate (admission → first byte, per completed request) is calibrated on the fly
 *    (rolling window, default 1700 tok/s ≈ x99 Qwen3.8-27B cold prefill).
 *
 * The gateway sits in the request path (pi/cc/codex/… → x99), so it knows exactly when each request
 * was forwarded / first byte arrived / finished — we pair those moments with the admission-time
 * cache counters to build per-request progress, exposed via GET /api/live (loopback-only).
 *
 * Cost: one extra LAN fetch of /metrics per second (backed off to skip when unreachable).
 */

export interface LiveReq {
	id: number;
	tool: string;
	upstream: string;
	t0: number; // ms epoch: gateway forwarded the request
	promptChars: number; // raw request body bytes (rough pre-admission size hint)
	phase: "queued" | "prefill" | "streaming";
	admittedAt: number | null; // ms: prefix-cache counters jumped for this request
	promptTokens: number | null; // prefix_cache_queries Δ at admission
	cacheHits: number | null; // prefix_cache_hits Δ at admission
	missTokens: number | null; // promptTokens − cacheHits
	approximate: boolean; // true when multiple unadmitted requests shared the observed counter Δ
	firstByteAt: number | null; // ms: first SSE byte back to client
}

interface CntSample {
	ts: number;
	queries: number;
	hits: number;
}

const RING_MS = 15_000; // keep samples for reset detection
const DEFAULT_TPS = 1700; // x99 Qwen3.8-27B measured cold prefill (2026-08-30 profile)
const MAX_AGE_MS = 10 * 60_000; // drop in-flight records older than this (e.g. client vanished)

let metricsUrl: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const requests = new Map<number, LiveReq>();
let nextId = 1;
let calib: number[] = []; // recent per-request measured prefill tok/s
let samples: CntSample[] = [];
let consecutiveFails = 0;
let lastOkAt = 0;

function grab(t: string, name: string): number | null {
	for (const line of t.split("\n")) {
		if (!line.startsWith(name)) continue;
		const c = line.charCodeAt(name.length);
		if (c !== 123 /*{*/ && c !== 32) continue; // must be name{label or name space
		const sp = line.lastIndexOf(" ");
		if (sp <= name.length) continue;
		const v = parseFloat(line.slice(sp + 1));
		return isFinite(v) ? v : null;
	}
	return null;
}

function fetchSample(): Promise<CntSample | null> {
	return new Promise((resolve) => {
		if (!metricsUrl) return resolve(null);
		const ac = new AbortController();
		const to = setTimeout(() => ac.abort(), 2500);
		fetch(metricsUrl, { signal: ac.signal, headers: { accept: "text/plain" } })
			.then(async (res) => {
				clearTimeout(to);
				if (!res.ok) return resolve(null);
				const t = await res.text();
				const queries = grab(t, "vllm:prefix_cache_queries_total");
				const hits = grab(t, "vllm:prefix_cache_hits_total");
				if (queries == null || hits == null) return resolve(null);
				resolve({ ts: Date.now(), queries, hits });
			})
			.catch(() => {
				clearTimeout(to);
				resolve(null);
			});
	});
}

function attribute(ts: number, dq: number, dh: number): void {
	if (dq <= 0) return;
	const cands = [...requests.values()].filter((r) => r.phase === "queued");
	if (!cands.length) return; // admission belongs to a request we didn't forward (direct hits) → ignore
	cands.sort((a, b) => a.t0 - b.t0);
	const r = cands[0]; // most-recently forwarded gets the observed Δ; ambiguous windows flagged approximate
	r.promptTokens = dq;
	r.cacheHits = Math.min(dq, dh);
	r.missTokens = Math.max(0, dq - r.cacheHits);
	r.phase = "prefill";
	r.admittedAt = ts;
	if (cands.length > 1) r.approximate = true;
}

async function tick(): Promise<void> {
	const now = Date.now();
	// backoff: after repeated failures, skip fetching for 30s (metrics endpoint down / LAN hiccup)
	if (consecutiveFails > 5 && now - lastOkAt < 30_000) return;
	const s = await fetchSample();
	if (!s) {
		consecutiveFails++;
		return;
	}
	consecutiveFails = 0;
	lastOkAt = now;
	const prev = samples[samples.length - 1];
	// counter reset (engine restart) → values go down; clear ring so no bogus negative Δ
	if (prev && (s.queries < prev.queries || s.hits < prev.hits)) samples = [];
	samples.push(s);
	const cutoff = now - RING_MS;
	while (samples.length > 1 && samples[0].ts < cutoff) samples.shift();
	const p = samples.length > 1 ? samples[samples.length - 2] : null;
	if (p) attribute(s.ts, Math.max(0, s.queries - p.queries), Math.max(0, s.hits - p.hits));
	// prune stale in-flight records
	for (const r of [...requests.values()]) {
		if (now - r.t0 > MAX_AGE_MS) requests.delete(r.id);
	}
}

function calibrate(r: LiveReq): void {
	if (r.firstByteAt == null || r.admittedAt == null || r.missTokens == null) return;
	if (r.missTokens < 256) return; // too small to be a meaningful rate sample
	const tps = r.missTokens / Math.max(0.05, (r.firstByteAt - r.admittedAt) / 1000);
	if (tps > 100 && tps < 5000) {
		calib.push(tps);
		if (calib.length > 8) calib.shift();
	}
}

/** Register a forwarded request; returns 0 when the upstream is not tracked. */
export function liveRegister(upstream: string, tool: string, promptChars: number): number {
	if (!metricsUrl) return 0;
	const id = nextId++;
	const r: LiveReq = {
		id, tool, upstream,
		t0: Date.now(), promptChars,
		phase: "queued", admittedAt: null,
		promptTokens: null, cacheHits: null, missTokens: null,
		approximate: false, firstByteAt: null,
	};
	requests.set(id, r);
	return id;
}

export function liveFirstByte(id: number): void {
	if (!id) return;
	const r = requests.get(id);
	if (!r || r.firstByteAt != null) return;
	r.firstByteAt = Date.now();
	r.phase = "streaming";
	calibrate(r);
}

export function liveDone(id: number): void {
	if (!id) return;
	requests.delete(id);
}

export function liveView(): { ok: boolean; at: number; calibTps: number; requests: unknown[] } {
	const now = Date.now();
	const calibTps = calib.length
		? Math.round(calib.reduce((a, b) => a + b, 0) / calib.length)
		: DEFAULT_TPS;
	const list = [...requests.values()]
		.map((r) => {
			let estPrefillMs: number | null = null;
			let progress: number | null = null;
			if (r.missTokens != null && r.missTokens > 0 && r.admittedAt != null) {
				estPrefillMs = Math.max(500, Math.round((r.missTokens / calibTps) * 1000));
				progress =
					r.phase === "streaming" ? 1 : Math.min(0.95, (now - r.admittedAt) / estPrefillMs);
			}
			return {
				id: r.id,
				tool: r.tool,
				t0: r.t0,
				ageMs: now - r.t0,
				phase: r.phase,
				promptChars: r.promptChars,
				promptTokens: r.promptTokens,
				cacheHits: r.cacheHits,
				missTokens: r.missTokens,
				estPrefillMs,
				progress,
				approximate: r.approximate,
			};
		})
		.sort((a, b) => b.t0 - a.t0);
	return { ok: true, at: now, calibTps, requests: list };
}

/** Start the 1Hz metrics sampler (idempotent). Only called for upstreams with a metricsUrl. */
export function startLiveTracker(url: string | undefined): void {
	if (!url || timer) return;
	metricsUrl = url;
	timer = setInterval(() => {
		tick().catch(() => {});
	}, 1000);
	timer.unref?.();
	void tick();
}
