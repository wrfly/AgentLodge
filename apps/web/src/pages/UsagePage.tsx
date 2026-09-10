import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { fmtMoney, me, type QuotaScope, type RangePreset, type SeriesPoint, type UsageReport } from '../lib/api';
import { navigate } from '../lib/route';
import {
  Banner,
  Button,
  Card,
  Empty,
  Input,
  Page,
  Spinner,
  Stat,
  fmtDate,
  fmtTokens,
} from '../components/ui';
import { useT } from '../lib/i18n';

const PRESETS: Array<{ id: RangePreset; label: string }> = [
  // First, because it is the window that refuses first
  { id: 'window', label: 'This 5-hour window' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'quota', label: 'This quota month' },
  { id: 'all', label: 'All time' },
];


/** A minimal bar chart — not worth a charting library for one trend line */
function Chart({ data, unit }: { data: SeriesPoint[]; unit: 'day' | 'hour' }) {
  const t = useT();
  if (!data.length) return <Empty text={t('No usage in this period')} />;
  const max = Math.max(...data.map((d) => d.billableTokens), 1);
  const short = (t: string) => (unit === 'hour' ? t.slice(11, 16) : t.slice(5));

  return (
    <div>
      <div className="flex h-32 items-end gap-[3px]">
        {data.map((d) => (
          <div
            key={d.t}
            className={clsx(
              'group relative min-w-[3px] flex-1 rounded-t-sm transition',
              d.billableTokens > 0 ? 'bg-accent/70 hover:bg-accent' : 'bg-line',
            )}
            style={{
              height: `${d.billableTokens ? Math.max((d.billableTokens / max) * 100, 3) : 2}%`,
            }}
          >
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-[11px] whitespace-nowrap shadow-lg group-hover:block">
              <div className="font-medium">{d.t}</div>
              <div className="font-mono text-muted">
                {t('{tokens} tokens · {turns} turns · {calls} calls', {
                  tokens: d.billableTokens.toLocaleString(),
                  turns: d.turns,
                  calls: d.calls,
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-faint">
        <span>{short(data[0]!.t)}</span>
        <span>{short(data.at(-1)!.t)}</span>
      </div>
    </div>
  );
}

/** Longest first, so the card reads from the tightest to the loosest */
const SCOPES = ['window', 'week', 'month'] as const;

function QuotaCard({ quota }: { quota: UsageReport['quota'] }) {
  const t = useT();
  const byCost = quota.limitKind === 'cost';
  const show = (v: number) => (byCost ? fmtMoney(v, quota.currency) : v.toLocaleString());
  const title: Record<QuotaScope, string> = {
    window: t('This 5-hour window'),
    week: t('This week'),
    month: t('This month'),
  };

  /*
   * Every window, not only the ones with a ceiling.
   *
   * It drew the limited ones and nothing else, so somebody with a monthly ceiling and no
   * five-hour one could not see the five hours at all — and the five hours is what the gate
   * refuses on first, and the number they want the moment they are told to wait. The figure
   * was always computed; only the row was missing. With no ceiling there is nothing to draw
   * a bar against, so the row is the count and when it resets.
   */
  const anyLimit = SCOPES.some((s) => quota.windows[s].limit !== null);

  return (
    <Card title={t('Quota')}>
      <div className="space-y-3">
        {SCOPES.map((scope) => {
          const w = quota.windows[scope];
          const pct = Math.round(w.ratio * 100);
          const capped = w.limit !== null;
          return (
            <div key={scope}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[12.5px]">
                  {title[scope]}
                  {/* `limit = ceiling + boost` only when there is a ceiling, so a top-up
                      granted against an uncapped window changes nothing. Drawing it here
                      would advertise an allowance the gate never applies. */}
                  {capped && w.boost > 0 && (
                    <span className="ml-1.5 text-[11px] text-accent">
                      {t('+{amount} topped up', { amount: show(w.boost) })}
                    </span>
                  )}
                </span>
                <span className="font-mono text-[12.5px] tabular-nums">
                  {show(w.used)}
                  <span className="text-faint">
                    {' / '}
                    {capped ? show(w.limit ?? 0) : t('no limit')}
                  </span>
                </span>
              </div>
              {capped && (
                <div className="h-2 overflow-hidden rounded-full bg-bubble">
                  <div
                    className={clsx(
                      'h-full rounded-full transition-all',
                      w.exceeded ? 'bg-danger' : w.ratio >= 0.9 ? 'bg-amber-500' : 'bg-accent',
                    )}
                    /* A sliver so that 1% is visible at all — but nothing spent draws
                       nothing, or a freshly reset window shows a mark for usage it has
                       none of */
                    style={{ width: w.used === 0 ? '0%' : `${Math.max(pct, 1)}%` }}
                  />
                </div>
              )}
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-faint">
                {capped && <span>{pct}%</span>}
                {capped && <span>{t('{amount} left', { amount: show(w.remaining ?? 0) })}</span>}
                <span>{t('resets {when}', { when: fmtDate(w.endsAt) })}</span>
                {/* An administrator cleared this window part-way through, so the count is
                    smaller than what was actually spent over the window. Without this the
                    row just disagrees with the report below it and says nothing about why. */}
                {w.countsFrom !== w.startsAt && (
                  <span className="text-accent">
                    {t('counting from {when}', { when: fmtDate(w.countsFrom) })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!anyLimit && (
        <div className="mt-3 text-[12px] text-muted">
          {t('This account has no ceiling on any window.')}
        </div>
      )}
      {!quota.hardStop && (
        <div className="mt-3 text-[12px] text-amber-600">{t('warn only, not enforced')}</div>
      )}
    </Card>
  );
}

export function UsagePage() {
  const t = useT();
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<RangePreset>('quota');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = async (p: RangePreset = preset, f = from, t = to) => {
    setBusy(true);
    try {
      setData(await me.usage(p, f || undefined, t || undefined));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load('quota');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (p: RangePreset) => {
    setPreset(p);
    void load(p);
  };

  const applyCustom = () => {
    if (!from) return;
    setPreset('custom');
    void load('custom', from, to);
  };

  if (!data && !error) return <Spinner />;

  return (
    <Page
      title={t('Usage')}
      // The formula this used to quote is now only the fallback branch. Quota counts what a
      // turn cost, so the same token count on two models is two different numbers.
      subtitle={t('Billable tokens are what a turn cost, counted in input tokens at the standard rate — so a costlier model draws more of the same quota')}
      actions={
        <Button onClick={() => void load()} loading={busy}>
          <RefreshCw size={13} />
          {t('Refresh')}
        </Button>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      {!data ? null : (
        <>
          <QuotaCard quota={data.quota} />

          <div className="mb-4 grid grid-cols-3 gap-3">
            <Stat
              label={t('Today')}
              value={fmtTokens(data.quick.today.billableTokens)}
              sub={`${fmtMoney(data.quick.today.costMicro, data.quota.currency)} · ${t('{n} turns', { n: data.quick.today.turns })}`}
            />
            <Stat
              label={t('This month')}
              value={fmtTokens(data.quick.month.billableTokens)}
              sub={`${fmtMoney(data.quick.month.costMicro, data.quota.currency)} · ${t('{n} turns', { n: data.quick.month.turns })}`}
            />
            <Stat
              label={t('All time')}
              value={fmtTokens(data.quick.allTime.billableTokens)}
              sub={`${fmtMoney(data.quick.allTime.costMicro, data.quota.currency)} · ${t('{n} turns', { n: data.quick.allTime.turns })}`}
            />
          </div>

          <Card title={t('By period')}>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pick(p.id)}
                  className={clsx(
                    'rounded-lg border px-2.5 py-1 text-[12.5px] transition',
                    preset === p.id
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line text-muted hover:border-line-strong hover:text-ink',
                  )}
                >
                  {t(p.label)}
                </button>
              ))}
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] text-faint">{t('Custom')}</span>
              <div className="w-36">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <span className="text-faint">–</span>
              <div className="w-36">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <Button onClick={applyCustom} disabled={!from} loading={busy && preset === 'custom'}>
                {t('Query')}
              </Button>
            </div>

            <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line pt-3">
              <span className="text-[13px] font-medium">{t(data.range.label)}</span>
              <span className="font-mono text-[17px] font-semibold text-accent tabular-nums">
                {data.totals.billableTokens.toLocaleString()}
              </span>
              <span className="font-mono text-[13px] text-muted">
                {fmtMoney(data.totals.costMicro, data.quota.currency)}
              </span>
              <span className="text-[12px] text-faint">
                {t('{turns} turns · {calls} upstream calls · input {input} · cache {cache} · output', {
                  turns: data.totals.turns,
                  calls: data.totals.calls,
                  input: fmtTokens(data.totals.inputTokens),
                  cache: fmtTokens(data.totals.cacheReadTokens),
                })}{' '}
                {fmtTokens(data.totals.outputTokens)}
              </span>
            </div>

            <Chart data={data.series} unit={data.seriesUnit} />
          </Card>

          <Card title={`${t('By agent and model')} · ${t(data.range.label)}`}>
            {data.byAgent.length === 0 ? (
              <Empty text={t('No usage in this period')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-faint">
                      <th className="pb-2 font-medium">Agent</th>
                      <th className="pb-2 font-medium">{t('Model')}</th>
                      <th className="pb-2 text-right font-medium">{t('Turns')}</th>
                      <th className="pb-2 text-right font-medium">{t('In')}</th>
                      <th className="pb-2 text-right font-medium">{t('Out')}</th>
                      <th className="pb-2 text-right font-medium">{t('Billable tokens')}</th>
                      {/* What each model actually cost. Two models can differ by a factor of
                          ten per token, so a row of token counts on its own says very little
                          about where the money went. */}
                      <th className="pb-2 text-right font-medium">{t('Cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byAgent.map((r, i) => (
                      <tr key={`${r.agent}-${r.model}-${i}`} className="border-b border-line last:border-0">
                        <td className="py-2">{r.agent}</td>
                        <td className="py-2 font-mono text-[12px] text-muted">{r.model || t('(default)')}</td>
                        <td className="py-2 text-right tabular-nums">{r.turns}</td>
                        <td className="py-2 text-right font-mono tabular-nums text-muted">
                          {fmtTokens(r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens)}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums text-muted">
                          {fmtTokens(r.outputTokens)}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums">
                          {r.billableTokens.toLocaleString()}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums">
                          {fmtMoney(r.costMicro, data.quota.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`${t('Heaviest conversations')} · ${t(data.range.label)}`}>
            {data.byConversation.length === 0 ? (
              <Empty text={t('No data in this period')} />
            ) : (
              <div className="space-y-1">
                {data.byConversation.map((c) => (
                  <button
                    key={c.conversationId}
                    onClick={() => navigate(`/${c.agent}`)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-elevated"
                  >
                    <span className="w-12 shrink-0 font-mono text-[11px] text-faint">{c.agent}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{c.title}</span>
                    <span className="shrink-0 font-mono text-[12px] text-muted tabular-nums">
                      {fmtTokens(c.billableTokens)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
