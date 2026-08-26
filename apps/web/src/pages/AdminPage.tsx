import { Fragment, useEffect, useState } from 'react';
import {
  Ban,
  Check,
  Copy,
  Mail,
  Plus,
  RefreshCw,
  RotateCcw,
  Wallet,
  Gauge,
  Send,
  ShieldCheck,
  Trash2,
  UserCheck,
} from 'lucide-react';
import clsx from 'clsx';
import { factsFor, price, tokens } from '../lib/model-facts';
import {
  admin,
  type AdminOverview,
  type AdminUser,
  type AuditEntry,
  type InviteCode,
  fmtMoney,
  type GateStatus,
  type QuotaScope,
  type SettingView,
  type Provider,
  type Model,
  type ModelInput,
  type Credential,
  type StartedLogin,
  type KeyFileEntry,
  type KeyFileListing,
  type UpstreamAllowanceView,
  type AuditProxyStatus,
  type AdminTraces,
  type TraceDetail,
  api,
  type AgentInfo,
} from '../lib/api';
import { navigate, type AdminTab } from '../lib/route';
import type { AgentId } from '../lib/protocol';
import {
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Page,
  Select,
  Spinner,
  Stat,
  Toggle,
  fillDays,
  fmtDate,
  fmtTokens,
  mToTokens,
  tokensToM,
} from '../components/ui';
import { useT } from '../lib/i18n';

const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'invites', label: 'Invite codes' },
  { id: 'settings', label: 'System settings' },
  { id: 'trace_logs', label: 'Egress traces' },
  { id: 'audit', label: 'Audit log' },
];

/* ---------------- Overview ---------------- */

function Overview() {
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

/** How the upstream names its own windows; anything else is shown by its raw key */
const WINDOW_LABEL: Record<string, string> = {
  '5h': 'Rolling 5 hours',
  '7d': 'Rolling 7 days',
  '7d_oi': 'Rolling 7 days, overage included',
  overage: 'Overage',
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
                {w.resetsAt && (
                  <div className="mt-1 text-[11.5px] text-faint">
                    {t('resets {t}', { t: fmtDate(w.resetsAt) })}
                  </div>
                )}
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

/**
 * The upstream provider list. Where the gateway forwards to is decided here —
 * switching to a local Ollama, another third party, or the built-in mock needs
 * no code change and no restart.
 */
/** A provider being edited. `models` is multi-line text in the form and only becomes an array on submit */
interface ProviderDraft {
  name: string;
  kind: string;
  baseUrl: string;
  /** The credential's id. Empty means this provider has no way to authenticate. */
  credential: string;
}

/* ---------------- Upstream credentials ---------------- */

/** How long the token this credential holds is still good for, in words */
function expiryNote(c: Credential, t: ReturnType<typeof useT>): string | null {
  if (!c.expiresAt) return null;
  const ms = c.expiresAt - Date.now();
  if (ms <= 0) return t('expired');
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return t('{n}h left', { n: hours });
  return t('{n}m left', { n: Math.max(1, Math.floor(ms / 60_000)) });
}

/**
 * Where a credential came from, in words.
 *
 * A switch of literals rather than a lookup table: `t(TABLE[key])` type-checks and renders,
 * and the i18n check cannot see the strings, so they stay English in every locale.
 */
function credentialSource(source: string, t: ReturnType<typeof useT>): string {
  switch (source) {
    case 'host-file': return t('read from the mounted file');
    case 'typed': return t('pasted here');
    case 'login': return t('signed in here');
    case 'import': return t('imported from the mounted file');
    case 'file': return t('read from a file');
    default: return source;
  }
}

/**
 * Credentials the credential manager holds.
 *
 * A provider points at one by name. The value — a pasted key, a file another process
 * rotates, or the refresh token behind a subscription — stays in that service, and what
 * goes upstream is an access token it mints ahead of expiry. So this card shows a masked
 * hint and an expiry, and has no way to display a value: there is nothing here to read
 * back.
 *
 * Signing in happens in a browser that is not ours. The button hands back a link to
 * authorise at, and the page that redirect lands on shows a code to paste back — the same
 * flow `claude login` uses when it cannot open a browser itself.
 */
function CredentialsCard() {
  const t = useT();
  const [state, setState] = useState<{
    configured: boolean;
    rows: Credential[];
    error?: string;
    store?: { ok: boolean; error?: string };
  } | null>(null);
  const [panel, setPanel] = useState<'login' | 'key' | 'file' | 'import' | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    admin
      .credentials()
      .then((d) => setState({ configured: d.configured, rows: d.credentials, error: d.error, store: d.store }))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));

  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
      setPanel(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  return (
    <Card
      title={t('Upstream credentials')}
      description={t('Keys and subscriptions held by the credential manager. A provider points at one by name: the value stays in that service, and what goes upstream is a token it mints.')}
    >
      {err && <Banner tone="error">{err}</Banner>}
      {state.error && <Banner tone="error">{state.error}</Banner>}
      {/*
        Not an error: everything below works. What stopped working is durability,
        and the only moment anyone would notice is right after making a change —
        which is when this list is reloaded.
      */}
      {state.store?.ok === false && (
        <Banner tone="warn">
          {t('The credential manager cannot write its store, so anything changed here lives only in memory and a restart loses it. {error}', {
            error: state.store.error ?? '',
          })}
        </Banner>
      )}

      {!state.configured ? (
        <div className="text-[12px] leading-relaxed text-faint">
          {t('The credential manager is not running, so no upstream can authenticate. Start that service and its credentials appear here.')}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {state.rows.length === 0 && (
              <div className="text-[12px] text-faint">{t('Nothing here yet.')}</div>
            )}
            {state.rows.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-lg border border-line p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-medium">{c.id}</span>
                    <span className="shrink-0 text-[11px] text-faint">{c.kind}</span>
                    {c.renewable === false && (
                      <span className="shrink-0 text-[11px] text-danger">{t('cannot be renewed — sign in again')}</span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-faint">
                    {c.hint || '—'}
                    {` · ${credentialSource(c.source, t)}`}
                    {expiryNote(c, t) && ` · ${expiryNote(c, t)}`}
                    {c.label && ` · ${c.label}`}
                  </div>
                  {c.path && (
                    <div className="truncate font-mono text-[11px] text-faint">
                      {c.path}
                      {c.fingerprint && ` · ${t('fingerprint {v}', { v: c.fingerprint })}`}
                    </div>
                  )}
                  {c.error && <div className="truncate text-[11px] text-danger">{c.error}</div>}
                </div>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(() => admin.deleteCredential(c.id))}
                >
                  {t('Delete')}
                </Button>
              </div>
            ))}
          </div>

          {panel === null && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => setPanel('login')}>{t('Sign in to a subscription')}</Button>
              <Button variant="ghost" onClick={() => setPanel('key')}>{t('Paste an API key')}</Button>
              <Button variant="ghost" onClick={() => setPanel('file')}>{t('Read a key from a file')}</Button>
              <Button variant="ghost" onClick={() => setPanel('import')}>{t('Import a mounted credentials file')}</Button>
            </div>
          )}

          {panel === 'login' && <SignInPanel busy={busy} run={run} onCancel={() => setPanel(null)} />}
          {panel === 'key' && <PasteKeyPanel busy={busy} run={run} onCancel={() => setPanel(null)} />}
          {panel === 'file' && <KeyFilePanel busy={busy} run={run} onCancel={() => setPanel(null)} />}
          {panel === 'import' && <ImportPanel busy={busy} run={run} onCancel={() => setPanel(null)} />}
        </>
      )}
    </Card>
  );
}

type PanelProps = {
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onCancel: () => void;
};

/**
 * Signing a subscription in, in the two steps the flow actually has.
 *
 * The link is not opened for the administrator: it goes to an account, and which browser
 * profile that happens in is theirs to decide.
 */
