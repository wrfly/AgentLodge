import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { fmtMoney, me, type RangePreset, type SeriesPoint, type UsageReport } from '../lib/api';
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
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'quota', label: 'This quota period' },
  { id: 'all', label: 'All time' },
];

const PERIOD_LABEL: Record<string, string> = {
  rolling: 'rolling window',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  total: 'total',
};

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

function QuotaCard({ quota }: { quota: UsageReport['quota'] }) {
  const t = useT();
  const byCost = quota.limitKind === 'cost';
  const used = byCost ? quota.usedMicro : quota.used;
  const cap = byCost ? quota.costLimitMicro : quota.limit;
  const left = byCost ? quota.remainingMicro : quota.remaining;
  const show = (v: number) => (byCost ? fmtMoney(v, quota.currency) : v.toLocaleString());
  const resetHint =
    quota.resetsInMs === null
      ? t('never resets')
      : quota.resetsInMs < 3600_000
        ? t('resets in {n} minutes', { n: Math.ceil(quota.resetsInMs / 60_000) })
        : quota.resetsInMs < 48 * 3600_000
          ? t('resets in {n} hours', { n: Math.ceil(quota.resetsInMs / 3600_000) })
          : t('resets in {n} days', { n: Math.ceil(quota.resetsInMs / 86400_000) });

  if (quota.expired) {
    return (
      <Card title={t('Quota')}>
        <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2.5 text-[13px] text-danger">
          {t('This quota period has ended — ask an administrator to top it up')}
        </div>
        <div className="mt-2 text-[12px] text-faint">{quota.anchorLabel}</div>
      </Card>
    );
  }

  if (cap === null) {
    return (
      <Card title={t('Quota')}>
        <div className="text-[13px] text-muted">
          {t('This account has no limit. Used this {period}:', {
            period: t(PERIOD_LABEL[quota.period] ?? 'period'),
          })}{' '}
          <span className="font-mono">{quota.used.toLocaleString()}</span> tokens
          <span className="text-faint">({fmtMoney(quota.usedMicro, quota.currency)})</span>
        </div>
        <div className="mt-1.5 text-[12px] text-faint">{quota.anchorLabel}</div>
      </Card>
    );
  }

  const pct = Math.round(quota.ratio * 100);
  return (
    <Card title={t('Quota')}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-mono text-[17px] font-semibold tabular-nums">
          {show(used)}
          <span className="text-[13px] font-normal text-faint">{' / '}{show(cap)}</span>
        </span>
        <span
          className={clsx(
            'text-[13px] font-medium',
            quota.exceeded ? 'text-danger' : quota.warning ? 'text-amber-600' : 'text-muted',
          )}
        >
          {t('{amount} left', { amount: show(left ?? 0) })} · {pct}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bubble">
        <div
          className={clsx(
            'h-full rounded-full transition-all',
            quota.exceeded ? 'bg-danger' : quota.warning ? 'bg-amber-500' : 'bg-accent',
          )}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-faint">
        <span>{quota.anchorLabel} · {resetHint}</span>
        <span>{t('period started {when}', { when: fmtDate(quota.periodStart) })}</span>
        {quota.resetAt && <span className="text-accent">{t('an administrator reset it manually')}</span>}
        {!quota.hardStop && <span className="text-amber-600">{t('warn only, not enforced')}</span>}
      </div>
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
      subtitle={t('Billable tokens = input + cache read×0.1 + cache write + output×1.5 (weights are set by an administrator)')}
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
              sub={`${fmtMoney(data.quick.today.costMicro)} · ${t('{n} turns', { n: data.quick.today.turns })}`}
            />
            <Stat
              label={t('This month')}
              value={fmtTokens(data.quick.month.billableTokens)}
              sub={`${fmtMoney(data.quick.month.costMicro)} · ${t('{n} turns', { n: data.quick.month.turns })}`}
            />
            <Stat
              label={t('All time')}
              value={fmtTokens(data.quick.allTime.billableTokens)}
              sub={`${fmtMoney(data.quick.allTime.costMicro)} · ${t('{n} turns', { n: data.quick.allTime.turns })}`}
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
              <span className="text-[13px] font-medium">{data.range.label}</span>
              <span className="font-mono text-[17px] font-semibold text-accent tabular-nums">
                {data.totals.billableTokens.toLocaleString()}
              </span>
              <span className="font-mono text-[13px] text-muted">
                {fmtMoney(data.totals.costMicro)}
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

          <Card title={`${t('By agent and model')} · ${data.range.label}`}>
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
                      <th className="pb-2 text-right font-medium">{t('Calls')}</th>
                      <th className="pb-2 text-right font-medium">{t('Billable tokens')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byAgent.map((r, i) => (
                      <tr key={`${r.agent}-${r.model}-${i}`} className="border-b border-line last:border-0">
                        <td className="py-2">{r.agent}</td>
                        <td className="py-2 font-mono text-[12px] text-muted">{r.model || t('(default)')}</td>
                        <td className="py-2 text-right tabular-nums">{r.turns}</td>
                        <td className="py-2 text-right tabular-nums text-muted">{r.calls}</td>
                        <td className="py-2 text-right font-mono tabular-nums">
                          {r.billableTokens.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`${t('Heaviest conversations')} · ${data.range.label}`}>
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
