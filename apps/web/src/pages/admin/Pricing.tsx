/**
 * The price table: what a token costs, per model.
 *
 * It used to feed one column of a report and had no screen, which was survivable. It is not
 * now: quota counts what a turn cost, so this table decides when somebody is refused as well
 * as what they are billed. Two rows matter more than the rest — `*`, which prices anything
 * without a row of its own and is also the unit billable tokens are counted in, and a row
 * for any upstream that is not Anthropic, which is otherwise billed at the catch-all's rate.
 */
import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { admin, fmtMoney, type Model, type PricingRow } from '../../lib/api';
import { Banner, Button, Card, Field, Input, Spinner, fmtDate } from '../../components/ui';
import { useT } from '../../lib/i18n';

interface Draft {
  model: string;
  priceInput: string;
  priceCacheRead: string;
  priceCacheWrite: string;
  priceOutput: string;
  priceWebSearch: string;
  note: string;
}

const EMPTY: Draft = {
  model: '',
  priceInput: '',
  priceCacheRead: '',
  priceCacheWrite: '',
  priceOutput: '',
  priceWebSearch: '',
  note: '',
};

/**
 * A row backdated to the epoch has always applied, and says so without a date.
 *
 * The seed and every backfill stamp `effective_from` at 1970 on purpose: `resolve()` filters
 * on `effective_from <= at`, so a row added today would be invisible to every bill already
 * written and a recost would find nothing to correct. That is a mechanism, not a fact about
 * the price, and printing it put "since 1970/01/01 07:30" under most of the table.
 *
 * A year rather than the exact instant, so a backfill stamped a few hours either side of the
 * epoch — whatever the writer's timezone was — still reads as "always".
 */
function alwaysApplied(effectiveFrom: string): boolean {
  return new Date(effectiveFrom).getUTCFullYear() <= 1970;
}

