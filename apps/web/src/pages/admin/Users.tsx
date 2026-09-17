/**
 * Accounts: quotas, top-ups, resets, roles.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import { BarChart3, Gauge, RotateCcw, Wallet } from 'lucide-react';
import clsx from 'clsx';
import { admin, type AdminUser, fmtMoney, type QuotaScope, type UserAgentUsage } from '../../lib/api';
import {
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Select,
  Spinner,
  Toggle,
  fmtDate,
  fmtTokens,
  mToTokens,
  tokensToM,
} from '../../components/ui';
import { AgentModelTable } from '../../components/AgentModelTable';
import { useT } from '../../lib/i18n';
import { WithUnit } from './shared';

/* ---------------- Users ---------------- */

/**
 * The same per-model table the user's own usage page shows, about somebody else.
 *
 * Fetched when the panel opens rather than with the list: the breakdown is a grouped scan per
 * account, and the list renders every account on the deployment. An operator opens one row at
 * a time.
 *
 * `reload` is the list's own counter, so the table follows the buttons above it. A top-up, a
 * reset or an undo all change what this account has spent and all call `onChange`, which used
 * to reload only the row — leaving a freshly-zeroed bar sitting over a pre-reset breakdown.
 *
 * The range and its label both come from the server. Naming the period here would have meant
 * two places deciding what "this quota month" covers, and they disagree the moment somebody
 * is reset: the gate counts from the reset, a month boundary does not.
 */
