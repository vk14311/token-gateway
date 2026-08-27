import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * token-gateway 计量数据 → pi footer 状态行。
 *
 * 数据源：直接读 ~/workspace/token-gateway/data/YYYY-MM-DD.jsonl（NDJSON 明细），
 * 不依赖网关进程存活——网关挂了历史数据照样可见。
 *
 * 显示（独立状态行，不挤余额行）：
 *   🔸TG 今日 5req ↑4.2k ↓33k ¥0.0012      （全天累计，跨会话/工具）
 * 缓存读取量大时附加 c36k。无数据时该行自动隐藏。
 *
 * 刷新：session_start / model_select / 每条消息结束(message_end) + 60s 兜底定时器。
 * 命令：/gw-stats 弹出今日与近7天详细聚合；/gw-refresh 手动刷新。
 */

const STATUS_KEY = "tg-gateway";
const STATUS_PREFIX = "🔸";
const DATA_DIR = process.env.TG_DATA_DIR_OVERRIDE ?? `${homedir()}/workspace/token-gateway/data`;
const REFRESH_MS = 60_000;

interface GatewayRecord {
	status: number;
	usage?: { tokIn?: number | null; tokOut?: number | null; cacheRead?: number; reasoning?: number } | null;
	costCny?: number | null;
	tool?: string;
	upstream?: string;
	model?: string | null;
	error?: string | null;
}

interface Agg {
	reqs: number;
	errs: number;
	tokIn: number;
	tokOut: number;
	cacheRead: number;
	reasoning: number;
	cost: number;
}

function emptyAgg(): Agg {
	return { reqs: 0, errs: 0, tokIn: 0, tokOut: 0, cacheRead: 0, reasoning: 0, cost: 0 };
}

/** 上海时区当天日期（en-CA 即 YYYY-MM-DD）。 */
function todayShanghai(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

export function aggregateDay(day: string): Agg | undefined {
	const file = path.join(DATA_DIR, `${day}.jsonl`);
	if (!fs.existsSync(file)) return undefined;
	const agg = emptyAgg();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let r: GatewayRecord;
		try {
			r = JSON.parse(line) as GatewayRecord;
		} catch {
			continue; // torn tail
		}
		agg.reqs++;
		if (r.status >= 400 || r.status === 0) agg.errs++;
		agg.tokIn += r.usage?.tokIn ?? 0;
		agg.tokOut += r.usage?.tokOut ?? 0;
		agg.cacheRead += r.usage?.cacheRead ?? 0;
		agg.reasoning += r.usage?.reasoning ?? 0;
		agg.cost += r.costCny ?? 0;
	}
	return agg;
}

export function lastNDays(n: number): string[] {
	const out: string[] = [];
	const d = new Date();
	for (let i = n - 1; i >= 0; i--) {
		d.setTime(Date.now() - i * 86400000);
		out.push(d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }));
	}
	return out;
}

function fmtTokens(n: number): string {
	if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
	if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
	return String(Math.round(n));
}

function fmtCost(cny: number): string {
	if (cny <= 0) return "¥0";
	if (cny < 1) return "¥" + cny.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
	return "¥" + cny.toFixed(2);
}

/** footer 一行文案；无任何请求时返回 undefined 以隐藏该行。 */
export function statusLineOf(agg: Agg): string | undefined {
	if (!agg.reqs) return undefined;
	const parts = [`今日 ${agg.reqs}req`];
	parts.push(`↑${fmtTokens(agg.tokIn)}`);
	parts.push(`↓${fmtTokens(agg.tokOut)}`);
	if (agg.cacheRead > 0) parts.push(`c${fmtTokens(agg.cacheRead)}`);
	if (agg.reasoning > 0) parts.push(`R${fmtTokens(agg.reasoning)}`);
	parts.push(fmtCost(agg.cost));
	return parts.join(" ");
}

export default function (pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function publish(text: string | undefined) {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		if (!text) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `${STATUS_PREFIX}TG ${ctx.ui.theme.fg("dim", text)}`);
	}

	async function refresh(): Promise<void> {
		const agg = aggregateDay(todayShanghai());
		publish(statusLineOf(agg));
	}

	function startTimer() {
		stopTimer();
		timer = setInterval(() => void refresh(), REFRESH_MS);
	}
	function stopTimer() {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		if (!ctx.hasUI) return;
		startTimer();
		await refresh();
	});

	pi.on("model_select", async (_event, ctx) => {
		ctxRef = ctx;
		await refresh();
	});

	// 每条消息结束即刷新（计量落盘在网关侧毫秒级完成，通常已可见）。
	pi.on("message_end", async () => {
		await refresh();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* ignore */
		}
	});

	pi.registerCommand("gw-stats", {
		description: "token-gateway 用量统计（今日 + 近7天）",
		handler: async (_args, ctx) => {
			const today = todayShanghai();
			const a = aggregateDay(today);
			const total = emptyAgg();
			const days = lastNDays(7);
			for (const d of days) {
				const x = aggregateDay(d);
				if (!x) continue;
				total.reqs += x.reqs;
				total.errs += x.errs;
				total.tokIn += x.tokIn;
				total.tokOut += x.tokOut;
				total.cacheRead += x.cacheRead;
				total.reasoning += x.reasoning;
				total.cost += x.cost;
			}
			const f = (x: Agg) =>
				x.reqs === 0
					? "无记录"
					: `${x.reqs}req(错${x.errs}) ↑${fmtTokens(x.tokIn)} ↓${fmtTokens(x.tokOut)} ` +
						`缓存${fmtTokens(x.cacheRead)} 推理${fmtTokens(x.reasoning)} ${fmtCost(x.cost)}`;
			ctx.ui.notify(
				[
					`token-gateway · 上海时区`,
					`今日 ${today}：${f(a ?? emptyAgg())}`,
					`近7天合计：${f(total)}`,
					days.length ? `(窗口 ${days[0]} ~ ${days[days.length - 1]})` : "",
					`明细：${DATA_DIR}/YYYY-MM-DD.jsonl`,
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("gw-refresh", {
		description: "刷新 token-gateway 状态行",
		handler: async (_args, ctx) => {
			ctxRef = ctxRef ?? ctx;
			await refresh();
			ctx.ui.notify("已刷新 token-gateway 状态行", "info");
		},
	});
}
