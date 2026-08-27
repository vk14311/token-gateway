import type { UsageRecord } from "./types.ts";

/**
 * Normalize heterogeneous vendor usage objects into our canonical shape.
 *
 * OpenAI-compatible family:
 *   prompt_tokens / completion_tokens
 *   prompt_tokens_details.cached_tokens            (DashScope, BigModel, DeepSeek)
 *   completion_tokens_details.reasoning_tokens     (thinking models)
 * Anthropic family (future):
 *   input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
 */
export function normalizeUsage(u: unknown): UsageRecord | null {
	if (!u || typeof u !== "object") return null;
	const o = u as Record<string, any>;
	const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);

	const tokIn = num(o.prompt_tokens ?? o.input_tokens);
	const tokOut = num(o.completion_tokens ?? o.output_tokens);
	if (tokIn === 0 && tokOut === 0 && !o.prompt_tokens_details && !o.input_tokens_details) {
		return null; // not a usable usage object
	}
	const cacheRead = num(
		o.prompt_tokens_details?.cached_tokens ??
			o.input_tokens_details?.cached_tokens ??
			o.cache_read_input_tokens ??
			o.cache_read_tokens,
	);
	const cacheWrite = num(
		o.cache_creation_input_tokens ?? o.prompt_cache_write_tokens ?? o.cache_write_tokens,
	);
	const reasoning = num(
		o.completion_tokens_details?.reasoning_tokens ??
			o.output_tokens_details?.reasoning_tokens ??
			o.reasoning_tokens,
	);
	return { tokIn: tokIn || null, tokOut: tokOut || null, cacheRead, cacheWrite, reasoning, raw: o };
}

/**
 * Extract usage from a complete non-stream JSON body (OpenAI chat.completion shape).
 */
export function usageFromJsonBody(bodyText: string): { usage: UsageRecord | null; model: string | null } {
	try {
		const j = JSON.parse(bodyText) as Record<string, any>;
		return { usage: normalizeUsage(j.usage), model: typeof j.model === "string" ? j.model : null };
	} catch {
		return { usage: null, model: null };
	}
}

export interface SseScanResult {
	usage: UsageRecord | null; // last seen usage frame wins
	model: string | null;
	sawDone: boolean;
	frames: number;
}

/**
 * Incremental SSE scanner for OpenAI-compatible streams.
 * Feed every chunk (string) you receive; it buffers partial frames internally.
 * Vendor nuance: some providers send usage ONLY in a final frame where choices=[];
 * that frame still passes through normalizeUsage's object check.
 */
export class SseScanner {
	private carry = "";
	result: SseScanResult = { usage: null, model: null, sawDone: false, frames: 0 };

	push(chunk: string): void {
		this.carry += chunk;
		let idx: number;
		while ((idx = this.carry.indexOf("\n\n")) >= 0) {
			const frame = this.carry.slice(0, idx);
			this.carry = this.carry.slice(idx + 2);
			this.consume(frame);
		}
	}

	private consume(frameRaw: string): void {
		for (const rawLine of frameRaw.split("\n")) {
			const line = rawLine.trimEnd();
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload) continue;
			if (payload === "[DONE]") {
				this.result.sawDone = true;
				continue;
			}
			try {
				const j = JSON.parse(payload) as Record<string, any>;
				this.result.frames++;
				if (typeof j.model === "string" && !this.result.model) this.result.model = j.model;
				if (j.usage && typeof j.usage === "object") {
					const u = normalizeUsage(j.usage);
					if (u) this.result.usage = u; // last one wins
				}
				if (!this.result.model && Array.isArray(j.choices) && j.choices[0]?.delta?.role) {
					// nothing extra needed; model usually present top-level
				}
			} catch {
				/* non-JSON data line — ignore */
			}
		}
	}

	/** Flush any buffered partial frame at stream end (SSE normally ends with \n\n). */
	end(): SseScanResult {
		if (this.carry.trim()) {
			this.consume(this.carry);
			this.carry = "";
		}
		return this.result;
	}
}
