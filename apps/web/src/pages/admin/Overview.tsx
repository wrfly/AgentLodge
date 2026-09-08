/**
 * The overview tab: totals, top users, and the shared plan's own allowance.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { admin, type AdminOverview, type UpstreamAllowanceView } from '../../lib/api';
import {
  Banner,
  Button,
  Card,
  Empty,
  Spinner,
  Stat,
  fillDays,
  fmtDate,
  fmtTokens
} from '../../components/ui';
import { useT } from '../../lib/i18n';

/* ---------------- Overview ---------------- */

export function Overview() {
  const t = useT();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void admin
      .overview()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner />;

  const series = fillDays(data.usage.daily, 30);
  const max = Math.max(...series.map((d) => d.billableTokens), 1);

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('Users')} value={String(data.users.total)} sub={t('{n} active', { n: data.users.active })} />
        <Stat
          label={t('Billed this month')}
          value={fmtTokens(data.usage.month.billableTokens)}
          sub={t('{n} turns', { n: data.usage.month.turns })}
          tone="accent"
        />
        <Stat label={t('Billed all time')} value={fmtTokens(data.usage.allTime.billableTokens)} />
        <Stat
          label={t('Upstream balance')}
          value={
            data.balance?.balances[0]
              ? `${data.balance.balances[0].totalBalance} ${data.balance.balances[0].currency}`
              : '—'
          }
          sub={data.balance ? undefined : t('No API key configured')}
        />
      </div>

      <UpstreamAllowanceCard />

      <Card title={t('Last 30 days, all users')}>
        {data.usage.daily.length === 0 ? (
          <Empty text={t('No usage yet')} />
        ) : (
          <div className="flex h-28 items-end gap-[3px]">
            {series.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${d.billableTokens.toLocaleString()}`}
                className={clsx(
                  'flex-1 rounded-t-sm',
                  d.billableTokens > 0 ? 'bg-accent/70 hover:bg-accent' : 'bg-line',
                )}
                style={{ height: `${d.billableTokens ? Math.max((d.billableTokens / max) * 100, 3) : 2}%` }}
              />
            ))}
          </div>
        )}
      </Card>

      <Card title={t('Top consumers this month')}>
        {data.usage.topUsers.length === 0 ? (
          <Empty text={t('No data yet')} />
        ) : (
          <div className="space-y-1">
            {data.usage.topUsers.map((u, i) => (
              <div key={u.userId} className="flex items-center gap-3 px-1 py-1.5 text-[13px]">
                <span className="w-5 shrink-0 text-right font-mono text-[11px] text-faint">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {u.username}
                  <span className="ml-2 text-[11.5px] text-faint">{u.email}</span>
                </span>
                <span className="shrink-0 font-mono text-[12px] tabular-nums">
                  {fmtTokens(u.billableTokens)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={t('Agent status')}>
        <div className="space-y-2">
          {data.agents.map((a) => (
            <div key={a.id} className="flex items-center gap-3 text-[13px]">
              <span
                className={clsx(
                  'size-1.5 shrink-0 rounded-full',
                  a.availability.available ? 'bg-emerald-500' : 'bg-faint',
                )}
              />
              <span className="w-16 shrink-0 font-mono">{a.id}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {a.availability.available
                  ? (a.availability.version ?? t('available'))
                  : (a.availability.reason ?? t('unavailable'))}
              </span>
              <span className="shrink-0 text-[11.5px] text-faint">
                {t('{n} models', { n: a.models.length })}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

/**
 * How the upstream names its own windows; anything else is shown by its raw key.
 *
 * `7d_oi` is the weekly allowance for the heaviest models: it arrives on Claude Fable
 * responses and on no others, which is how it was identified — the header set is not
 * documented anywhere we can point at.
 */
const WINDOW_LABEL: Record<string, string> = {
  '5h': 'Rolling 5 hours',
  '7d': 'Rolling 7 days',
  '7d_oi': 'Rolling 7 days, premium models',
  overage: 'Overage'
};

/**
 * The shared plan's own allowance.
 *
 * The one screen where the upstream's figures are the right answer. Everywhere
 * else they are replaced with the asking user's quota, because one subscription
 * serves every tenant and the pool's numbers are nobody's allowance in
 * particular.
 */
function UpstreamAllowanceCard() {
  const t = useT();
  const [view, setView] = useState<UpstreamAllowanceView | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const load = () => void admin.upstreamAllowance().then(setView).catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!view) return null;

  const a = view.allowance;
  const windows = Object.entries(a?.windows ?? {}).filter(
    ([, w]) => w.utilization !== null || w.resetsAt !== null,
  );

  return (
    <Card
      title={t('Upstream plan allowance')}
      description={t('What the shared subscription reports about itself. Users are shown their own quota instead, so this is the only place it is visible.')}
    >
      {view.unreachable || view.error ? (
        <Banner tone="warn">{view.error ?? t('Cannot reach the gateway')}</Banner>
      ) : !a ? (
        <Empty text={t('Nothing observed yet — it fills in on the next upstream response.')} />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted">
            <span className="font-mono text-ink">{a.provider}</span>
            {a.status && <span>{a.status}</span>}
            <span className="text-faint">{t('as of {t}', { t: fmtDate(a.observedAt) })}</span>
          </div>

          {windows.length === 0 ? (
            <Empty text={t('The upstream sent no limit windows')} />
          ) : (
            windows.map(([key, w]) => (
              <div key={key}>
                <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                  <span>{t(WINDOW_LABEL[key] ?? key)}</span>
                  <span className="font-mono tabular-nums">
                    {w.utilization === null ? '—' : `${Math.round(w.utilization * 100)}%`}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-line">
                  <div
                    className={clsx(
                      'h-full rounded-full',
                      (w.utilization ?? 0) >= 0.9 ? 'bg-red-500' : (w.utilization ?? 0) >= 0.75 ? 'bg-amber-500' : 'bg-accent',
                    )}
                    style={{ width: `${Math.min(Math.max((w.utilization ?? 0) * 100, 0), 100)}%` }}
                  />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 text-[11.5px] text-faint">
                  {w.resetsAt && <span>{t('resets {t}', { t: fmtDate(w.resetsAt) })}</span>}
                  {/* Only when this window is older than the reading it sits in: a window
                      the upstream did not mention this time is somebody else's last turn,
                      and how old it is decides whether the number means anything */}
                  {w.observedAt && a.observedAt && w.observedAt !== a.observedAt && (
                    <span>{t('read {t}', { t: fmtDate(w.observedAt) })}</span>
                  )}
                </div>
              </div>
            ))
          )}

          {a.codex !== undefined && a.codex !== null && (
            <pre className="overflow-x-auto rounded-lg bg-bubble/60 p-2.5 text-[11.5px]">
              {JSON.stringify(a.codex, null, 2)}
            </pre>
          )}

          <div>
            <Button variant="ghost" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t('Hide headers') : t('All headers')}
            </Button>
            {showRaw && (
              <pre className="mt-2 overflow-x-auto rounded-lg bg-bubble/60 p-2.5 text-[11.5px] leading-relaxed">
                {Object.entries(a.raw)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
