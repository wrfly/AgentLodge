/**
 * The price table: what a token costs, per model.
 *
 * It used to feed one column of a report and had no screen, which was survivable. It is not
 * now: quota counts what a turn cost, so this table decides when somebody is refused as well
 * as what they are billed. Two rows matter more than the rest — `*`, which prices anything
 * without a row of its own and is also the unit billable tokens are counted in, and a row
 * for any upstream that is not Anthropic, which is otherwise billed at the catch-all's rate.
 */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { admin, fmtMoney, type PricingRow } from '../../lib/api';
import { Banner, Button, Card, Field, Input, Spinner } from '../../components/ui';
import { useT } from '../../lib/i18n';

interface Draft {
  model: string;
  priceInput: string;
  priceCacheRead: string;
  priceCacheWrite: string;
  priceOutput: string;
  note: string;
}

const EMPTY: Draft = { model: '', priceInput: '', priceCacheRead: '', priceCacheWrite: '', priceOutput: '', note: '' };

export function PricingCard() {
  const t = useT();
  const [rows, setRows] = useState<PricingRow[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setRows(await admin.pricing());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const currency = rows?.[0]?.currency ?? '';

  const add = async () => {
    if (!draft.model.trim()) return;
    setBusy(true);
    try {
      const num = (v: string) => Number(v || 0);
      await admin.addPricing({
        model: draft.model.trim(),
        priceInput: num(draft.priceInput),
        priceCacheRead: num(draft.priceCacheRead),
        priceCacheWrite: num(draft.priceCacheWrite),
        priceOutput: num(draft.priceOutput),
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
      description={t('Per million tokens. Quota counts what a turn cost, so these decide refusals as well as the bill.')}
    >
      {error && <Banner tone="error">{error}</Banner>}
      {rows === null ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-faint">
                <th className="pb-2 font-medium">{t('Model')}</th>
                <th className="pb-2 text-right font-medium">{t('In')}</th>
                <th className="pb-2 text-right font-medium">{t('Out')}</th>
                <th className="pb-2 text-right font-medium">{t('Cache read')}</th>
                <th className="pb-2 text-right font-medium">{t('Cache write')}</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="py-2">
                    <span className="font-mono text-[12px]">{r.model}</span>
                    {r.model === '*' && (
                      <span className="ml-2 text-[11px] text-faint">
                        {t('catch-all, and the unit quota is counted in')}
                      </span>
                    )}
                    {r.note && <div className="text-[11px] text-faint">{r.note}</div>}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">{fmtMoney(r.priceInput, r.currency)}</td>
                  <td className="py-2 text-right font-mono tabular-nums">{fmtMoney(r.priceOutput, r.currency)}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-muted">{fmtMoney(r.priceCacheRead, r.currency)}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-muted">{fmtMoney(r.priceCacheWrite, r.currency)}</td>
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
            />
          </Field>
        </div>
        {(
          [
            ['priceInput', t('In')],
            ['priceOutput', t('Out')],
            ['priceCacheRead', t('Cache read')],
            ['priceCacheWrite', t('Cache write')],
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
        {t('A price change is a new row, so past bills keep the price of their time. One currency for the whole table — the amounts are summed.')}
      </p>
    </Card>
  );
}
