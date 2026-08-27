/**
 * Dashboard + JSON API.
 *   GET  /                 -> public/index.html
 *   GET  /api/stats?days=N -> daily/model/tool aggregates (+ per-platform bill compare)
 *   GET  /api/bills        -> ledger rows
 *   POST /api/bills        -> {platform, day, amountCny, note?}
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, RequestRecord } from "./types.ts";
import { readRange, lastNDays, readBills, appendBill } from "./store.ts";
import { makeProxyHandler } from "./proxy.ts";
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

	return async function handler(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const p = url.pathname;

		if (p === "/" || p === "/index.html") return serve("index.html", "text/html; charset=utf-8");

		if (p === "/api/stats") {
			const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "14", 10) || 14, 1), 90);
			return Response.json(buildStats(readRange(lastNDays(days)), days));
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
