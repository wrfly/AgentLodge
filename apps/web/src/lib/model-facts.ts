/**
 * Published facts about the models an administrator is likely to configure.
 *
 * Not fetched: no upstream serves them. `/v1/models` returns ids and display names, and
 * nothing about a context window, a price or a benchmark — so the choice is a table like
 * this one or an empty column. A name with no entry simply shows nothing.
 *
 * Sources, read 2026-08-26:
 *   prices, context, max output   platform.claude.com/docs/en/about-claude/pricing
 *                                 platform.claude.com/docs/en/build-with-claude/context-windows
 *   deepseek                      api-docs.deepseek.com pricing, V4 preview announcement
 *   swe                           llm-stats.com/benchmarks/swe-bench-verified, updated 2026-08-25
 *
 * The prices are list prices for the vendor's own endpoint, per million tokens, and are
 * what the vendor charges — not what this deployment bills, which is the price table.
 */

export interface ModelFacts {
  /** Context window in tokens */
  context: number;
  /** Largest `max_tokens` a single request can ask for */
  maxOutput?: number;
  /** List price per million tokens */
  inPrice?: number;
  outPrice?: number;
  /** SWE-bench Verified, as a percentage */
  swe?: number;
  /** Anything the numbers alone would misrepresent */
  note?: string;
}

const M = 1_000_000;
const K = 1_000;

/*
 * Keyed by the start of the name, so a dated snapshot — claude-opus-4-5-20251101 — finds
 * the entry for the model it is a snapshot of. The longest match wins.
 */
const FACTS: Record<string, ModelFacts> = {
  'claude-fable-5': { context: M, maxOutput: 128 * K, inPrice: 10, outPrice: 50, swe: 95.0 },
  'claude-opus-5': { context: M, maxOutput: 128 * K, inPrice: 5, outPrice: 25 },
  'claude-opus-4-8': { context: M, maxOutput: 128 * K, inPrice: 5, outPrice: 25, swe: 88.6 },
  'claude-opus-4-7': { context: M, maxOutput: 128 * K, inPrice: 5, outPrice: 25, swe: 87.6 },
  'claude-opus-4-6': { context: M, maxOutput: 128 * K, inPrice: 5, outPrice: 25, swe: 80.8 },
  'claude-opus-4-5': { context: 200 * K, maxOutput: 64 * K, inPrice: 5, outPrice: 25, swe: 80.9 },
  'claude-sonnet-5': { context: M, maxOutput: 128 * K, inPrice: 2, outPrice: 10, swe: 85.2 },
  'claude-sonnet-4-6': { context: M, maxOutput: 128 * K, inPrice: 3, outPrice: 15, swe: 79.6 },
  'claude-sonnet-4-5': { context: 200 * K, maxOutput: 64 * K, inPrice: 3, outPrice: 15 },
  'claude-haiku-4-5': { context: 200 * K, maxOutput: 64 * K, inPrice: 1, outPrice: 5, swe: 73.3 },
  'deepseek-v4-pro': { context: M, maxOutput: 384 * K, inPrice: 0.435, outPrice: 0.87 },
  // Off-peak. DeepSeek doubles both between 01:00–04:00 and 06:00–10:00 UTC.
  'deepseek-v4-flash': { context: M, maxOutput: 384 * K, inPrice: 0.22, outPrice: 0.66, swe: 78.6 },
};

const KEYS = Object.keys(FACTS).sort((a, b) => b.length - a.length);

export function factsFor(name: string): ModelFacts | undefined {
  const id = name.trim().toLowerCase();
  const key = KEYS.find((k) => id.startsWith(k));
  return key ? FACTS[key] : undefined;
}

/** 1000000 → 1M, 200000 → 200K */
export function tokens(n: number): string {
  if (n >= M) return `${Number((n / M).toFixed(1))}M`;
  if (n >= K) return `${Number((n / K).toFixed(0))}K`;
  return String(n);
}

/** $5 and $0.435 both read as themselves, without trailing zeros */
export function price(n: number): string {
  return `$${Number(n.toFixed(3))}`;
}
