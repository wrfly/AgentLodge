/**
 * Published facts about the models an administrator is likely to configure.
 *
 * Not fetched: no upstream serves them. `/v1/models` returns ids and display names, and
 * nothing about a context window, a price or a benchmark — so the choice is a table like
 * this one or an empty column. A name with no entry simply shows nothing.
 *
 * Sources:
 *   prices, context, max output   platform.claude.com/docs/en/about-claude/pricing
 *                                 platform.claude.com/docs/en/build-with-claude/context-windows
 *                                 read 2026-08-26
 *   deepseek                      api-docs.deepseek.com/quick_start/pricing, read 2026-09-14
 *                                 — the line-up changed on 09-10 and the aggregator sites
 *                                 still carry the old numbers, so only the official page
 *                                 counts here
 *   cursor catalogue              cursor.com/docs/models-and-pricing, read 2026-09-20
 *                                 — Composer, Grok, GPT-5.x, Gemini, and the other lines a
 *                                 Cursor pull adds; Fast is a separate entry, not a multiple
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
  /**
   * List price per million tokens, in `currency`.
   *
   * Each vendor's own published list, not converted: Anthropic publishes dollars and DeepSeek
   * publishes yuan, and a converted figure here would disagree with what the price table
   * charges the moment a rate moved. The two are cross-checked by scripts/check-pricing.mjs —
   * one is what a user is told a model costs and the other is what they are charged.
   */
  inPrice?: number;
  outPrice?: number;
  /** ISO code for the two prices above. Absent means USD. */
  currency?: string;
  /** SWE-bench Verified, as a percentage */
  swe?: number;
  /** Anything the numbers alone would misrepresent */
  note?: string;
}

const M = 1_000_000;
const K = 1_000;

/** Every DeepSeek price is half the week's price; said once so three rows cannot disagree */
const PEAK = 'off-peak; doubles Mon–Fri 01:00–04:00 and 06:00–10:00 UTC';

/*
 * Keyed by the start of the name, so a dated snapshot — claude-opus-4-5-20251101 — finds
 * the entry for the model it is a snapshot of. The longest match wins.
 */
