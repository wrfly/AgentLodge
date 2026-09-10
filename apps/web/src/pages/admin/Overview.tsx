/**
 * The overview tab: totals, top users, and the shared plan's own allowance.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  admin,
  fmtMoney,
  type AdminOverview,
  type GateStatus,
  type PlatformPreset,
  type PlatformUsage,
  type UpstreamAllowanceView,
} from '../../lib/api';
import {
  Banner,
  Button,
  Card,
  Empty,
  Spinner,
  Stat,
  fmtDate,
  fmtTokens
} from '../../components/ui';
import { useT } from '../../lib/i18n';

/* ---------------- Overview ---------------- */

export function Overview() {
  const t = useT();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void admin
      .overview()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  // Fetched once, but the window it describes ends; the card asks for a fresh one when it does
  useEffect(reload, [reload]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner />;

  return (
    <>
      <LiveWindowCard data={data} onStale={reload} />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t('Users')} value={String(data.users.total)} sub={t('{n} active', { n: data.users.active })} />
        <Stat
          label={t('Billed all time')}
          value={fmtTokens(data.allTime.billableTokens)}
          sub={fmtMoney(data.allTime.costMicro, data.currency)}
        />
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

      <PlatformUsageCard />

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

/* ---------------- Everybody's usage, over one period ---------------- */

const PLATFORM_PRESETS: Array<{ id: PlatformPreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
];

/**
 * One period control for the total, the shape of it, and who spent it.
 *
 * Four ranking cards would answer the same question four times and still not let anybody
 * compare: somebody who spent heavily this month and nothing today is not the person to go
 * and talk to. One selector drives all three, so switching the period re-answers everything
 * at once — the same control the user-facing usage page has, at the other scope.
 */
function PlatformUsageCard() {
  const t = useT();
  const [preset, setPreset] = useState<PlatformPreset>('today');
  const [data, setData] = useState<PlatformUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    void admin
      .platformUsage(preset)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [preset]);

  // Already padded with empty buckets by the server, which is the only place that knows
  // which timezone its own bucket keys were cut in
  const slots = data?.series ?? [];
  const max = Math.max(...slots.map((d) => d.billableTokens), 1);
  // An hourly stamp reads `2026-09-10 14:00`, a daily one `2026-09-10`
  const short = (stamp: string) =>
    data?.seriesUnit === 'hour' ? stamp.slice(11, 16) : stamp.slice(5);

  return (
    <Card title={t('Usage, all users')}>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PLATFORM_PRESETS.map((p) => (
          <Button
            key={p.id}
            variant={preset === p.id ? 'primary' : 'ghost'}
            onClick={() => setPreset(p.id)}
          >
            {t(p.label)}
          </Button>
        ))}
      </div>

      {error ? (
        <Banner tone="error">{error}</Banner>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[17px] tabular-nums">
              {data.totals.billableTokens.toLocaleString()}
            </span>
            <span className="font-mono text-[13px] text-muted tabular-nums">
              {fmtMoney(data.totals.costMicro, data.currency)}
            </span>
            <span className="text-[12px] text-faint">
              {t('{n} turns', { n: data.totals.turns })}
            </span>
          </div>

          {slots.length === 0 ? (
            <Empty text={t('No usage in this period')} />
          ) : (
            <>
              <div className="flex h-24 items-end gap-[3px]">
                {slots.map((d) => (
                  <div
                    key={d.t}
                    title={`${d.t}: ${d.billableTokens.toLocaleString()}`}
                    className={clsx(
                      'flex-1 rounded-t-sm',
                      d.billableTokens > 0 ? 'bg-accent/70 hover:bg-accent' : 'bg-line',
                    )}
                    style={{ height: d.billableTokens ? `${Math.max((d.billableTokens / max) * 100, 3)}%` : '2%' }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-faint">
                <span>{short(slots[0]!.t)}</span>
                <span>{short(slots[slots.length - 1]!.t)}</span>
              </div>
            </>
          )}

          <div className="mt-4 space-y-1">
            {data.topUsers.length === 0 ? (
              <Empty text={t('No data in this period')} />
            ) : (
              data.topUsers.map((u, i) => (
                <div key={u.userId} className="flex items-center gap-3 px-1 py-1.5 text-[13px]">
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-faint">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {u.username}
                    <span className="ml-2 text-[11.5px] text-faint">{u.email}</span>
                  </span>
                  {/* Tokens and money both: two models differ by a factor of ten per token,
                      so a column of counts on its own does not say where the budget went */}
                  <span className="shrink-0 font-mono text-[12px] tabular-nums">
                    {fmtTokens(u.billableTokens)}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted">
                    {fmtMoney(u.costMicro, data.currency)}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------------- The live window ---------------- */

/** "2h 14m", or "4m", counted down to the given instant */
function untilText(endsAt: string, now: number): string {
  const ms = Math.max(new Date(endsAt).getTime() - now, 0);
  // Floor, not round: rounding 59m40s up gave "60m", which is not how anybody writes an hour
  const mins = Math.floor(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * The five-hour window, platform-wide, and whether anything is going wrong inside it.
 *
 * Not one preset among several. The month and the last seven days are things that happened;
 * this one is a countdown, and the question it answers — are we going to hit the wall before
 * it resets — has no meaning for the others. Putting it behind the same selector would hide
 * the only thing about it that is different.
 *
 * The bar is the clock, not the spend. Platform-side consumption has no ceiling of its own to
 * divide by; what makes the number legible is how far through the window it arrived. Burning
 * 80% of a shared subscription's allowance 30% of the way in is the shape of trouble, and
 * neither figure says that alone.
 */
function LiveWindowCard({ data, onStale }: { data: AdminOverview; onStale: () => void }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  // The countdown is the point of the card, so it has to actually count down
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  /*
   * Its own request. `/api/admin/gate` already exists and is already typed, and the landing
   * page has no business blocking on it — asking through the overview meant a five-second
   * wait for every admin whenever the gateway container was down.
   */
  const [gate, setGate] = useState<GateStatus | null>(null);
  useEffect(() => { void admin.gate().then(setGate).catch(() => setGate(null)); }, []);

  const w = data.window;
  const started = new Date(w.startsAt).getTime();
  const ends = new Date(w.endsAt).getTime();
  // From the clock on every tick, not from a fraction the server computed once: the two came
  // from the same window, and a bar frozen beside a live countdown is worse than no bar
  const elapsed = ends > started ? Math.round(Math.min(Math.max((now - started) / (ends - started), 0), 1) * 100) : 0;
  const rolled = now >= ends;
  // The totals belong to a window that has ended; say so rather than keep showing them
  useEffect(() => { if (rolled) onStale(); }, [rolled, onStale]);
  const refused = w.refused;
  const failed = w.statuses.error;
  const inFlight = gate?.pools?.reduce((n, p) => n + p.active, 0) ?? null;
  const queued = gate?.pools?.reduce((n, p) => n + p.queued, 0) ?? 0;

  return (
    <Card
      title={t('This 5-hour window')}
      description={t('Everybody, over the window the gate refuses on first. It is the platform’s own window, so it begins and ends at the same instants for every user.')}
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-[22px] tabular-nums">{fmtTokens(w.totals.billableTokens)}</span>
        <span className="font-mono text-[14px] text-muted tabular-nums">
          {fmtMoney(w.totals.costMicro, data.currency)}
        </span>
        <span className="text-[12.5px] text-faint">{t('{n} turns', { n: w.totals.turns })}</span>
        <span className="ml-auto text-[12.5px] text-muted">
          {rolled ? t('this window has ended') : t('resets in {d}', { d: untilText(w.endsAt, now) })}
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-bubble">
        <div className="h-full rounded-full bg-muted/40" style={{ width: `${elapsed}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-faint">
        <span>{t('{n}% of the window elapsed', { n: elapsed })}</span>
        <span>{fmtDate(w.startsAt)} → {fmtDate(w.endsAt)}</span>
      </div>

      {(refused > 0 || failed > 0) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
          {refused > 0 && (
            <span className="text-danger">
              {/* People, not attempts: a refused client that retries in a loop would
                  otherwise report its own retry policy rather than anything actionable */}
              {t('{n} hit their quota', { n: refused })}
            </span>
          )}
          {failed > 0 && <span className="text-amber-600">{t('{n} failed upstream', { n: failed })}</span>}
        </div>
      )}

      {gate && !gate.unreachable && inFlight !== null && (
        <div className="mt-2 flex flex-wrap gap-x-3 text-[11.5px] text-faint">
          {/* Summed across pools, the way the Gate tab does it: `active` and `queued` are
              per upstream, and the ceiling every pool starts from is `max` */}
          <span>{t('gate {active}/{max} in flight', { active: inFlight, max: gate.max })}</span>
          {queued > 0 && <span className="text-amber-600">{t('{n} waiting', { n: queued })}</span>}
        </div>
      )}
    </Card>
  );
}

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
