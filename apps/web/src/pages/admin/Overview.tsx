/**
 * The overview tab: totals, what carried them, and the shared plan's own allowance.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import {
  admin,
  type AdminOverview,
  type BalanceResult,
  type GateStatus,
  type PlatformPreset,
  type PlatformUsage,
  money,
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
} from '../../components/ui';
import { TokenCells, TokenHeaders, TokenSplit } from '../../components/TokenSplit';
import { useT } from '../../lib/i18n';
import { Money, MoneyCell, statMoney } from '../../components/Money';
import { PLATFORM_PRESETS } from './shared';

/* ---------------- Overview ---------------- */

type TFn = (source: string, vars?: Record<string, string | number>) => string;
type BalanceRow = NonNullable<BalanceResult['balances']>[number];

function balanceSub(t: TFn, b: BalanceRow): string | undefined {
  const parts: string[] = [];
  if (b.used && b.limit) {
    parts.push(
      t('{used} used of {limit} prepaid', {
        used: `${b.used} ${b.currency}`,
        limit: `${b.limit} ${b.currency}`,
      }),
    );
  } else if (b.used) {
    parts.push(t('{used} used', { used: `${b.used} ${b.currency}` }));
  }
  if (b.planName) parts.push(b.planName);
  if (b.billedHere) parts.push(t('counted from this platform'));
  return parts.join(' · ') || undefined;
}

export function Overview() {
  const t = useT();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [balance, setBalance] = useState<BalanceResult | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void admin
      .overview()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  // Fetched once, but the window it describes ends; the card asks for a fresh one when it does
  useEffect(reload, [reload]);
  /*
   * Cursor's prepaid is several dashboard RPCs. The landing page used to wait for them
   * inside `/api/admin/overview`; they load on their own now, the way the gate card does.
   */
  useEffect(() => {
    void admin.balance().then(setBalance).catch(() => setBalance(null));
  }, []);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner />;

  return (
    <>
      <LiveWindowCard data={data} onStale={reload} />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t('Users')} value={String(data.users.total)} sub={t('{n} active', { n: data.users.active })} />
        <Stat
          label={t('Billed all time')}
          {...statMoney(data.allTime, data.currency)}
          sub={t('{n} turns', { n: data.allTime.turns })}
        />
        {balance === undefined ? (
          <Stat label={t('Upstream balance')} value="…" />
        ) : balance?.balances.length ? (
          balance.balances.map((b, i) => (
            <Stat
              key={`${b.source ?? 'bal'}-${b.label ?? i}`}
              label={
                b.source === 'cursor'
                  ? t('{name} prepaid', { name: b.label || 'Cursor' })
                  : b.label
                    ? t('{name} balance', { name: b.label })
                    : t('Upstream balance')
              }
              value={b.totalBalance ? `${b.totalBalance} ${b.currency}` : '—'}
              sub={balanceSub(t, b)}
            />
          ))
        ) : (
          <Stat
            label={t('Upstream balance')}
            value="—"
            sub={balance?.error ?? t('No API key configured')}
          />
        )}
      </div>

      <UpstreamAllowanceCard prepaid={balance?.balances} />

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
  '7d_oi': 'Rolling 7 days, Fable models',
  overage: 'Overage'
};

/* ---------------- The platform's usage, over one period ---------------- */


/**
 * The platform's total for one period, the shape of it, and what carried it.
 *
 * It was called "Usage, all users" while it ended in a leaderboard. There are no users in it
 * now — the total, the chart, the upstreams and their models are all the platform's — and a
 * name that still promised people would have had operators looking here for them.
 *
 * Four cards would answer the same question four times and still not let anybody compare: an
 * upstream that carried heavily this month and nothing today is not the one to go and look
 * at. One selector drives everything, so switching the period re-answers it all at once.
 *
 * Opening an upstream shows the models under it, because that is what an upstream's total is
 * made of and two models differ by a factor of ten per token. Who spent it is the user usage
 * tab's subject, on the same periods, so the two can be read against each other.
 */
