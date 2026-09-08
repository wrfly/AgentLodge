/**
 * Upstream credentials, as the credential manager holds them: sign in, paste, name a file, import.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import clsx from 'clsx';
import {
  admin,
  type Credential,
  type StartedLogin,
  type KeyFileEntry,
  type KeyFileListing
} from '../../lib/api';
import { Banner, Button, Card, Field, Input, Select, fmtDate } from '../../components/ui';
import { useT } from '../../lib/i18n';

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
export function CredentialsCard() {
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
            error: state.store.error ?? ''
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
                when: fmtDate(checked.mtime ?? '')
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