function UsagePanel({ userId, reload }: { userId: string; reload: number }) {
  const t = useT();
  const [data, setData] = useState<UserAgentUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Bumped by the retry button — the only thing that re-runs the effect on the same row */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // The panel can be closed, the user searched away, or the row reloaded under it before
    // the answer lands — in all three the request itself is abandoned, not just its result
    const ac = new AbortController();
    setErr(null);
    admin
      .userAgentUsage(userId, ac.signal)
      .then(setData)
      .catch((e) => {
        if (!ac.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [userId, reload, attempt]);

  return (
    <div className="mt-3 rounded-lg border border-line bg-elevated p-3">
      <div className="mb-2 text-[12.5px] font-medium">
        {`${t('By agent and model')}${data ? ` · ${t(data.range.label)}` : ''}`}
      </div>
      {err ? (
        // Recoverable, because the usual cause is: the server was restarting. Without this
        // the banner is terminal and the only way out is to guess that closing the panel and
        // reopening it starts over.
        <Banner tone="error">
          <span className="flex flex-wrap items-center gap-2">
            <span className="flex-1">{err}</span>
            <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
              {t('Retry')}
            </Button>
          </span>
        </Banner>
      ) : !data ? (
        <Spinner />
      ) : (
        <AgentModelTable rows={data.rows} totals={data.total} currency={data.currency} />
      )}
    </div>
  );
}

/**
 * A top-up lifts one window's ceiling until that window resets.
 *
 * There is no clock to set any more: the window's own boundary is the expiry, which is what
 * keeps every user on the same schedule even when one of them is let through.
 */
function TopupPanel({ user, onDone }: { user: AdminUser; onDone: () => void }) {
  const t = useT();
  const byCost = user.quota.limitKind === 'cost';
  const [amount, setAmount] = useState(byCost ? '10' : '5');
  const [scope, setScope] = useState<QuotaScope>('window');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await admin.topup(user.id, {
        // Typed in millions on the token side, like every other allowance field
        ...(byCost ? { amount: Number(amount) } : { tokens: mToTokens(amount) }),
        scope,
      });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-accent/30 bg-accent-soft/40 p-3">
      <div className="mb-2 text-[12.5px] font-medium">{t('Top up')}</div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-32">
          <Field label={t('Which window')}>
            <Select value={scope} onChange={(e) => setScope(e.target.value as QuotaScope)}>
              <option value="window">{t('This 5-hour window')}</option>
              <option value="week">{t('This week')}</option>
              <option value="month">{t('This month')}</option>
            </Select>
          </Field>
        </div>
        <div className="w-28">
          <Field label={t(byCost ? 'Amount' : 'Extra allowance')}>
            {byCost ? (
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            ) : (
              <WithUnit className="block" unit="M" value={amount} onChange={setAmount} />
            )}
          </Field>
        </div>
        <div className="pb-3.5">
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            <Wallet size={13} />
            {t('Top up')}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[11.5px] text-faint">
        {t('Expires when that window resets — there is no separate clock to set.')}
      </p>
    </div>
  );
}

/** Digits and one decimal point: the unit is millions, so 0.5 has to be typeable */
const clean = (v: string): string => v.replace(/[^\d.]/g, '');

function UserRow({ user, onChange: reloadList }: { user: AdminUser; onChange: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [topup, setTopup] = useState(false);
  const [usage, setUsage] = useState(false);
  /*
   * Everything in this row that changes what the account has spent goes through `onChange`,
   * which reloads the list. The usage panel below is not in the list, so it needs telling
   * separately — otherwise a reset zeroes the bar and leaves the breakdown beside it showing
   * the month that was just forgiven.
   */
  const [reload, setReload] = useState(0);
  const onChange = () => {
    setReload((n) => n + 1);
    reloadList();
  };
  // Typed in millions; the API takes the quota's own unit
  const asM = (v: number | null) => (v === null ? '' : tokensToM(v));
  const [limitWindow, setLimitWindow] = useState(asM(user.quota.window));
  const [limitWeek, setLimitWeek] = useState(asM(user.quota.week));
  const [limitMonth, setLimitMonth] = useState(asM(user.quota.month));
  const [hardStop, setHardStop] = useState(user.quota.hardStop);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const byCost = user.quota.limitKind === 'cost';
  // The list shows the 5-hour window: it is the one that bites first, and usage.period is
  // measured over exactly that window on the server
  const used = byCost ? user.usage.period.costMicro : user.usage.period.billableTokens;
  // The effective ceiling, not the configured one: a live top-up raises what the gate lets
  // through, and a bar drawn against the raw number reads past 100% while it still does
  const cap = user.quota.windowCeiling;
  const pct = cap ? Math.min(used / cap, 1) : 0;
  const show = (v: number) => (byCost ? fmtMoney(v, user.quota.currency) : fmtTokens(v));

  const save = async () => {
    setBusy(true);
    try {
      const ceiling = (v: string) => (v.trim() === '' ? null : mToTokens(v));
      await admin.updateUser(user.id, {
        window: ceiling(limitWindow),
        week: ceiling(limitWeek),
        month: ceiling(limitMonth),
        hardStop,
      });
      setEditing(false);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const [lastReset, setLastReset] = useState<number | null>(null);

  const resetUsage = async () => {
    setBusy(true);
    try {
      const res = await admin.resetUsage(user.id);
      setLastReset(res.clearedTokens ?? 0);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const undoReset = async () => {
    setBusy(true);
    try {
      await admin.resetUsage(user.id, true);
      setLastReset(null);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  /** A change the server can refuse, such as leaving no active administrator, says why under the row */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = () =>
    act(() => admin.updateUser(user.id, { status: user.status === 'active' ? 'suspended' : 'active' }));

  const toggleRole = () =>
    act(() => admin.updateUser(user.id, { role: user.role === 'admin' ? 'user' : 'admin' }));

  return (
    <div className="border-b border-line px-1 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px]">
            <span className="font-medium">{user.username}</span>
            {user.role === 'admin' && (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent">
                {t('Administrator')}
              </span>
            )}
            {user.status === 'suspended' && (
              <span className="rounded bg-danger/12 px-1.5 py-0.5 text-[10.5px] text-danger">
                {t('Disabled')}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-faint">
            {user.email} · {t('{n} conversations', { n: user.conversations })} ·{' '}
            {t('last login {when}', { when: fmtDate(user.lastLoginAt) })}
          </div>
        </div>

        <div className="w-40 shrink-0">
          <div className="mb-1 flex justify-between font-mono text-[11px] tabular-nums">
            <span>{show(used)}</span>
            <span className="text-faint">
              {cap ? show(cap) : t('unlimited')}
              {/* The bar divides by the effective ceiling, so the printed denominator is the
                  boosted one — while the edit form one click away is seeded from the
                  configured limit. Without a mark the two just look like different numbers.
                  Kept to a `+n` because the row has no width for a sentence; the sentence is
                  the tooltip. */}
              {cap !== null && user.quota.window !== null && cap > user.quota.window && (
                <span
                  className="ml-1 text-accent"
                  title={t('incl. {amount} topped up', { amount: show(cap - user.quota.window) })}
                >
                  {`+${show(cap - user.quota.window)}`}
                </span>
              )}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-bubble">
            <div
              className={clsx(
                'h-full rounded-full',
                pct >= 1 ? 'bg-danger' : pct >= 0.9 ? 'bg-amber-500' : 'bg-accent',
              )}
              /* Nothing spent draws nothing: a window that has just rolled over, or a
                 user who has just been reset, has no usage to mark. */
              style={{ width: used === 0 ? '0%' : `${Math.max(pct * 100, cap ? 2 : 0)}%` }}
            />
          </div>
        </div>

        {/* Two tiers rather than one row of five buttons, and the weight differs with the
            stakes. Spending is adjusted daily, so it keeps the buttons; role and status are
            touched once in the life of an account and read as quiet links under them. A
            labelled pair of groups was the first attempt at the split and it put two grey
            words on every row to say what the layout already says. */}
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {/* First of the three: it is the one that is only ever read. The row already
                says what this account has spent — this says what it spent it on, which is
                the question the bar beside it cannot answer. */}
            <Button variant="ghost" onClick={() => setUsage((v) => !v)}>
              <BarChart3 size={12} />
              {t('Usage')}
            </Button>
            <Button variant="ghost" onClick={() => setTopup((v) => !v)}>
              <Wallet size={12} />
              {t('Top up')}
            </Button>
            <Button variant="ghost" onClick={() => setEditing((v) => !v)}>
              <Gauge size={12} />
              {t('Quota')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void resetUsage()}
              disabled={busy}
              title={t('Zero the usage for this period — nothing is deleted, the counting start just moves forward')}
            >
              <RotateCcw size={12} />
              {t('Reset to zero')}
            </Button>
          </div>

          {/* The first account has neither control — it cannot be demoted, and can only be
              disabled if something else already disabled it — so the tier is simply absent.
              `pr-3` is the buttons' own horizontal padding: without it the links hang off
              the right of the labels they sit under. */}
          {(!user.first || user.status === 'suspended') && (
            <div className="flex items-center gap-2 pr-3 text-[11.5px] text-faint">
              {!user.first && (
                <>
                  <button
                    onClick={() => void toggleRole()}
                    disabled={busy}
                    className="transition hover:text-ink disabled:opacity-40"
                  >
                    {user.role === 'admin' ? t('Make standard user') : t('Make administrator')}
                  </button>
                  <span aria-hidden>·</span>
                </>
              )}
              <button
                onClick={() => void toggleStatus()}
                disabled={busy}
                className={clsx(
                  'transition disabled:opacity-40',
                  user.status === 'active' ? 'hover:text-danger' : 'hover:text-ink',
                )}
              >
                {t(user.status === 'active' ? 'Disable' : 'Enable')}
              </button>
            </div>
          )}
        </div>
      </div>

      {err && <div className="mt-2 text-[12px] text-danger">{err}</div>}

      {lastReset !== null && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-elevated px-3 py-2 text-[12.5px]">
          <span className="flex-1">
            {/* Money for a cost quota — it said "Zeroed 9,000,000 tokens" to an operator
                who had just cleared $9.00 — and the unit noun kept for tokens, which
                `show` alone drops. */}
            {t('Zeroed')}{' '}
            <strong className="font-mono">
              {byCost ? show(lastReset) : `${lastReset.toLocaleString()} ${t('tokens')}`}
            </strong>{' '}
            {t('(nothing was deleted; the counting start just moved forward)')}
          </span>
          <Button variant="ghost" onClick={() => void undoReset()} disabled={busy}>
            {t('Undo')}
          </Button>
        </div>
      )}

      {usage && <UsagePanel userId={user.id} reload={reload} />}

      {topup && <TopupPanel user={user} onDone={() => { setTopup(false); onChange(); }} />}

      {editing && (
        <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-elevated p-3">
          {/* Three ceilings, all optional. The windows they apply to are the platform's —
              the same instants for every user — so there is no period to choose. */}
          <div className="w-32">
            <Field label={t('Per 5 hours')} hint={t('empty = unlimited')}>
              <WithUnit className="block" unit="M" value={limitWindow} onChange={(v) => setLimitWindow(clean(v))} />
            </Field>
          </div>
          <div className="w-32">
            <Field label={t('Per week')} hint={t('empty = unlimited')}>
              <WithUnit className="block" unit="M" value={limitWeek} onChange={(v) => setLimitWeek(clean(v))} />
            </Field>
          </div>
          <div className="w-32">
            <Field label={t('Per month')} hint={t('empty = unlimited')}>
              <WithUnit className="block" unit="M" value={limitMonth} onChange={(v) => setLimitMonth(clean(v))} />
            </Field>
          </div>
          <div className="pb-4">
            <Toggle checked={hardStop} onChange={setHardStop} label={t('Block when over quota')} />
          </div>
          <div className="pb-3.5">
            <Button variant="primary" onClick={() => void save()} loading={busy}>
              {t('Save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Users() {
  const t = useT();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = () =>
    admin
      .users()
      .then(setUsers)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!users) return <Spinner />;

  const filtered = q
    ? users.filter(
        (u) =>
          u.username.toLowerCase().includes(q.toLowerCase()) ||
          u.email.toLowerCase().includes(q.toLowerCase()),
      )
    : users;

  return (
    <Card
      title={t('Users ({n})', { n: users.length })}
      actions={
        <div className="w-44">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search username or email")} />
        </div>
      }
    >
      {filtered.length === 0 ? (
        <Empty text={t('No matching users')} />
      ) : (
        filtered.map((u) => <UserRow key={u.id} user={u} onChange={() => void load()} />)
      )}
    </Card>
  );
}
