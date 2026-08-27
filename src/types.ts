/** Shared types. Zero-dependency, node 22+ strip-types friendly. */

export interface UpstreamDef {
	target: string; // e.g. https://open.bigmodel.cn/api/paas/v4
	label?: string;
	/** Optional fixed key from gateway .env; when absent the client's Authorization is forwarded verbatim. */
	key?: string;
}

export interface AppConfig {
	listenHost: string;
	port: number;
	upstreams: Record<string, UpstreamDef>;
}

export interface UsageRecord {
	tokIn: number | null;
	tokOut: number | null;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	raw?: Record<string, unknown>;
}

export interface RequestRecord {
	ts: number; // epoch ms
	day: string; // Asia/Shanghai YYYY-MM-DD
	tool: string; // path segment: pi / cc / codex ...
	upstream: string; // bigmodel / dashscope / deepseek
	model: string | null; // model name resolved from request body (or usage frame)
	method: string;
	path: string; // original rest path (after /{tool}/{upstream})
	status: number;
	latencyMs: number;
	usage: UsageRecord | null;
	costCny: number | null;
	error?: string; // non-2xx snippet or upstream failure note
	injectedUsageOpt?: boolean; // we added stream_options.include_usage to the outbound body
}

export interface PriceRow {
	provider: string;
	model: string; // exact id or prefix with trailing '*'
	in: number;
	out: number;
	cacheRead: number;
	cacheWrite: number;
	unverified?: boolean;
}

export function nowDay(d = new Date()): string {
	// Asia/Shanghai local date, no TZ deps.
	return d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}
