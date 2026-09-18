/**
 * Money on a report: one figure, in the settlement currency, with what was charged behind it.
 *
 * Every vendor bills in its own money — Anthropic in dollars, DeepSeek in yuan — and the
 * database keeps each turn in the currency it was charged in, because a converted price
 * cannot be checked against an invoice. Reports used to print that straight through:
 * "¥890.12 + $1,100.00". Honest, and unusable. Nobody can tell at a glance whether that is
 * more than last month, and every column that held one was two columns wide in practice.
 *
 * So a report shows the settled figure, and the amounts it came from are a hover away. Both
 * come out of `money()` in one call, which is what stops a screen from showing the converted
 * number with no way to see behind it.
 *
 * There is no tooltip when there is nothing to explain — spend in one currency, and that
 * currency is the one on screen. A tooltip repeating the number under the cursor is noise.
 */
import clsx from 'clsx';
import { money, type Money as MoneyMap } from '../lib/api';

interface Spent {
  cost: MoneyMap;
  costSettled: number;
}

/** Inline, for a headline figure beside a token split */
export function Money({
  totals,
  currency,
  className,
}: {
  totals: Spent;
  currency: string;
  className?: string;
}) {
  const { text, title } = money(totals, currency);
  return (
    <span title={title} className={clsx('font-mono tabular-nums', className)}>
      {text}
    </span>
  );
}

/**
 * The same thing as a table cell.
 *
 * A `<td>` of its own rather than a `Money` wrapped in one, because the title has to sit on
 * the cell: a hover that only works over the glyphs themselves is a hover nobody finds.
 *
 * It carries no opinion about emphasis. It used to hardcode `text-muted`, which quietly
 * de-emphasised four columns that were deliberately not muted — including a table's totals
 * row, which then read at the same weight as the token counts above it. `clsx` does not
 * resolve Tailwind conflicts, so a caller could not have overridden it either.
 */
export function MoneyCell({
  totals,
  currency,
  className,
}: {
  totals: Spent;
  currency: string;
  className?: string;
}) {
  const { text, title } = money(totals, currency);
  return (
    <td title={title} className={clsx('text-right font-mono tabular-nums', className)}>
      {text}
    </td>
  );
}

/** `<Stat {...statMoney(totals, currency)} />` — the same pair, spread as that component's props */
export function statMoney(totals: Spent, currency: string): { value: string; title?: string } {
  const { text, title } = money(totals, currency);
  return { value: text, title };
}
