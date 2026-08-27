/**
 * Append-only NDJSON store: data/YYYY-MM-DD.jsonl, one RequestRecord per line.
 * Aggregation reads files on demand (personal-scale volume: trivially fast).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestRecord } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");
/** Resolve lazily so tests can point TG_DATA_DIR before first use. */
export function dataDir(): string {
	return process.env.TG_DATA_DIR ?? DEFAULT_DATA_DIR;
}
const BILLS_FILE_FN = () => path.join(dataDir(), "bills.jsonl");

function dayFile(day: string): string {
	return path.join(dataDir(), `${day}.jsonl`);
}

export function append(rec: RequestRecord): void {
	fs.mkdirSync(dataDir(), { recursive: true });
	fs.appendFileSync(dayFile(rec.day), JSON.stringify(rec) + "\n");
}

export function readDay(day: string): RequestRecord[] {
	const f = dayFile(day);
	if (!fs.existsSync(f)) return [];
	const out: RequestRecord[] = [];
	for (const line of fs.readFileSync(f, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as RequestRecord);
		} catch {
			// torn tail write on crash — ignore last partial line
		}
	}
	return out;
}

export function readRange(days: string[]): RequestRecord[] {
	const out: RequestRecord[] = [];
	for (const d of days) out.push(...readDay(d));
	return out;
}

/** Inclusive list of local dates ending today, oldest first. */
export function lastNDays(n: number): string[] {
	const out: string[] = [];
	const d = new Date();
	for (let i = n - 1; i >= 0; i--) {
		d.setTime(Date.now() - i * 86400000);
		out.push(
			d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
		);
	}
	return out;
}

// ── bills ledger (P3 anchor) ──────────────────────────────────────────────
export interface BillRow {
	platform: string;
	day: string;
	amountCny: number;
	source: string; // manual | api:<name>
	note?: string;
}

export function appendBill(row: BillRow): void {
	fs.mkdirSync(dataDir(), { recursive: true });
	fs.appendFileSync(BILLS_FILE_FN(), JSON.stringify(row) + "\n");
}

export function readBills(): BillRow[] {
	const f = BILLS_FILE_FN();
	if (!fs.existsSync(f)) return [];
	const rows: BillRow[] = [];
	for (const line of fs.readFileSync(f, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as BillRow);
		} catch {
			/* ignore torn tail */
		}
	}
	return rows;
}