function PlatformUsageCard() {
  const t = useT();
  const [preset, setPreset] = useState<PlatformPreset>('today');
  /** Which upstream rows are open. Several at once, because the point is comparing them. */
  const [open, setOpen] = useState<Set<string>>(new Set());
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

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Already padded with empty buckets by the server, which is the only place that knows
  // which timezone its own bucket keys were cut in
  const slots = data?.series ?? [];
  const max = Math.max(...slots.map((d) => d.costSettled), 1);
  // An hourly stamp reads `2026-09-10 14:00`, a daily one `2026-09-10`
  const short = (stamp: string) =>
    data?.seriesUnit === 'hour' ? stamp.slice(11, 16) : stamp.slice(5);

  return (
    <Card title={t('Platform usage')}>
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
            <Money totals={data.totals} currency={data.currency} className="text-[17px]" />
            {/* Beside the money, not under it: the three counts are priced at four
                different rates, so they do not add up to it and are not offered as if
                they did. */}
            <TokenSplit totals={data.totals} />
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
                    title={`${d.t}: ${money(d, data.currency).text}`}
                    className={clsx(
                      'flex-1 rounded-t-sm',
                      d.costSettled > 0 ? 'bg-accent/70 hover:bg-accent' : 'bg-line',
                    )}
                    style={{ height: d.costSettled ? `${Math.max((d.costSettled / max) * 100, 3)}%` : '2%' }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-faint">
                <span>{short(slots[0]!.t)}</span>
                <span>{short(slots[slots.length - 1]!.t)}</span>
              </div>
            </>
          )}

          {/*
            What carried it, and underneath each one, what it was spent on. Opening a row used
            to narrow the whole card to that upstream, which answered "who used this
            credential" — a question about people, and people moved to the users tab. The
            question left here is where a credential's money went, and money goes to models.

            Several rows open at once on purpose: an operator comparing what two upstreams are
            being used for cannot do it one row at a time.
          */}
          {/* No turns column here, unlike the by-user table. `turns` counts distinct turn ids,
              so one turn that called two models on an upstream is one turn on its row and one
              under each model beneath it — tokens and money add up, that would not, and this
              is the one table whose whole point is that its parts sum to their parent. */}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-faint">
                  <th className="pb-1.5 font-medium">{t('Upstream')}</th>
                  <th className="pb-1.5 font-medium">{t('Credential')}</th>
                  <TokenHeaders />
                  <th className="pb-1.5 text-right font-medium">{t('Cost')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byUpstream.map((r) => {
                  const id = r.providerId || 'none';
                  const shown = open.has(id);
                  // Its own models, from the same scan as the row — so they add up to it
                  const models = data.byUpstreamModel.filter(
                    (m) => (m.providerId || 'none') === id,
                  );
                  return (
                    <Fragment key={id}>
                      <tr
                        onClick={() => toggle(id)}
                        className={clsx(
                          'cursor-pointer border-b border-line hover:bg-bubble',
                          shown && 'bg-bubble',
                        )}
                      >
                        {/* Spend the CLI booked itself, which happens only when the gateway
                            was not in the path, plus anything written before the column
                            existed. A row, because it is the difference between this table
                            and the total. */}
                        <td className="py-1.5">
                          <ChevronRight
                            size={12}
                            className={clsx(
                              'mr-1 inline shrink-0 text-faint transition-transform',
                              shown && 'rotate-90',
                            )}
                          />
                          {r.name || t('Not through the gateway')}
                          {r.kind && <span className="ml-2 font-mono text-[11px] text-faint">{r.kind}</span>}
                        </td>
                        <td className="py-1.5 font-mono text-[12px] text-muted">{r.credentialId || '—'}</td>
                        <TokenCells totals={r} />
                        <MoneyCell totals={r} currency={data.currency} className="py-1.5 text-muted" />
                      </tr>

                      {/* No empty case: both breakdowns come from one scan of one range, so an
                          upstream listed above always has at least one model row under it. */}
                      {shown &&
                        models.map((m) => (
                          <tr key={`${id}-${m.model}`} className="border-b border-line bg-bubble/40">
                            {/* A turn that recorded no model groups under an empty name; the
                                interface reads that as "whatever the CLI picked" */}
                            <td className="py-1 pl-6 font-mono text-[12px] text-muted" colSpan={2}>
                              {m.model || t('(default)')}
                            </td>
                            <TokenCells totals={m} className="text-[12px]" />
                            <MoneyCell totals={m} currency={data.currency} className="py-1 text-[12px] text-muted" />
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1.5 text-[11.5px] text-faint">
              {t('Click an upstream to see which models its spend went on.')}
            </p>
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
    <Card title={t('This 5-hour window')}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Money totals={w.totals} currency={data.currency} className="text-[22px]" />
        <TokenSplit totals={w.totals} />
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
function UpstreamAllowanceCard({ prepaid }: { prepaid?: BalanceRow[] }) {
  const t = useT();
  const [view, setView] = useState<UpstreamAllowanceView | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const load = () => void admin.upstreamAllowance().then(setView).catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  const pots = (prepaid ?? []).filter(
    (b) => b.source === 'cursor' && (b.limit || b.totalBalance),
  );

  if (!view && !pots.length) return null;

  const a = view?.allowance;
  const windows = Object.entries(a?.windows ?? {}).filter(
    ([, w]) => w.utilization !== null || w.resetsAt !== null,
  );
  const showWindows = Boolean(view && !view.unreachable && !view.error && a && windows.length);
  const showEmptyHeaders = Boolean(view && !view.unreachable && !view.error && a && !windows.length && !pots.length);
  const showNothingYet = Boolean(view && !view.unreachable && !view.error && !a && !pots.length);
  const gatewayFailed = Boolean((view?.unreachable || view?.error) && !pots.length);

  return (
    <Card title={pots.length && !showWindows ? t('Prepaid credit') : t('Upstream plan allowance')}>
      {gatewayFailed ? (
        <Banner tone="warn">{view?.error ?? t('Cannot reach the gateway')}</Banner>
      ) : showNothingYet ? (
        <Empty text={t('Nothing observed yet — it fills in on the next upstream response.')} />
      ) : showEmptyHeaders ? (
        <Empty text={t('The upstream sent no limit windows')} />
      ) : (
        <div className="space-y-3">
          {pots.map((b) => {
            const used = Number(b.used);
            const limit = Number(b.limit);
            const pct = limit > 0 && Number.isFinite(used) ? Math.min(Math.max(used / limit, 0), 1) : 0;
            return (
              <div key={`${b.label}-${b.totalBalance}`}>
                <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                  <span>{b.label || 'Cursor'}</span>
                  <span className="font-mono tabular-nums">
                    {b.totalBalance
                      ? t('{amount} remaining', { amount: `${b.totalBalance} ${b.currency}` })
                      : '—'}
                  </span>
                </div>
                {limit > 0 && Number.isFinite(used) && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div
                      className={clsx(
                        'h-full rounded-full',
                        pct >= 0.9 ? 'bg-red-500' : pct >= 0.75 ? 'bg-amber-500' : 'bg-accent',
                      )}
                      style={{ width: `${pct * 100}%` }}
                    />
                  </div>
                )}
                <div className="mt-1 flex flex-wrap gap-x-2 text-[11.5px] text-faint">
                  {b.used && b.limit && (
                    <span>
                      {t('{used} used of {limit} prepaid', {
                        used: `${b.used} ${b.currency}`,
                        limit: `${b.limit} ${b.currency}`,
                      })}
                    </span>
                  )}
                  {b.planName && <span>{b.planName}</span>}
                  {b.billedHere && <span>{t('counted from this platform')}</span>}
                  {b.resetsAt && <span>{t('resets {t}', { t: fmtDate(b.resetsAt) })}</span>}
                </div>
              </div>
            );
          })}

          {showWindows && a && (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted">
                <span className="font-mono text-ink">{a.provider}</span>
                {a.status && <span>{a.status}</span>}
                <span className="text-faint">{t('as of {t}', { t: fmtDate(a.observedAt) })}</span>
              </div>

              {windows.map(([key, w]) => (
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
                    {w.observedAt && a.observedAt && w.observedAt !== a.observedAt && (
                      <span>{t('read {t}', { t: fmtDate(w.observedAt) })}</span>
                    )}
                  </div>
                </div>
              ))}

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
            </>
          )}
        </div>
      )}
    </Card>
  );
}
