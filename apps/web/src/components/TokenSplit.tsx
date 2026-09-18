/**
 * What a token figure is made of: input, cache, output.
 *
 * One number says how much was used and nothing about the shape of it, and the shape is
 * usually the whole explanation for a period that looks wrong — a cache read weighs a tenth
 * of ordinary input and costs about that too, while an output token weighs half again as much
 * and costs several times more. Two periods with the same total can be an order of magnitude
 * apart in money.
 *
 * **Not a decomposition of the billable figure.** Billable is those counts *weighted*, so
 * these three do not add up to it and are not offered as if they did — they are the raw counts
 * the weighting is applied to. The cards keep them beside the billable number rather than
 * under it for that reason.
 *
 * Cache is one figure with both halves in its tooltip. They differ tenfold in weight and about
 * twelvefold in price, so the split matters — but every other surface in the app has shown one
 * merged cache figure since the beginning, and a table that split it here alone would make the
 * same period read two ways depending on which page you opened.
 */
import { fmtTokens } from './ui';
import { useT } from '../lib/i18n';

export interface TokenCounts {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/** Both halves of the cache, as every surface has counted it */
export const cacheTokens = (c: TokenCounts): number => c.cacheReadTokens + c.cacheCreationTokens;

/** Read and written, which weigh and cost about tenfold apart — the tooltip everywhere */
export function useCacheTitle(): (counts: TokenCounts) => string {
  const t = useT();
  return (c) =>
    `${t('Cache read')} ${fmtTokens(c.cacheReadTokens)} · ${t('Cache written')} ${fmtTokens(c.cacheCreationTokens)}`;
}

/**
 * The compact form, for a headline that already has a total beside it.
 *
 * Glyphs with the words in the tooltip: the row they sit in is a figure, a currency and a turn
 * count, and three more labelled numbers would be a sentence. The tooltip is where the labels
 * go, because a glyph alone leaves a reader guessing — `⛁` in particular is a draughts piece
 * that not every monospace face has.
 */
export function TokenSplit({ totals }: { totals: TokenCounts }) {
  const t = useT();
  const cacheTitle = useCacheTitle();
  return (
    <span
      className="font-mono text-[12px] text-faint tabular-nums"
      title={
        `${t('In')} ${fmtTokens(totals.inputTokens)} · ${cacheTitle(totals)} · ` +
        `${t('Out')} ${fmtTokens(totals.outputTokens)}`
      }
    >
      {`↑${fmtTokens(totals.inputTokens)} ⛁${fmtTokens(cacheTokens(totals))} ↓${fmtTokens(totals.outputTokens)}`}
    </span>
  );
}

/** The same three as table cells, for a row that has headers to name them */
export function TokenCells({ totals, className = '' }: { totals: TokenCounts; className?: string }) {
  const cacheTitle = useCacheTitle();
  const cell = `py-1.5 text-right font-mono tabular-nums text-muted ${className}`;
  return (
    <>
      <td className={cell}>{fmtTokens(totals.inputTokens)}</td>
      <td className={cell} title={cacheTitle(totals)}>{fmtTokens(cacheTokens(totals))}</td>
      <td className={cell}>{fmtTokens(totals.outputTokens)}</td>
    </>
  );
}

/** The three headers that name them, so a table and its cells cannot drift apart */
export function TokenHeaders() {
  const t = useT();
  return (
    <>
      <th className="pb-1.5 text-right font-medium">{t('In')}</th>
      <th className="pb-1.5 text-right font-medium">{t('Cache')}</th>
      <th className="pb-1.5 text-right font-medium">{t('Out')}</th>
    </>
  );
}
