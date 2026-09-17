/**
 * What an account spent, per agent and per model.
 *
 * Lifted out of the usage page so the console can ask it about somebody else. The data was
 * never the missing piece — `byAgentForUser` has grouped by agent *and* model all along and
 * the admin route already returned it — but only the user's own `/usage` page rendered it,
 * so an administrator opening an account saw one total and no way to ask which model it went
 * on. Two models can differ by a factor of ten per token; the total alone does not say where
 * the money went.
 *
 * The caller supplies the Card and its title, because the two callers are asking about
 * different ranges: the usage page about whichever period is selected, the console about the
 * quota month.
 */
import { fmtMoney, type UsageTotals } from '../lib/api';
import { Empty, fmtTokens } from './ui';
import { useT } from '../lib/i18n';

export type AgentModelRow = UsageTotals & { agent: string; model: string | null };

export function AgentModelTable({
  rows,
  totals,
  currency,
}: {
  rows: AgentModelRow[];
  /**
   * Counted over the same range as `rows`, by the server, and deliberately not their sum —
   * see the footer. Passing a client-side sum here would silently overstate turns.
   */
  totals: UsageTotals;
  currency: string;
}) {
  const t = useT();

  if (rows.length === 0) return <Empty text={t('No usage in this period')} />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[460px] text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-faint">
            <th className="pb-2 font-medium">Agent</th>
            <th className="pb-2 font-medium">{t('Model')}</th>
            <th className="pb-2 text-right font-medium">{t('Turns')}</th>
            {/* Three columns, not two. `In` used to carry the cache as well, so it
                read seven times the figure the card above calls input. */}
            <th className="pb-2 text-right font-medium">{t('In')}</th>
            <th className="pb-2 text-right font-medium">{t('Cache')}</th>
            <th className="pb-2 text-right font-medium">{t('Out')}</th>
            <th className="pb-2 text-right font-medium">{t('Billable tokens')}</th>
            {/* What each model actually cost. Two models can differ by a factor of
                ten per token, so a row of token counts on its own says very little
                about where the money went. */}
            <th className="pb-2 text-right font-medium">{t('Cost')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.agent}-${r.model}-${i}`} className="border-b border-line last:border-0">
              <td className="py-2">{r.agent}</td>
              <td className="py-2 font-mono text-[12px] text-muted">{r.model || t('(default)')}</td>
              <td className="py-2 text-right tabular-nums">{r.turns}</td>
              <td className="py-2 text-right font-mono tabular-nums text-muted">
                {fmtTokens(r.inputTokens)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums text-muted">
                {fmtTokens(r.cacheReadTokens + r.cacheCreationTokens)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums text-muted">
                {fmtTokens(r.outputTokens)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums">
                {r.billableTokens.toLocaleString()}
              </td>
              <td className="py-2 text-right font-mono tabular-nums">
                {fmtMoney(r.costMicro, currency)}
              </td>
            </tr>
          ))}
        </tbody>
        {/*
          The same totals the card above shows, so the two can be read against each
          other without adding up a column by hand — which is where the question
          "why do these disagree" starts.

          Turns is the one figure that is not the column's sum, and cannot be: a
          turn that called two models is one turn and belongs to both rows. So it is
          counted once here and once in each row it touched, and the two only agree
          when every turn stayed on one model.
        */}
        <tfoot>
          <tr className="border-t border-line-strong font-medium">
            <td className="py-2" colSpan={2}>{t('Total')}</td>
            <td className="py-2 text-right tabular-nums">{totals.turns}</td>
            <td className="py-2 text-right font-mono tabular-nums text-muted">
              {fmtTokens(totals.inputTokens)}
            </td>
            <td className="py-2 text-right font-mono tabular-nums text-muted">
              {fmtTokens(totals.cacheReadTokens + totals.cacheCreationTokens)}
            </td>
            <td className="py-2 text-right font-mono tabular-nums text-muted">
              {fmtTokens(totals.outputTokens)}
            </td>
            <td className="py-2 text-right font-mono tabular-nums">
              {totals.billableTokens.toLocaleString()}
            </td>
            <td className="py-2 text-right font-mono tabular-nums">
              {fmtMoney(totals.costMicro, currency)}
            </td>
          </tr>
        </tfoot>
      </table>
      {/*
        Said out loud, not in a `title`. Every other figure in the totals row is the
        column's sum and this one is not, which is exactly the "these two numbers
        disagree" reading this card exists to stop — and a tooltip inside a table
        that scrolls sideways on a phone is not an answer anybody will find.
      */}
      {rows.reduce((n, r) => n + r.turns, 0) !== totals.turns && (
        <p className="mt-2 text-[11.5px] text-faint">
          {t('The turns column adds up to more than the total: a turn that called two models is one turn, counted under each of them.')}
        </p>
      )}
    </div>
  );
}