function SignInPanel({ busy, run, onCancel }: PanelProps) {
  const t = useT();
  const [kind, setKind] = useState('claude');
  const [id, setId] = useState('claude');
  const [label, setLabel] = useState('');
  const [started, setStarted] = useState<StartedLogin | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    setErr(null);
    try {
      setStarted(await admin.startCredentialLogin({ kind, id: id.trim() || kind, label: label.trim() }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line p-2.5">
      {err && <Banner tone="error">{err}</Banner>}
      {!started ? (
        <>
          <Field label={t('Which subscription')}>
            <Select value={kind} onChange={(e) => { setKind(e.target.value); setId(e.target.value); }}>
              <option value="claude">Claude (claude.ai)</option>
              <option value="codex">Codex (ChatGPT)</option>
            </Select>
          </Field>
          <Field label={t('Name')} hint={t('What a provider points at. Letters, digits, dash, underscore, dot.')}>
            <Input value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} />
          </Field>
          <Field label={t('Note')}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('optional')} />
          </Field>
          <div className="flex gap-2">
            <Button onClick={() => void start()} loading={starting}>{t('Get the link')}</Button>
            <Button variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>
          </div>
        </>
      ) : (
        <>
          <div className="text-[12px] leading-relaxed text-faint">
            {t('Open this link, authorise there, and paste back the code the page shows.')}
          </div>
          <div className="flex items-center gap-2">
            <a
              href={started.authorizeUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-accent hover:underline"
            >
              {started.authorizeUrl}
            </a>
            <button
              type="button"
              title={t('Copy')}
              onClick={() => void navigator.clipboard.writeText(started.authorizeUrl)}
              className="shrink-0 rounded-md border border-line px-2 py-1 text-faint transition hover:text-muted"
            >
              <Copy size={13} />
            </button>
          </div>
          <Field label={t('Code')}>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="abc123#state"
              spellCheck={false}
              className="font-mono text-[12.5px]"
            />
          </Field>
          <div className="flex gap-2">
            <Button
              disabled={busy || !code.trim()}
              onClick={() => void run(() => admin.finishCredentialLogin({ loginId: started.loginId, code: code.trim() }))}
            >
              {t('Finish')}
            </Button>
            <Button variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>
          </div>
        </>
      )}
    </div>
  );
}

/** A key pasted once and never shown again — the field is write-only by design */
function PasteKeyPanel({ busy, run, onCancel }: PanelProps) {
  const t = useT();
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line p-2.5">
      <Field label={t('Name')} hint={t('What a provider points at. Letters, digits, dash, underscore, dot.')}>
        <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="deepseek" spellCheck={false} />
      </Field>
      <Field label="API Key">
        <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" spellCheck={false} />
      </Field>
      <Field label={t('Note')}>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('optional')} />
      </Field>
      <div className="flex gap-2">
        <Button
          disabled={busy || !id.trim() || !key.trim()}
          onClick={() => void run(() => admin.storeCredential({ id: id.trim(), label: label.trim(), apiKey: key.trim() }))}
        >
          {t('Save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>
      </div>
    </div>
  );
}

/**
 * A key that lives in a file something else writes: a docker secret, a secret-manager
 * sidecar, another container writing into a shared volume.
 *
 * Only the path is stored. The credential manager re-reads that file every time it is
 * asked for a token, so a rotation takes effect on the next request — which is the whole
 * reason to name a file instead of pasting its contents.
 *
 * A typo in a hand-typed path would surface as an upstream 401, three layers from the
 * cause, so what is actually in those directories is listed and can be clicked.
 */
function KeyFilePanel({ busy, run, onCancel }: PanelProps) {
  const t = useT();
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<KeyFileListing | null>(null);
  const [checked, setChecked] = useState<KeyFileEntry | null>(null);

  useEffect(() => {
    admin.credentialFiles().then(setListing).catch(() => {});
  }, []);

  // Check a typed path, debounced. A lone / is the first character being typed, and
  // "not in an allowed directory" then is pure noise.
  useEffect(() => {
    const target = path.trim();
    if (target.length < 2) {
      setChecked(null);
      return;
    }
    const timer = setTimeout(() => {
      admin.credentialFiles(target).then((d) => setChecked(d.checked ?? null)).catch(() => setChecked(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [path]);

  const roots = (listing?.roots ?? [])
    .map((r) => (r.exists ? r.path : `${r.path} ${t('(not mounted)')}`))
    .join('、');

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line p-2.5">
      <Field label={t('Name')} hint={t('What a provider points at. Letters, digits, dash, underscore, dot.')}>
        <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="vault-upstream" spellCheck={false} />
      </Field>
      <Field
        label={t('Path')}
        hint={t('Readable directories: {roots}. Set CREDENTIAL_FILE_ROOTS on the credential manager to add others.', { roots: roots || t('(none)') })}
      >
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/run/secrets/upstream.key"
          spellCheck={false}
          className="font-mono text-[12.5px]"
        />
      </Field>

      {checked && (
        <div className={clsx('text-[11.5px]', checked.usable ? 'text-faint' : 'text-danger')}>
          {checked.usable
            ? t('read {hint} · {size} bytes · fingerprint {fp} · updated {when}', {
                hint: checked.hint ?? '',
                size: checked.size ?? 0,
                fp: checked.fingerprint ?? '',
                when: fmtDate(checked.mtime ?? ''),
              })
            : checked.error}
        </div>
      )}

      {listing && listing.files.length > 0 && (
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {listing.files.map((f) => (
            <button
              key={f.path}
              type="button"
              disabled={!f.usable}
              onClick={() => setPath(f.path)}
              className={clsx(
                'flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-[11.5px] transition',
                f.path === path.trim() ? 'bg-accent/10' : 'hover:bg-elevated',
                !f.usable && 'cursor-not-allowed',
              )}
            >
              <span className="truncate font-mono">{f.path}</span>
              <span className={clsx('ml-auto shrink-0', f.usable ? 'text-faint' : 'text-danger')}>
                {f.usable ? `${f.hint} · ${t('{n} bytes', { n: f.size ?? 0 })}` : f.error}
              </span>
            </button>
          ))}
        </div>
      )}

      <Field label={t('Note')}>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('optional')} />
      </Field>
      <div className="flex gap-2">
        <Button
          disabled={busy || !id.trim() || !path.trim()}
          onClick={() => void run(() => admin.storeKeyFileCredential({ id: id.trim(), label: label.trim(), path: path.trim() }))}
        >
          {t('Save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>
      </div>
    </div>
  );
}

/**
 * Copying in the credentials file the credential manager has mounted — the host's
 * `claude login` output. Useful when that machine is already signed in; the credential
 * becomes this service's own from then on, and re-signing in on the host does not change
 * it until it is imported again.
 */
function ImportPanel({ busy, run, onCancel }: PanelProps) {
  const t = useT();
  const [kind, setKind] = useState('claude');
  const [id, setId] = useState('claude');

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line p-2.5">
      <Field label={t('Which subscription')}>
        <Select value={kind} onChange={(e) => { setKind(e.target.value); setId(e.target.value); }}>
          <option value="claude">Claude (claude.ai)</option>
          <option value="codex">Codex (ChatGPT)</option>
        </Select>
      </Field>
      <Field label={t('Name')} hint={t('What a provider points at. Letters, digits, dash, underscore, dot.')}>
        <Input value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} />
      </Field>
      <div className="flex gap-2">
        <Button
          disabled={busy || !id.trim()}
          onClick={() => void run(() => admin.importCredential({ kind, id: id.trim() }))}
        >
          {t('Import')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>
      </div>
    </div>
  );
}

function ProvidersCard() {
  const t = useT();
  const [rows, setRows] = useState<Provider[] | null>(null);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>({
    name: '', kind: 'openai-chat', baseUrl: '', credential: '',
  });
  /**
   * What the credential manager holds, for the picker in the form. Empty when no such
   * service is configured, and then the form does not offer that source at all.
   */
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    admin
      .providers()
      .then((d) => { setRows(d.providers); setKinds(d.kinds); })
      .catch(() => {});

  useEffect(() => { void load(); }, []);
  const loadCredentials = () =>
    admin.credentials().then((d) => setCredentials(d.credentials)).catch(() => {});
  useEffect(() => { void loadCredentials(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
      setEditing(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!rows) return null;

  const startEdit = (p?: Provider) => {
    // Again on every open: the credentials card is right above this one, and a credential
    // signed in there a moment ago has to be in the picker without a page reload
    void loadCredentials();
    setEditing(p?.id ?? 'new');
    setDraft({
      name: p?.name ?? '',
      kind: p?.kind ?? 'openai-chat',
      baseUrl: p?.baseUrl ?? '',
      credential: p?.credentialId ?? '',
    });
  };

  const save = () => {
    const payload = { name: draft.name, kind: draft.kind, baseUrl: draft.baseUrl };

    // Absent would leave it alone; the form always knows what it should be, so it is
    // always sent — an empty string clears it, and the console then shows the provider
    // as having no credential
    const keyFields = { credentialId: draft.credential };

    return run(() =>
      editing === 'new'
        ? admin.createProvider({ ...payload, ...keyFields })
        : admin.updateProvider(editing!, { ...payload, ...keyFields }),
    );
  };

  return (
    <Card
      title={t('Upstream providers')}
      description={t('How to reach each upstream: address, protocol, credential. Which one serves a request follows from the model it asks for — see Models below.')}
    >
      {err && <Banner tone="error">{err}</Banner>}

      <div className="space-y-2">
        {rows.map((p) => (
          <div key={p.id} className="rounded-lg border border-line p-2.5">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{p.name}</div>
                <div className="truncate text-[11.5px] text-faint">
                  {t(kinds[p.kind] ?? p.kind)}
                  {p.baseUrl && ` · ${p.baseUrl}`}
                  {p.credentialId && ` · ${t('credential {id}', { id: p.credentialId })}`}
                </div>
                {p.credentialMissing && (
                  <div className="truncate text-[11px] text-danger">
                    {t('{id} is not in the credential manager any more, so requests are refused', { id: p.credentialId })}
                  </div>
                )}
              </div>
              <Button variant="ghost" onClick={() => startEdit(p)}>{t('Edit')}</Button>
              <Button
                variant="ghost"
                disabled={busy}
                title={t('Deleting an upstream deletes the models pointed at it')}
                onClick={() => void run(() => admin.deleteProvider(p.id))}
              >
                {t('Delete')}
              </Button>
            </div>

            {editing === p.id && (
              <ProviderForm
                draft={draft}
                setDraft={setDraft}
                kinds={kinds}
                onSave={save}
                busy={busy}
                credentials={credentials}
              />
            )}
          </div>
        ))}
      </div>

      {editing === 'new' ? (
        <div className="mt-2 rounded-lg border border-line p-2.5">
          <ProviderForm draft={draft} setDraft={setDraft} kinds={kinds} onSave={save} busy={busy} credentials={credentials} />
        </div>
      ) : (
        <Button variant="ghost" className="mt-2" onClick={() => startEdit()}>
          {t('+ Add upstream')}
        </Button>
      )}

    </Card>
  );
}

/**
 * The hourly model refresh, at the foot of the upstream card.
 *
 * It is one global setting rather than a field on each provider, because only the active
 * one is refreshed — the picker draws from that one, and polling upstreams nobody is using
 * is traffic and key exposure for nothing. It lives here rather than in the generic settings
 * list so it sits next to the list it overwrites.
 */
function AutoRefreshModels() {
  const t = useT();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    admin.providers().then((d) => setOn(d.autoRefreshModels)).catch(() => {});
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await admin.saveSettings({ 'agents.autoRefreshModels': String(next) });
      setOn(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      {err && <Banner tone="error">{err}</Banner>}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{t('Refresh the model list hourly')}</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-faint">
            {t('Asks every upstream what models it has, once an hour, and adds the names that are missing. Nothing is removed or reordered, and a model turned off stays off. Either way the manual "Pull from the upstream" button still works.')}
          </div>
        </div>
        <Toggle checked={on} disabled={busy} onChange={(v) => void toggle(v)} />
      </div>
    </div>
  );
}


function ProviderForm({
  draft, setDraft, kinds, onSave, busy, credentials = [],
}: {
  draft: ProviderDraft;
  setDraft: (d: ProviderDraft) => void;
  kinds: Record<string, string>;
  onSave: () => void;
  busy: boolean;
  /** What the credential manager holds. Empty means there is none, and that source is not offered. */
  credentials?: Credential[];
}) {
  const t = useT();
  // The two built-in kinds never leave the machine, so no address and no credential
  const needsEndpoint = draft.kind === 'anthropic-native' || draft.kind === 'openai-chat';

  return (
    <div className="mt-2.5 space-y-2 border-t border-line pt-2.5">
      <Field label={t('Name')}>
        <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("e.g. local Ollama")} />
      </Field>
      <Field label={t('Kind')}>
        <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
          {Object.entries(kinds).map(([k, label]) => (
            <option key={k} value={k}>{t(label)}</option>
          ))}
        </Select>
      </Field>
      {needsEndpoint && (
        <>
          <Field label="Base URL" hint={t(draft.kind === 'openai-chat' ? 'Ollama is http://127.0.0.1:11434/v1' : 'Root address of the compatibility layer')}>
            <Input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.example.com" />
          </Field>
          <Field
            label={t('Credential')}
            hint={
              credentials.length === 0
                ? t('None yet — add one under Upstream credentials above.')
                : t('The gateway asks the credential manager for a token per request, so a subscription stays renewed and nothing usable is stored here.')
            }
          >
            <Select value={draft.credential} onChange={(e) => setDraft({ ...draft, credential: e.target.value })}>
              <option value="">{t('None')}</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>{`${c.id} · ${c.kind} · ${c.hint}`}</option>
              ))}
            </Select>
          </Field>
        </>
      )}
      <div className="flex gap-2">
        <Button onClick={onSave} disabled={busy || !draft.name.trim()}>{t('Save')}</Button>
      </div>
    </div>
  );
}

/* ---------------- Models ---------------- */

/**
 * The model catalogue.
 *
 * This is the routing table users see. A row makes a name pickable, and the upstream on
 * that row is where a request carrying the name goes. The same name can appear more than
 * once — one model offered by two upstreams, at two prices — and the lowest priority is
 * the one that gets used; the rest are what a failover would reach for.
 */
function ModelsCard() {
  const t = useT();
  const [rows, setRows] = useState<Model[] | null>(null);
  const [providers, setProviders] = useState<Array<{ id: string; name: string; kind: string }>>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelInput>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    admin.models().then((d) => { setRows(d.models); setProviders(d.providers); }).catch(() => {});

  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
      setEditing(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pull = async (providerId: string) => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await admin.pullModels(providerId);
      setRows(r.models);
      setNote(
        r.added > 0
          ? t('{n} added', { n: r.added })
          : t('nothing new — the upstream offers {n}', { n: r.offered.length }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!rows) return null;

  const providerName = (id: string): string => providers.find((p) => p.id === id)?.name ?? id;
  /** A name with more than one row is served by more than one upstream */
  const shared = new Set(
    rows.map((m) => m.name).filter((name, i, all) => all.indexOf(name) !== i),
  );

  const startEdit = (m?: Model) => {
    setEditing(m?.id ?? 'new');
    setDraft(
      m
        ? { name: m.name, providerId: m.providerId, upstreamName: m.upstreamName, priority: m.priority, note: m.note }
        : { name: '', providerId: providers[0]?.id ?? '', upstreamName: '', priority: 0 },
    );
  };

  return (
    <Card
      title={t('Models')}
      description={t('What users can pick. One name on two upstreams is two rows, lowest priority first.')}
    >
      {err && <Banner tone="error">{err}</Banner>}

      {providers.length === 0 ? (
        <div className="text-[12px] text-faint">{t('Add an upstream first — a model has to name one.')}</div>
      ) : (
        <>
          {rows.length === 0 ? (
            <div className="text-[12px] text-faint">{t('Nothing here yet.')}</div>
          ) : (
            /* A table, because every column but the first is a number to compare down the
               column. What the vendor publishes about a name is in lib/model-facts. */
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] font-normal text-faint">
                    <th className="py-1.5 pr-3 font-normal">{t('Model')}</th>
                    <th className="py-1.5 pr-3 font-normal">{t('Upstream')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('Context')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('Max output')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('In / out per MTok')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('SWE-bench')}</th>
                    <th className="py-1.5 font-normal" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((m) => {
                    const f = factsFor(m.name);
                    return (
                      <Fragment key={m.id}>
                        <tr>
                          <td className="py-1.5 pr-3">
                            <span className={clsx(m.enabled ? 'font-medium' : 'text-faint line-through')}>
                              {m.name}
                            </span>
                            {shared.has(m.name) && (
                              <span className="ml-1.5 text-[11px] text-faint">
                                {t('priority {n}', { n: m.priority })}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-faint">
                            {providerName(m.providerId)}
                            {m.upstreamName && ` · ${t('sent as {name}', { name: m.upstreamName })}`}
                            {m.note && ` · ${m.note}`}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-faint">
                            {f ? tokens(f.context) : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-faint">
                            {f?.maxOutput ? tokens(f.maxOutput) : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-faint">
                            {f?.inPrice !== undefined && f.outPrice !== undefined
                              ? `${price(f.inPrice)} / ${price(f.outPrice)}`
                              : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-faint">
                            {f?.swe !== undefined ? `${f.swe}%` : '—'}
                          </td>
                          <td className="py-1.5">
                            <div className="flex items-center justify-end gap-1">
                              <Toggle
                                checked={m.enabled}
                                disabled={busy}
                                onChange={(v) => void run(() => admin.updateModel(m.id, { enabled: v }))}
                              />
                              <Button variant="ghost" onClick={() => startEdit(m)}>{t('Edit')}</Button>
                              <Button variant="ghost" disabled={busy} onClick={() => void run(() => admin.deleteModel(m.id))}>
                                {t('Delete')}
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {editing === m.id && (
                          <tr>
                            <td colSpan={7} className="pb-2">
                              <ModelForm
                                draft={draft}
                                setDraft={setDraft}
                                providers={providers}
                                busy={busy}
                                onSave={() => void run(() => admin.updateModel(m.id, draft))}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11px] text-faint">
                {t('Vendor figures, not what this deployment bills.')}
              </p>
            </div>
          )}

          {editing === 'new' ? (
            <div className="mt-2 rounded-lg border border-line p-2.5">
              <ModelForm
                draft={draft}
                setDraft={setDraft}
                providers={providers}
                busy={busy}
                onSave={() => void run(() => admin.createModel(draft))}
              />
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => startEdit()}>{t('+ Add model')}</Button>
              {providers.map((p) => (
                <Button key={p.id} variant="ghost" disabled={busy} onClick={() => void pull(p.id)}>
                  <RefreshCw size={13} className={clsx(busy && 'animate-spin')} />
                  {t('Pull from {name}', { name: p.name })}
                </Button>
              ))}
              {note && <span className="text-[11.5px] text-muted">{note}</span>}
            </div>
          )}
          <AutoRefreshModels />
        </>
      )}
    </Card>
  );
}

function ModelForm({
  draft, setDraft, providers, busy, onSave,
}: {
  draft: ModelInput;
  setDraft: (d: ModelInput) => void;
  providers: Array<{ id: string; name: string; kind: string }>;
  busy: boolean;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-2.5 space-y-2 border-t border-line pt-2.5">
      <Field label={t('Name')} hint={t('What users pick, and what the price table and every report are keyed by.')}>
        <Input
          value={draft.name ?? ''}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="deepseek-v4-pro"
          spellCheck={false}
        />
      </Field>
      <Field label={t('Upstream')}>
        <Select value={draft.providerId ?? ''} onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('Name upstream')} hint={t('Only when the upstream calls it something else. Empty means the two match.')}>
        <Input
          value={draft.upstreamName ?? ''}
          onChange={(e) => setDraft({ ...draft, upstreamName: e.target.value })}
          placeholder={draft.name ?? ''}
          spellCheck={false}
        />
      </Field>
      <Field label={t('Priority')} hint={t('Lowest first among the upstreams offering this name.')}>
        <Input
          value={String(draft.priority ?? 0)}
          onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })}
          inputMode="numeric"
          className="w-24"
        />
      </Field>
      <Field label={t('Note')}>
        <Input value={draft.note ?? ''} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder={t('optional')} />
      </Field>
      <div className="flex gap-2">
        <Button onClick={onSave} disabled={busy || !draft.name?.trim() || !draft.providerId}>{t('Save')}</Button>
      </div>
    </div>
  );
}

function AuditProxyCard() {
  const t = useT();
  const [st, setSt] = useState<AuditProxyStatus | null>(null);
  const [allowDraft, setAllowDraft] = useState('');
  const [days, setDays] = useState('');
  const [count, setCount] = useState('');
  const [gb, setGb] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const r = await admin.auditProxy();
      setSt(r);
      if (r.config) {
        setAllowDraft(r.config.allow.join('\n'));
        setDays(String(Math.round(r.config.maxAgeMs / 86400000)));
        setCount(String(r.config.maxCount));
        setGb(String(+(r.config.maxBytes / 1024 ** 3).toFixed(2)));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await admin.setAuditProxy(patch);
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;

  /**
   * The enable switch. It has to work while the proxy is unreachable: a dead
   * proxy is exactly when you need to turn it off, and requiring the proxy to
   * be up in order to disable it is a deadlock. Hence it is rendered in both
   * branches and does not depend on st.config.
   */
  const requireRow = (
    <div className="mb-3">
      <Toggle
        checked={st.enabled}
        onChange={(v) => void save({ enabled: v })}
        label={t('Enable the audit proxy')}
      />
      <p className="mt-1 text-[12px] leading-relaxed text-muted">
        {st.enabled
          ? t('On: everything outbound goes through the proxy and is written down in full. An upstream with no AUDIT_PROXY_URL gets a 503 rather than a silent direct connection. Loopback addresses and mock / local-agent are exempt.')
          : t('Off: the gateway connects to upstreams directly, with no proxy and no x-forwarded-* routing headers, and this traffic leaves no record.')}
      </p>
    </div>
  );

  if (!st.configured || !st.editable) {
    return (
      <Card title={t('Audit proxy')} description={t('Everything outbound passes through it; requests and responses are written down in full')}>
        {err && <Banner tone="error">{err}</Banner>}
        {st.enabled && <Banner tone="warn">{st.reason ?? t('unavailable')}</Banner>}
        {requireRow}
        {st.url && <p className="mt-2 font-mono text-[11.5px] text-faint">{st.url}</p>}
      </Card>
    );
  }

  const c = st.config!;

  return (
    <Card
      title={t('Audit proxy')}
      description={t('Everything outbound passes through it. Changes apply immediately and are persisted in the proxy\'s own volume, surviving restarts.')}
      actions={saved ? <span className="text-[12px] text-accent">{t('Saved')}</span> : null}
    >
      {err && <Banner tone="error">{err}</Banner>}
      {!st.enabled && (
        <Banner tone="warn">
          {t('The audit proxy is not enabled — it is still running, but the gateway does not send traffic to it and nothing is recorded.')}
        </Banner>
      )}

      {requireRow}

      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-muted">
        <span>{st.url}</span>
        <span>{t('{n} records', { n: c.stats.traceCount })} · {(c.stats.traceBytes / 1024 ** 2).toFixed(1)} MB</span>
        <span>{c.stats.traceDir}</span>
      </div>

      {c.pinnedUpstream && (
        <Banner tone="warn">
          {t('This instance pins its upstream to {url} (UPSTREAM_URL); the allowlist takes no part.', { url: c.pinnedUpstream })}
        </Banner>
      )}
      {!c.dynamicUpstream && !c.pinnedUpstream && (
        <Banner tone="warn">
          {t('Dynamic routing is off, so requests from the gateway get a 403. It has to be on when several upstreams share one instance.')}
        </Banner>
      )}

      <Field
        label={t('Upstream allowlist')}
        hint={t('One host[:port] per line. Empty means no restriction, which turns this SSRF guard off. Add a new upstream here before switching to it.')}
      >
        <textarea
          value={allowDraft}
          onChange={(e) => setAllowDraft(e.target.value)}
          rows={Math.max(3, allowDraft.split('\n').length)}
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-line-strong"
        />
      </Field>
      <div className="mb-3 flex gap-2">
        <Button
          onClick={() =>
            void save({ allow: allowDraft.split('\n').map((v) => v.trim()).filter(Boolean) })
          }
          disabled={busy}
        >
          {t('Save allowlist')}
        </Button>
        <Toggle
          checked={c.dynamicUpstream}
          onChange={(v) => void save({ dynamicUpstream: v })}
          label={t('Route dynamically by x-forwarded-host')}
        />
      </div>

      <Field label={t('Retention')} hint={t('Whichever limit trips first removes the oldest. Set 0 to disable that one.')}>
        <div className="flex items-center gap-2">
          <WithUnit value={days} onChange={setDays} unit={t('days')} />
          <WithUnit value={count} onChange={setCount} unit={t('records')} />
          <WithUnit value={gb} onChange={setGb} unit="GB" />
          <Button
            className="shrink-0"
            disabled={busy}
            onClick={() =>
              void save({
                maxAgeMs: Math.round(Number(days) * 86400000),
                maxCount: Math.round(Number(count)),
                maxBytes: Math.round(Number(gb) * 1024 ** 3),
              })
            }
          >
            {t('Save')}
          </Button>
        </div>
      </Field>
    </Card>
  );
}

/**
 * A number with its unit inside the box.
 *
 * Three of these plus a button used to be three fixed-width fields, three separate unit
 * labels and a wrapping row — which came out as three lines, and as more lines still in a
 * language whose word for "records" is longer. Sharing the width equally keeps it on one
 * line whatever the unit says, and the unit is only ever read next to its own field.
 */
function WithUnit({
  value,
  onChange,
  unit,
  className = 'min-w-0 flex-1',
}: {
  value: string;
  onChange: (v: string) => void;
  unit: string;
  /** The wrapper's width. A row of them shares the space; one on its own fills it. */
  className?: string;
}) {
  return (
    <span className={clsx('relative', className)}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        // Room for the unit, which sits on top of the input's right end
        className="pr-[4.5rem] text-[13px]"
      />
      {/* Capped and truncating: a longer word in some other language would otherwise sit on
          top of the number rather than beside it */}
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex max-w-[3.5rem] items-center truncate text-[11px] text-faint">
        {unit}
      </span>
    </span>
  );
}

/** Live state of the concurrency gate. The upstream's rate limit is a black box; this shows where AIMD has settled */
function GateCard() {
  const t = useT();
  const [gate, setGate] = useState<GateStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => admin.gate().then((g) => { setGate(g); setDraft(String(g.max)); }).catch(() => {});

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  if (!gate) return null;

  // Split across processes, the gate lives in the gateway container. Say so when
  // it is unreachable, or the UI reads as "concurrency 0"
  if (gate.unreachable) {
    return (
      <Card title={t('Concurrency gate')}>
        <p className="text-[13px] text-danger">{gate.error ?? t('cannot reach the gateway')}</p>
        <p className="mt-1 text-[12px] text-faint">
          {t('This is what it looks like when the gateway container is not up. Rate limiting still applies on that side; only the status is unreadable here.')}
        </p>
      </Card>
    );
  }

  const save = async () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) return;
    setBusy(true);
    try {
      setGate(await admin.setGateConcurrency(n));
    } finally {
      setBusy(false);
    }
  };

  // One pool per upstream, so a busy one cannot make the others queue. The totals are the
  // sum across them, which is what "how loaded is this deployment" means.
  const pools = gate.pools ?? [];
  const active = pools.reduce((n, p) => n + p.active, 0);
  const queued = pools.reduce((n, p) => n + p.queued, 0);
  const granted = pools.reduce((n, p) => n + p.totalGranted, 0);
  const throttledCount = pools.reduce((n, p) => n + p.totalThrottled, 0);
  const narrowed = pools.filter((p) => p.effectiveMax < p.max);
  const waitP95 = pools.length ? Math.max(...pools.map((p) => p.waitMsP95)) : 0;
  const waitP50 = pools.length ? Math.max(...pools.map((p) => p.waitMsP50)) : 0;

  return (
    <Card
      title={t('Metering gateway')}
      description={
        gate.enabled
          ? t('Every agent request upstream goes through it: per-call accounting, a hard quota gate, and a rate limit per upstream')
          : t('No model is configured, so agents fall back to their own configuration and usage can only be counted per turn')
      }
      actions={
        <div className="flex items-center gap-1.5">
          <div className="w-16">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
              inputMode="numeric"
            />
          </div>
          <Button onClick={() => void save()} loading={busy} disabled={draft === String(gate.max)}>
            {t('Change limit')}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('In flight')} value={String(active)} tone="accent" />
        <Stat label={t('Queued')} value={String(queued)} tone={queued > 0 ? 'danger' : undefined} />
        <Stat
          label={t('Upstreams in use')}
          value={String(pools.length)}
          sub={t('limit {n} each', { n: gate.max })}
          tone={narrowed.length ? 'danger' : undefined}
        />
        <Stat
          label={t('Wait p95')}
          value={waitP95 > 0 ? `${(waitP95 / 1000).toFixed(1)}s` : '0'}
          sub={`p50 ${(waitP50 / 1000).toFixed(1)}s`}
        />
      </div>

      {pools.length > 0 && (
        <div className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line">
          {pools.map((p) => (
            <div key={p.providerId} className="flex items-baseline gap-2 px-2.5 py-1.5 text-[11.5px]">
              <span className="truncate">{p.name ?? p.providerId}</span>
              <span className="ml-auto shrink-0 text-faint">
                {t('{active} in flight · {queued} queued', { active: p.active, queued: p.queued })}
                {p.effectiveMax < p.max
                  ? ` · ${t('throttled upstream — reduced from {n}', { n: p.max })}`
                  : ` · ${t('limit {n}', { n: p.effectiveMax })}`}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-1.5 text-[12px] text-faint">
        <div className="flex items-center gap-1.5">
          <Gauge size={12} />
          {t('{granted} admitted in total · throttled upstream {throttled} times', {
            granted: granted.toLocaleString(),
            throttled: throttledCount,
          })}
          {narrowed.length > 0 && ` · ${t('recovers automatically after 20 consecutive successes')}`}
        </div>
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={12} className={gate.containers?.ok ? 'text-emerald-500' : ''} />
          {t('Container isolation:')} {gate.containers?.enabled ? gate.containers.detail : t('off — agents run directly on the host')}
          {gate.containers?.enabled && gate.containers.ok
            ? ` · ${t('{n} containers running', { n: gate.containers.running })}`
            : ''}
        </div>
      </div>
    </Card>
  );
}

/* ---------------- Users ---------------- */

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

function UserRow({ user, onChange }: { user: AdminUser; onChange: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [topup, setTopup] = useState(false);
  // Typed in millions; the API takes the quota's own unit
  const asM = (v: number | null) => (v === null ? '' : tokensToM(v));
  const [limitWindow, setLimitWindow] = useState(asM(user.quota.window));
  const [limitWeek, setLimitWeek] = useState(asM(user.quota.week));
  const [limitMonth, setLimitMonth] = useState(asM(user.quota.month));
  const [hardStop, setHardStop] = useState(user.quota.hardStop);
  const [busy, setBusy] = useState(false);

  const byCost = user.quota.limitKind === 'cost';
  // The list shows the 5-hour window: it is the one that bites first, and usage.period is
  // measured over exactly that window on the server
  const used = byCost ? user.usage.period.costMicro : user.usage.period.billableTokens;
  const cap = user.quota.window;
  const pct = cap ? Math.min(used / cap, 1) : 0;
  const show = (v: number) => (byCost ? fmtMoney(v) : fmtTokens(v));

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

  const toggleStatus = async () => {
    setBusy(true);
    try {
      await admin.updateUser(user.id, {
        status: user.status === 'active' ? 'suspended' : 'active',
      });
      onChange();
    } finally {
      setBusy(false);
    }
  };

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
            <span className="text-faint">{cap ? show(cap) : t('unlimited')}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-bubble">
            <div
              className={clsx(
                'h-full rounded-full',
                pct >= 1 ? 'bg-danger' : pct >= 0.9 ? 'bg-amber-500' : 'bg-accent',
              )}
              style={{ width: `${Math.max(pct * 100, cap ? 2 : 0)}%` }}
            />
          </div>
        </div>

        <div className="flex shrink-0 gap-1.5">
          <Button variant="ghost" onClick={() => setTopup((v) => !v)}>
            <Wallet size={12} />
            {t('Top up')}
          </Button>
          <Button variant="ghost" onClick={() => setEditing((v) => !v)}>
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
          <Button variant="ghost" onClick={() => void toggleStatus()} disabled={busy}>
            {user.status === 'active' ? <Ban size={12} /> : <UserCheck size={12} />}
            {t(user.status === 'active' ? 'Disable' : 'Enable')}
          </Button>
        </div>
      </div>

      {lastReset !== null && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-elevated px-3 py-2 text-[12.5px]">
          <span className="flex-1">
            {t('Zeroed')} <strong className="font-mono">{lastReset.toLocaleString()}</strong> tokens
            {t('(nothing was deleted; the counting start just moved forward)')}
          </span>
          <Button variant="ghost" onClick={() => void undoReset()} disabled={busy}>
            {t('Undo')}
          </Button>
        </div>
      )}

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

function Users() {
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

/* ---------------- Invite codes ---------------- */

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </Button>
  );
}

function Invites() {
  const t = useT();
  const [invites, setInvites] = useState<InviteCode[] | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [limit, setLimit] = useState('');
  const [days, setDays] = useState('7');
  const [role, setRole] = useState<'user' | 'admin'>('user');

  const load = () => admin.invites().then(setInvites).catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  const sendEmail = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await admin.emailInvite({
        email: email.trim(),
        presetTokenLimit: limit ? mToTokens(limit) : null,
        expiresInDays: Number(days) || 7,
        presetRole: role,
      });
      setEmail('');
      if (res.mail.sent) {
        setMsg({ tone: 'success', text: t('Invite email sent to {email}', { email: res.invite.email ?? '' }) });
      } else {
        setMsg({
          tone: 'warn',
          text: t('The email did not go out ({error}). Invite code {code} was created; you can forward the link yourself: {link}', {
            error: res.mail.error ?? '',
            code: res.invite.code,
            link: res.link ?? '',
          }),
        });
      }
      void load();
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const createPlain = async () => {
    setBusy(true);
    try {
      await admin.createInvites({
        count: 1,
        presetTokenLimit: limit ? mToTokens(limit) : null,
        expiresInDays: Number(days) || undefined,
        presetRole: role,
      });
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Card title={t('Send an invite')} description={t('With an address it emails the invite; without one it just creates a general-purpose code')}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Field label={t('Email')}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="someone@example.com"
              />
            </Field>
          </div>
          <div className="w-32">
            <Field label={t('Quota')}>
              <WithUnit
                className="block"
                unit="M"
                value={limit}
                onChange={(v) => setLimit(v.replace(/[^\d.]/g, ''))}
              />
            </Field>
          </div>
          <div className="w-24">
            <Field label={t('Valid for (days)')}>
              <Input
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
              />
            </Field>
          </div>
          <div className="w-28">
            <Field label={t('Role')}>
              <Select value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}>
                <option value="user">{t('Standard user')}</option>
                <option value="admin">{t('Administrator')}</option>
              </Select>
            </Field>
          </div>
          <div className="flex gap-2 pb-3.5">
            <Button variant="primary" onClick={() => void sendEmail()} loading={busy} disabled={!email.trim()}>
              <Send size={13} />
              {t('Send email')}
            </Button>
            <Button onClick={() => void createPlain()} disabled={busy}>
              <Plus size={13} />
              {t('Just create a code')}
            </Button>
          </div>
        </div>
      </Card>

      <Card title={t('Invite codes')}>
        {!invites ? (
          <Spinner />
        ) : invites.length === 0 ? (
          <Empty text={t('No invite codes yet')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-faint">
                  <th className="pb-2 font-medium">{t('Code')}</th>
                  <th className="pb-2 font-medium">{t('Bound to')}</th>
                  <th className="pb-2 font-medium">{t('Quota')}</th>
                  <th className="pb-2 font-medium">{t('Used')}</th>
                  <th className="pb-2 font-medium">{t('Status')}</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => {
                  const expired = i.expiresAt && new Date(i.expiresAt) < new Date();
                  const exhausted = i.usedCount >= i.maxUses;
                  return (
                    <tr key={i.id} className="border-b border-line last:border-0">
                      <td className="py-2 font-mono text-[12.5px]">{i.code}</td>
                      <td className="py-2 text-muted">
                        {i.email ? (
                          <span className="flex items-center gap-1">
                            <Mail size={11} className="text-faint" />
                            {i.email}
                            {i.sentAt && <Check size={11} className="text-emerald-500" />}
                          </span>
                        ) : (
                          <span className="text-faint">{t('general')}</span>
                        )}
                      </td>
                      <td className="py-2 font-mono text-[12px] tabular-nums">
                        {i.presetTokenLimit ? fmtTokens(i.presetTokenLimit) : t('unlimited')}
                      </td>
                      <td className="py-2 tabular-nums">
                        {i.usedCount}/{i.maxUses}
                      </td>
                      <td className="py-2">
                        {i.disabled ? (
                          <span className="text-faint">{t('disabled')}</span>
                        ) : exhausted ? (
                          <span className="text-faint">{t('used up')}</span>
                        ) : expired ? (
                          <span className="text-faint">{t('expired')}</span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-400">{t('available')}</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex justify-end gap-1">
                          <CopyButton text={i.code} />
                          {!i.disabled && (
                            <Button
                              variant="ghost"
                              onClick={() => void admin.disableInvite(i.id).then(load)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/* ---------------- System settings ---------------- */

/* ---------------- Egress traces ---------------- */

/**
 * Outbound traffic as the audit proxy wrote it down, in full.
 *
 * The proxy owns the data; this page is only a viewer, reading through
 * `/api/admin/traces` with the admin authentication the console already has.
 * The proxy's own /__trace UI is not involved: it needs authentication of its
 * own, which would mean either exposing the proxy on the frontend network or
 * planting the proxy's token in the browser. Both cost more than this page.
 */
function TraceLogs() {
  const t = useT();
  const [data, setData] = useState<AdminTraces | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  /** Whether `err` holds a success message. Derived from the outcome, not from
   *  the wording — a translated string makes a text prefix test meaningless. */
  const [cleared, setCleared] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      setData(await admin.traces());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggle = async (id: number) => {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    try {
      setDetail(await admin.trace(id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const clear = async () => {
    setBusy(true);
    setErr(null);
    setCleared(false);
    try {
      const r = await admin.clearTraces();
      setArmed(false);
      setOpenId(null);
      setDetail(null);
      await load();
      setCleared(true);
      setErr(
        t('Cleared {removed} records, freeing {mb} MB', { removed: r.removed, mb: r.freedMb }) +
          (r.remaining ? ` ${t('({n} could not be removed)', { n: r.remaining })}` : ''),
      );
    } catch (e) {
      setCleared(false);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Spinner />;

  return (
    <Card
      title={t('Egress traces')}
      description={t('Full requests and responses as written down by the audit proxy. It contains every user\'s complete prompts.')}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => void load()}>{t('Refresh')}</Button>
          {data.available &&
            (armed ? (
              <>
                <Button variant="ghost" onClick={() => setArmed(false)}>{t('Cancel')}</Button>
                <Button onClick={() => void clear()} loading={busy}>{t('Confirm clear')}</Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setArmed(true)} disabled={!data.rows.length}>
                {t('Clear')}
              </Button>
            ))}
        </div>
      }
    >
      {err && <Banner tone={cleared ? 'success' : 'error'}>{err}</Banner>}
      {!data.available && <Banner tone="warn">{data.reason ?? t('The audit proxy is unavailable')}</Banner>}
      {armed && (
        <Banner tone="warn">
          {t('Clearing cannot be undone: what it deletes is the record that everything outbound was recorded. The action itself is written to the audit log. The proxy\'s runtime configuration and sticky device_id are unaffected.')}
        </Banner>
      )}

      {data.available && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-muted">
          <span>{t('{n} records', { n: data.rows.length })}</span>
          {data.traceDir && <span>{data.traceDir}</span>}
        </div>
      )}

      {data.available && !data.rows.length && <Empty text={t('No egress records yet')} />}

      <div className="space-y-1">
        {data.rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-line">
            <button
              onClick={() => void toggle(r.id)}
              className="flex w-full items-center gap-3 px-2.5 py-2 text-left hover:bg-bubble/40"
            >
              <span className="w-10 shrink-0 font-mono text-[11.5px] text-faint">#{r.id}</span>
              <span
                className={clsx(
                  'w-9 shrink-0 font-mono text-[12px]',
                  r.status >= 400 ? 'text-danger' : 'text-accent',
                )}
              >
                {r.status}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.path}</span>
              <span className="hidden shrink-0 text-[11.5px] text-muted sm:inline">{r.model ?? '—'}</span>
              <span className="hidden w-16 shrink-0 text-right font-mono text-[11.5px] text-faint sm:inline">
                {r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : ''}
              </span>
              <span className="hidden w-40 shrink-0 text-right font-mono text-[11px] text-faint md:inline">
                {r.usage
                  ? `in ${r.usage.input_tokens ?? 0} out ${r.usage.output_tokens ?? 0} cr ${
                      r.usage.cache_read_input_tokens ?? 0
                    }`
                  : ''}
              </span>
              <span className="w-32 shrink-0 text-right text-[11.5px] text-faint">{fmtDate(r.time)}</span>
            </button>

            {openId === r.id && (
              <div className="border-t border-line px-2.5 py-2 text-[12.5px]">
                {!detail ? (
                  <Spinner />
                ) : (
                  <TraceDetailView d={detail} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** An expanded trace, split into what went out and what came back */
function TraceDetailView({ d }: { d: TraceDetail }) {
  const t = useT();
  const sys = Array.isArray(d.summary?.system) ? d.summary!.system : d.summary?.system ? [d.summary.system] : [];
  const rec = d.reconstructed;
  return (
    <div className="space-y-2.5">
      <div>
        <div className="mb-1 text-[12px] font-medium text-ink">{t('Request')}</div>
        <div className="font-mono text-[11.5px] text-muted">
          model={d.summary?.model ?? '—'} · stream={String(d.summary?.stream ?? false)} ·
          max_tokens={d.summary?.max_tokens ?? '—'} ·{' '}
          {t('{n} messages', { n: d.summary?.message_count ?? 0 })} ·{' '}
          {t('system {blocks} blocks ({chars} chars)', {
            blocks: sys.length,
            chars: sys.reduce((a, b) => a + (b.chars ?? 0), 0),
          })}
        </div>
        {d.summary?.tools?.length ? (
          <div className="mt-1 truncate font-mono text-[11px] text-faint">
            tools: {d.summary.tools.map((x) => (typeof x === 'string' ? x : x.name)).join(', ')}
          </div>
        ) : null}
        {d.summary?.messages?.length ? (
          <div className="mt-1.5 space-y-1">
            {d.summary.messages.slice(-6).map((m) => (
              <div key={m.i} className="rounded border border-line/70 px-2 py-1">
                <span className="font-mono text-[11px] text-faint">#{m.i} {m.role}</span>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-muted">
                  {m.text ??
                    (m.blocks ?? [])
                      .map((b) => {
                        const kind = b.type as string;
                        if (kind === 'tool_use') return `→ tool_use ${String(b.name)} ${String(b.input ?? '')}`;
                        if (kind === 'tool_result') return `← tool_result ${String(b.content ?? '')}`;
                        return String(b.text ?? kind);
                      })
                      .join('\n')}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div>
        <div className="mb-1 text-[12px] font-medium text-ink">{t('Response')}</div>
        <div className="font-mono text-[11.5px] text-muted">
          stop_reason={rec?.stop_reason ?? '—'} · {t('{n} SSE events', { n: rec?.event_count ?? 0 })}
          {rec?.usage ? ` · usage ${JSON.stringify(rec.usage)}` : ''}
        </div>
        {rec?.text ? (
          <div className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line/70 px-2 py-1 text-[12px]">
            {rec.text}
          </div>
        ) : null}
        {rec?.tool_uses?.length ? (
          <div className="mt-1 font-mono text-[11px] text-faint">
            tool_use: {rec.tool_uses.map((x) => x.name).join(', ')}
          </div>
        ) : null}
      </div>

      <details>
        <summary className="cursor-pointer text-[11.5px] text-faint">{t('Raw JSON')}</summary>
        <pre className="mt-1 max-h-80 overflow-auto rounded bg-bubble/40 p-2 text-[11px] leading-relaxed">
          {JSON.stringify(d, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/*
 * Tailwind needs the class in the source, so the spans are a map rather than a template.
 * Six columns, and a field that declares none takes the row.
 */
const SPAN: Record<NonNullable<SettingView['span']>, string> = {
  1: 'sm:col-span-1',
  2: 'sm:col-span-2',
  3: 'sm:col-span-3',
  4: 'sm:col-span-4',
  6: 'sm:col-span-6',
};

const GROUP_LABELS: Record<SettingView['group'], string> = {
  // The site address belongs in this group: all three of its uses build links in emails
  mail: 'Email and site address',
  quota: 'Quota',
  // Never rendered from here — the agents setting is hidden and has its own
  // card. The entry exists so the map stays total over the group union.
  agents: 'Agents',
};

/**
 * Which agents this deployment offers.
 *
 * Deliberately not a row in the generic settings list. That list renders a
 * setting as a text box, and this value is a set of ids where a typo makes an
 * agent silently vanish. It also needs to show, beside each toggle, whether
 * that agent's CLI is actually installed — the two questions get asked
 * together, and answering only one leaves an admin guessing.
 *
 * "Offered" and "installed" stay separate on purpose: a missing CLI is a fault
 * and says so; a disabled agent is a decision and simply does not appear.
 */
function AgentsCard() {
  const t = useT();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.agents().then(setAgents).catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  if (!agents) return null;

  const enabled = agents.filter((a) => a.enabled).map((a) => a.id);

  const toggle = async (id: AgentId, on: boolean) => {
    const next = on ? [...enabled, id] : enabled.filter((x) => x !== id);
    setBusy(true);
    setErr(null);
    try {
      // The server refuses an empty list. Surfacing its message beats inventing
      // our own — it is the side that decides.
      await admin.saveSettings({ 'agents.enabled': next.join(',') });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t('Agents')}
      description={t('Which agents this deployment offers.')}
    >
      {err && <Banner tone="error">{err}</Banner>}
      <div className="divide-y divide-line">
        {agents.map((a) => (
          /* Name, state and switch on one line: the state is a few words and had a line
             of its own under a name that was already short */
          <div key={a.id} className="flex items-center gap-2 py-1.5">
            <span className="shrink-0 text-[13.5px]">{a.displayName}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
              {a.enabled
                ? a.availability.available
                  ? (a.availability.version ?? t('CLI found'))
                  : (a.availability.reason ?? t('CLI not found'))
                : t('Off — not offered to users')}
            </span>
            <Toggle
              checked={a.enabled}
              disabled={busy || (a.enabled && enabled.length < 2)}
              onChange={(v) => void toggle(a.id, v)}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

function SettingsTab() {
  const t = useT();
  const [settings, setSettings] = useState<SettingView[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const load = () => admin.settings().then(setSettings).catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  if (!settings) return <Spinner />;

  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      /*
       * A scaled field is typed in its own unit; the server stores and validates the other
       * one. Converting here rather than in the field keeps the draft as what was typed, so
       * a half-finished "1." does not become 1000000 while it is still being typed.
       */
      const patch = Object.fromEntries(
        Object.entries(draft).map(([key, value]) => {
          const scale = settings.find((s) => s.key === key)?.scale;
          if (!scale || value.trim() === '') return [key, value];
          return [key, String(Math.round(Number(value) * scale))];
        }),
      );
      setSettings(await admin.saveSettings(patch));
      setDraft({});
      setMsg({ tone: 'success', text: t('Saved') });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const testMail = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await admin.testMail();
      setMsg({ tone: 'success', text: t('Test email sent to {to}', { to: res.to }) });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const groups = [...new Set(settings.map((s) => s.group))];

  return (
    <>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {dirty && (
        <div className="sticky top-0 z-10 mb-4 flex items-center justify-between rounded-lg border border-accent/40 bg-accent-soft px-3 py-2">
          <span className="text-[13px]">{t('{n} unsaved changes', { n: Object.keys(draft).length })}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setDraft({})}>
              {t('Discard')}
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={busy}>
              {t('Save')}
            </Button>
          </div>
        </div>
      )}

      {/* Upstreams, the audit proxy and the gate used to live under Overview.
          Overview should be statistics only, so everything editable moved here. */}
      <AgentsCard />
      <CredentialsCard />
      <ProvidersCard />
      <ModelsCard />
      <AuditProxyCard />
      <GateCard />

      {groups.map((g) => (
        <Card
          key={g}
          title={t(GROUP_LABELS[g])}
          actions={
            g === 'mail' ? (
              <Button onClick={() => void testMail()} loading={busy}>
                <Mail size={13} />
                {t('Send a test email')}
              </Button>
            ) : undefined
          }
        >
          <div className="grid grid-cols-1 gap-x-3 gap-y-3.5 sm:grid-cols-6">
            {settings
            .filter((s) => s.group === g)
            /*
             * A field that belongs to another choice is not there at all, rather than
             * greyed out or annotated: the mail card asks for an API key or for a relay,
             * and which one follows the dropdown as it moves — the draft is read first,
             * so it follows before the page is even saved.
             */
            .filter((s) => {
              if (!s.showWhen) return true;
              const on = settings.find((x) => x.key === s.showWhen!.key);
              return s.showWhen.is.includes(draft[s.showWhen.key] ?? on?.value ?? '');
            })
            .map((s) => {
              const value = draft[s.key] ?? s.value;
              return (
                /* The label is the only child here, so its own bottom margin collapses
                   and the grid's gap is what separates the rows */
                <div key={s.key} className={SPAN[s.span ?? 6]}>
                <Field
                  label={t(s.label)}
                  hint={
                    s.hint
                      ? `${t(s.hint)}${s.source === 'env' ? ` ${t('(current value comes from an environment variable)')}` : ''}`
                      : s.source === 'env'
                        ? t('(current value comes from an environment variable)')
                        : undefined
                  }
                >
                  {s.type === 'boolean' ? (
                    <Toggle
                      checked={value === 'true'}
                      onChange={(v) => setDraft((d) => ({ ...d, [s.key]: String(v) }))}
                    />
                  ) : s.type === 'select' ? (
                    <Select
                      value={value}
                      onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                    >
                      {/* Written as they are stored: these are product names */}
                      {(s.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  ) : s.scale ? (
                    /* Typed in its own unit; what leaves here is still the stored one */
                    <WithUnit
                      className="block"
                      unit={s.unit ?? ''}
                      value={draft[s.key] ?? (s.value ? tokensToM(Number(s.value)) : '')}
                      onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))}
                    />
                  ) : (
                    <Input
                      type={s.type === 'secret' ? 'password' : 'text'}
                      value={draft[s.key] ?? (s.type === 'secret' ? '' : s.value)}
                      placeholder={
                        s.type === 'secret' && s.isSet
                          ? t('Configured ({masked}); leave empty to keep it', { masked: s.value })
                          : ''
                      }
                      inputMode={s.type === 'number' ? 'decimal' : undefined}
                      onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                    />
                  )}
                </Field>
                </div>
              );
            })}
          </div>
        </Card>
      ))}

      <Card title={t('Note')}>
        <p className="text-[13px] leading-relaxed text-muted">
          <ShieldCheck size={13} className="mr-1 inline text-accent" />
          {t('API keys are stored AES-256-GCM encrypted, with the key derived from JWT_SECRET. Changing JWT_SECRET makes the stored keys undecryptable and they have to be entered again.')}
        </p>
      </Card>
    </>
  );
}

/* ---------------- Audit ---------------- */

function Audit() {
  const t = useT();
  const [logs, setLogs] = useState<AuditEntry[] | null>(null);

  const load = () => admin.auditLogs(200).then(setLogs).catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  if (!logs) return <Spinner />;

  return (
    <Card
      title={t('Audit log')}
      description={t('Most recent 200 entries')}
      actions={
        <Button onClick={() => void load()}>
          <RefreshCw size={13} />
          {t('Refresh')}
        </Button>
      }
    >
      {logs.length === 0 ? (
        <Empty text={t('Nothing recorded yet')} />
      ) : (
        <div className="space-y-0.5">
          {logs.map((l) => (
            <div key={l.id} className="flex gap-3 border-b border-line px-1 py-1.5 text-[12.5px] last:border-0">
              <span className="w-32 shrink-0 text-faint tabular-nums">{fmtDate(l.createdAt)}</span>
              <span className="w-44 shrink-0 font-mono">{l.action}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {l.detail ? JSON.stringify(l.detail) : ''}
              </span>
              <span className="shrink-0 text-faint">{l.ip}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------------- Shell ---------------- */

export function AdminPage({ tab }: { tab: AdminTab }) {
  const t = useT();
  return (
    <Page title={t('Admin console')}>
      <div className="mb-5 flex gap-1 border-b border-line">
        {/* Not `t` for the loop variable — that is the translator, and shadowing
            it here is exactly how these labels ended up untranslated. */}
        {TABS.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(`/admin/${item.id}`)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-[13.5px] transition',
              tab === item.id
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t(item.label)}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview />}
      {tab === 'users' && <Users />}
      {tab === 'invites' && <Invites />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'trace_logs' && <TraceLogs />}
      {tab === 'audit' && <Audit />}
    </Page>
  );
}