export function PricingCard() {
  const t = useT();
  const [rows, setRows] = useState<PricingRow[] | null>(null);
  /*
   * The platform's currency, not the first row's.
   *
   * These labels tell somebody which money the boxes below them are in, and reading it off
   * `rows[0]` made that a guess: the column is per row, so a table holding both says whatever
   * the oldest row happens to say — and a new row would then be entered in the wrong one.
   */
  const [currency, setCurrency] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = await admin.pricing();
      setRows(d.rows);
      setCurrency(d.currency);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void load();
    // Suggestions only, so a failure here costs the dropdown and not the card
    admin.models().then((d) => setModels(d.models)).catch(() => {});
  }, []);

  const add = async () => {
    if (!draft.model.trim()) return;

    /*
     * A price the browser cannot read is refused here, not rounded to zero.
     *
     * `Number(v || 0)` gave NaN for `0,15`, JSON.stringify turned that into null, and the
     * server read null as 0 — so typing a decimal the way five of the nine shipped locales
     * write it priced the model at nothing, with a 200 and a new row to show for it. The
     * pattern is deliberately strict: no comma, no sign, no exponent, because every one of
     * those is a plausible typo with a silent reading.
     */
    const parse = (v: string): number | null => {
      const s = v.trim();
      if (!s) return 0;
      return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
    };
    const prices = {
      priceInput: parse(draft.priceInput),
      priceCacheRead: parse(draft.priceCacheRead),
      priceCacheWrite: parse(draft.priceCacheWrite),
      priceOutput: parse(draft.priceOutput),
      priceWebSearch: parse(draft.priceWebSearch),
    };
    if (Object.values(prices).some((v) => v === null)) {
      setError(t('A price is a number written with a dot — 0.15, not 0,15'));
      return;
    }

    setBusy(true);
    try {
      await admin.addPricing({
        model: draft.model.trim(),
        priceInput: prices.priceInput!,
        priceCacheRead: prices.priceCacheRead!,
        priceCacheWrite: prices.priceCacheWrite!,
        priceOutput: prices.priceOutput!,
        priceWebSearch: prices.priceWebSearch!,
        note: draft.note.trim() || undefined,
      });
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The id of the row actually in use, for each (model, upstream).
   *
   * The same rule the server resolves by: the newest row that has already taken effect. The
   * list arrives ordered by effective_from descending, so within a group that is the first
   * one not dated in the future.
   */
  const live = useMemo(() => {
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const ids = new Set<number>();
    for (const r of rows ?? []) {
      // `\u0000` as an escape, not the byte itself: a model name cannot contain it, but a
      // raw NUL makes this file binary, and every grep over it silently finds nothing.
      const key = `${r.model}\u0000${r.providerId}`;
      if (seen.has(key) || r.effectiveFrom > now) continue;
      seen.add(key);
      ids.add(r.id);
    }
    return ids;
  }, [rows]);

  /**
   * Model names to offer, with the ones already priced taken out.
   *
   * A `datalist` rather than a `select`, because the field takes more than a configured
   * model: `*` is the catch-all, a bare `deepseek` is a prefix that catches a whole family,
   * and an upstream can serve a name nobody has added to the model list yet. A select would
   * make those unreachable; this offers the names somebody would otherwise be retyping from
   * the Models card, and still lets anything be typed.
   *
   * Already-priced models come out because adding a second row for one is a *repricing* —
   * a real thing to do, but not what this list is for, and leaving them in buried the
   * handful of models that actually need a price.
   */
  const suggestions = useMemo(() => {
    const priced = new Set((rows ?? []).filter((r) => live.has(r.id)).map((r) => r.model));
    const names = new Set(models.map((m) => m.name).filter((n) => n && !priced.has(n)));
    return [...names].sort();
  }, [models, rows, live]);

  const del = async (row: PricingRow) => {
    setBusy(true);
    try {
      await admin.removePricing(row.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t('Price table')}
      description={`${t('Per million tokens. Quota counts what a turn cost, so these decide refusals as well as the bill.')} ${t('Web search / 1K')}.`}
    >
      {error && <Banner tone="error">{error}</Banner>}
      {/* No mixed-currency warning any more. Two currencies in this table used to make every
          total a number with no meaning, because consumers summed cost_micro across them.
          They are converted at one rate now, on the way to the screen — a table holding both
          is the ordinary case, not a fault. */}
      {rows === null ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-faint">
                <th className="pb-2 font-medium">{t('Model')}</th>
                <th className="pb-2 pl-4 text-right font-medium">{t('In')}</th>
                <th className="pb-2 pl-4 text-right font-medium">{t('Out')}</th>
                <th className="pb-2 pl-4 text-right font-medium">{t('Cache read')}</th>
                <th className="pb-2 pl-4 text-right font-medium">{t('Cache write')}</th>
                <th className="pb-2 pl-4 text-right font-medium">{t('Web search / 1K')}</th>
                <th className="pb-2 pl-4 font-medium">{t('Time of day')}</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="py-2">
                    <span className={clsx('font-mono text-[12px]', !live.has(r.id) && 'text-faint line-through')}>
                      {r.model}
                    </span>
                    {r.model === '*' && (
                      <span className="ml-2 text-[11px] text-faint">
                        {t('catch-all')}
                      </span>
                    )}
                    {/*
                        Which of these rows is actually being charged. A price change appends,
                        so a model that has been repriced twice shows three rows that look
                        alike — and the one an operator is most likely to tidy away is the
                        live one.

                        A backfilled row carries no date. Its `effective_from` is the epoch,
                        stamped so that recosting history can reach it, and printing that gave
                        every seeded row the line "in use since 1970/01/01 07:30" — a number
                        with no meaning, in local time, so not even a recognisable epoch. What
                        it means is "always", and a row that has always applied needs no date
                        at all.

                        The note hangs in the title rather than inline. Half of them are
                        archaeology ("this model had no row, so its usage was costed at the
                        catch-all") and all of them are untranslated vendor prose, so a table
                        of eighteen rows read as eighteen lines of English footnote under a
                        Chinese interface.
                    */}
                    <div className="text-[11px] text-faint" title={r.note || undefined}>
                      {live.has(r.id)
                        ? alwaysApplied(r.effectiveFrom)
                          ? t('in use')
                          : t('in use since {when}', { when: fmtDate(r.effectiveFrom) })
                        : t('superseded, kept for past bills')}
                      {r.note ? ' ·' : ''}
                    </div>
                  </td>
                  <td className="py-2 pl-4 text-right font-mono tabular-nums">{fmtMoney(r.priceInput, r.currency)}</td>
                  <td className="py-2 pl-4 text-right font-mono tabular-nums">{fmtMoney(r.priceOutput, r.currency)}</td>
                  <td className="py-2 pl-4 text-right font-mono tabular-nums text-muted">{fmtMoney(r.priceCacheRead, r.currency)}</td>
                  <td className="py-2 pl-4 text-right font-mono tabular-nums text-muted">{fmtMoney(r.priceCacheWrite, r.currency)}</td>
                  <td className="py-2 pl-4 text-right font-mono tabular-nums text-muted">{fmtMoney(r.priceWebSearch, r.currency)}</td>
                  <td className="w-[200px] py-2 pl-4 align-top">
                    {r.peakMultiplier === 1 ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <div className="text-[11.5px]">
                        {/* The amounts on the left are the base ones; this is what they are
                            multiplied by inside the window, so both numbers are visible at
                            once rather than one standing for the other. */}
                        <span className="font-mono">×{r.peakMultiplier}</span>{' '}
                        <span className="text-faint">{r.peakLabel}</span>
                        {/* Its own line: inline, the badge pushed the schedule past the last
                            column and both got clipped. */}
                        {r.peakNow && (
                          <div className="mt-1">
                            <span className="rounded bg-amber-500/12 px-1.5 py-0.5 text-[10.5px] whitespace-nowrap text-amber-600 dark:text-amber-500">
                              {t('in effect now')}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <Button variant="ghost" onClick={() => void del(r)} disabled={busy} title={t('Delete')}>
                      <Trash2 size={13} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* A price change is a new row, never an edit: past bills keep the price of their time */}
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 md:grid-cols-6">
        <div className="col-span-2">
          <Field label={t('Model')}>
            <Input
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="claude-fable-5-1"
              list="pricing-model-names"
            />
            {/* Native, so it suggests without taking away: `*`, a bare `deepseek` prefix and
                a name the Models card has not got yet all still type straight in. */}
            <datalist id="pricing-model-names">
              {suggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
        </div>
        {(
          [
            ['priceInput', t('In')],
            ['priceOutput', t('Out')],
            ['priceCacheRead', t('Cache read')],
            ['priceCacheWrite', t('Cache write')],
            ['priceWebSearch', t('Web search / 1K')],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={`${label}${currency ? ` (${currency})` : ''}`}>
            <Input
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              inputMode="decimal"
              placeholder="0"
            />
          </Field>
        ))}
        <div className="col-span-2 md:col-span-4">
          <Field label={t('Note')}>
            <Input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2 flex items-end">
          <Button onClick={() => void add()} disabled={busy || !draft.model.trim()}>
            {t('Add a price')}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-[11.5px] text-faint">
        {t('A price change is a new row, so past bills keep the price of their time. Each vendor is priced in its own currency; reports convert at the rate under Settings → Quota.')}
      </p>
    </Card>
  );
}
