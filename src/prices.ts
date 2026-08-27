import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PriceRow } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICES_FILE =
	process.env.TG_PRICES_FILE ?? path.join(__dirname, "..", "prices.json");

interface PricesFile {
	updated?: string;
	rows: PriceRow[];
}

let cache: { mtime: number; data: PricesFile } | null = null;

export function loadPrices(): PricesFile {
	const st = fs.statSync(PRICES_FILE);
	if (cache && cache.mtime === st.mtimeMs) return cache.data;
	const data = JSON.parse(fs.readFileSync(PRICES_FILE, "utf8")) as PricesFile;
	cache = { mtime: st.mtimeMs, data };
	return data;
}

/** Exact match first, then longest wildcard prefix ("glm-*" beats "*"). */
export function matchPrice(provider: string, model: string | null): PriceRow | undefined {
	let rows: PriceRow[];
	try {
		rows = loadPrices().rows.filter((r) => r.provider === provider);
	} catch {
		return undefined;
	}
	if (!model) return rows.find((r) => r.model === "*");
	const exact = rows.find((r) => r.model === model);
	if (exact) return exact;
	const wildcards = rows
		.filter((r) => r.model.endsWith("*") && model.startsWith(r.model.slice(0, -1)))
		.sort((a, b) => b.model.length - a.model.length); // longest prefix wins
	return wildcards[0] ?? rows.find((r) => r.model === "*");
}

export function computeCost(
	provider: string,
	model: string | null,
	u: { tokIn: number | null; tokOut: number | null; cacheRead: number; cacheWrite: number },
): { cost: number | null; unverified: boolean } {
	const row = matchPrice(provider, model);
	if (!row) return { cost: null, unverified: false };
	const tin = u.tokIn ?? 0;
	const tout = u.tokOut ?? 0;
	const cost =
		(tin / 1e6) * row.in +
		(tout / 1e6) * row.out +
		(u.cacheRead / 1e6) * row.cacheRead +
		(u.cacheWrite / 1e6) * row.cacheWrite;
	return { cost: Math.round(cost * 1e8) / 1e8, unverified: !!row.unverified };
}