const FACTS: Record<string, ModelFacts> = {
  'claude-fable-5-1': { context: M, maxOutput: 128 * K, inPrice: 10, outPrice: 50 },
  'claude-fable-5': { context: M, maxOutput: 128 * K, inPrice: 10, outPrice: 50, swe: 95.0 },
  'claude-opus-5': { context: M, maxOutput: 128 * K, inPrice: 5, outPrice: 25 },
  'claude-opus-4-8': { context: M, maxOutput: 128 * K, inPrice: 5, outPrice: 25, swe: 88.6 },
  'claude-opus-4-7': { context: M, maxOutput: 128 * K, inPrice: 5, outPrice: 25, swe: 87.6 },
  'claude-opus-4-6': { context: M, maxOutput: 128 * K, inPrice: 5, outPrice: 25, swe: 80.8 },
  'claude-opus-4-5': { context: 200 * K, maxOutput: 64 * K, inPrice: 5, outPrice: 25, swe: 80.9 },
  'claude-sonnet-5': { context: M, maxOutput: 128 * K, inPrice: 2, outPrice: 10, swe: 85.2 },
  'claude-sonnet-4-6': { context: M, maxOutput: 128 * K, inPrice: 3, outPrice: 15, swe: 79.6 },
  'claude-sonnet-4-5': { context: 200 * K, maxOutput: 64 * K, inPrice: 3, outPrice: 15 },
  'claude-sonnet-4': { context: 200 * K, inPrice: 3, outPrice: 15 },
  'claude-haiku-4-5': { context: 200 * K, maxOutput: 64 * K, inPrice: 1, outPrice: 5, swe: 73.3 },
  // The prices below are the off-peak ones, which is exactly what `note` is for: a reader
  // comparing $0.15 against Claude's $3 has to know the number is conditional, and a
  // source comment tells nobody.
  'deepseek-flash': { context: M, maxOutput: 384 * K, inPrice: 1, outPrice: 4, currency: 'CNY', note: PEAK },
  'deepseek-v4-pro': { context: M, maxOutput: 384 * K, inPrice: 4.5, outPrice: 13.5, currency: 'CNY', note: PEAK },
  // Retired 2026-09-10. The name still answers, but what answers is V4.1-Flash — so the
  // price is that model's, and the 78.6 SWE-bench figure this entry used to carry is gone
  // with the model that earned it rather than transplanted onto its replacement.
  'deepseek-v4-flash': {
    context: M,
    maxOutput: 384 * K,
    inPrice: 1,
    outPrice: 4,
    currency: 'CNY',
    note: `retired — served by V4.1-Flash; ${PEAK}`,
  },
  // Cursor's on-demand list. Fast is its own price, not 2× — Composer Fast is 6×,
  // Grok 4.5 Fast output is 3×. Cache figures live in the seed; the picker shows in/out.
  'composer-2.5-fast': { context: 200 * K, inPrice: 3, outPrice: 15 },
  'composer-2.5': { context: 200 * K, inPrice: 0.5, outPrice: 2.5 },
  'composer-1': { context: 200 * K, inPrice: 1.25, outPrice: 10 },
  'cursor-grok-4.6-fast': { context: 256 * K, inPrice: 4, outPrice: 12 },
  'cursor-grok-4.6': { context: 256 * K, inPrice: 2, outPrice: 6 },
  'grok-4.6-fast': { context: 256 * K, inPrice: 4, outPrice: 12 },
  'grok-4.6': { context: 256 * K, inPrice: 2, outPrice: 6 },
  'cursor-grok-4.5-fast': { context: 256 * K, inPrice: 4, outPrice: 18 },
  'cursor-grok-4.5': { context: 256 * K, inPrice: 2, outPrice: 6 },
  'grok-4.5-fast': { context: 256 * K, inPrice: 4, outPrice: 18 },
  'grok-4.5': { context: 256 * K, inPrice: 2, outPrice: 6 },
  'gpt-5-fast': { context: 400 * K, inPrice: 2.5, outPrice: 20 },
  'gpt-5-mini': { context: 400 * K, inPrice: 0.25, outPrice: 2 },
  'gpt-5-codex': { context: 400 * K, inPrice: 1.25, outPrice: 10 },
  'gpt-5': { context: 400 * K, inPrice: 1.25, outPrice: 10 },
  'gpt-5.1-codex-mini': { context: 400 * K, inPrice: 0.25, outPrice: 2 },
  'gpt-5.1-codex-max': { context: 400 * K, inPrice: 1.25, outPrice: 10 },
  'gpt-5.1-codex': { context: 400 * K, inPrice: 1.25, outPrice: 10 },
  'gpt-5.2-codex': { context: 400 * K, inPrice: 1.75, outPrice: 14 },
  'gpt-5.2-fast': { context: 400 * K, inPrice: 3.5, outPrice: 28 },
  'gpt-5.2': { context: 400 * K, inPrice: 1.75, outPrice: 14 },
  'gpt-5.3-codex-fast': { context: 400 * K, inPrice: 3.5, outPrice: 28 },
  'gpt-5.3-codex': { context: 400 * K, inPrice: 1.75, outPrice: 14 },
  'gpt-5.4-mini': { context: M, inPrice: 0.75, outPrice: 4.5 },
  'gpt-5.4-nano': { context: M, inPrice: 0.2, outPrice: 1.25 },
  'gpt-5.4-fast': { context: M, inPrice: 5, outPrice: 30 },
  'gpt-5.4': { context: M, inPrice: 2.5, outPrice: 15 },
  'gpt-5.5-fast': { context: M, inPrice: 10, outPrice: 60 },
  'gpt-5.5': { context: M, inPrice: 5, outPrice: 30 },
  'gpt-5.6-luna-fast': { context: M, inPrice: 0.4, outPrice: 2.4 },
  'gpt-5.6-luna': { context: M, inPrice: 0.2, outPrice: 1.2 },
  'gpt-5.6-sol-fast': { context: M, inPrice: 8, outPrice: 40 },
  'gpt-5.6-sol': { context: M, inPrice: 4, outPrice: 20 },
  'gpt-5.6-terra-fast': { context: M, inPrice: 4, outPrice: 24 },
  'gpt-5.6-terra': { context: M, inPrice: 2, outPrice: 12 },
  'gemini-2.5-flash': { context: M, inPrice: 0.3, outPrice: 2.5 },
  'gemini-3-flash': { context: M, inPrice: 0.5, outPrice: 3 },
  'gemini-3-pro': { context: M, inPrice: 2, outPrice: 12 },
  'gemini-3.1-pro': { context: M, inPrice: 2, outPrice: 12 },
  'gemini-3.5-flash': { context: M, inPrice: 1.5, outPrice: 9 },
  'gemini-3.6-flash': { context: M, inPrice: 1.5, outPrice: 7.5 },
  'gemini-3.7-flash': { context: M, inPrice: 0.75, outPrice: 3.5 },
  'gemini-3.8-flash': { context: M, inPrice: 0.75, outPrice: 3.5 },
  'glm-5.2': { context: 200 * K, inPrice: 1.4, outPrice: 4.4 },
  'kimi-k2.7': { context: 256 * K, inPrice: 0.95, outPrice: 4 },
  'kimi-k3': { context: M, inPrice: 3, outPrice: 15 },
  'muse-spark-1.3': { context: M, inPrice: 1.25, outPrice: 4.25 },
  'codex-5.3': { context: 400 * K, inPrice: 1.75, outPrice: 14 },
};

const KEYS = Object.keys(FACTS).sort((a, b) => b.length - a.length);

/** Same rule as the price table: Fast is a token, not the letters inside another word. */
function hasFastToken(id: string): boolean {
  return /(^|[-.])fast($|[-.])/.test(id);
}

function withoutFast(id: string): string {
  return id.replace(/[-.]fast(?=$|[-.])/g, '');
}

export function factsFor(name: string): ModelFacts | undefined {
  const id = name.trim().toLowerCase();
  /*
   * `cursor-grok-4.6-high-fast` is Grok Fast, not the standard Grok row that happens to
   * be a prefix. Prefer a `-fast` key whose stem is the longest prefix of this stem.
   */
  if (hasFastToken(id)) {
    const stem = withoutFast(id);
    const fastKey = KEYS.find((k) => hasFastToken(k) && stem.startsWith(withoutFast(k)));
    if (fastKey) return FACTS[fastKey];
  }
  const key = KEYS.find((k) => id.startsWith(k));
  return key ? FACTS[key] : undefined;
}

/** $5 and $0.435 both read as themselves, without trailing zeros */
export function price(n: number, currency = 'USD'): string {
  const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  return `${sym}${Number(n.toFixed(3))}`;
}
