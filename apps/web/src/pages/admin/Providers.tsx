/**
 * Upstream providers: where the gateway may forward.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import { admin, type Provider, type Credential } from '../../lib/api';
import { Banner, Button, Card, Field, Input, Select } from '../../components/ui';
import { useT } from '../../lib/i18n';

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

export function ProvidersCard() {
  const t = useT();
  const [rows, setRows] = useState<Provider[] | null>(null);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>({
    name: '', kind: 'openai-chat', baseUrl: '', credential: ''
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
      credential: p?.credentialId ?? ''
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

function ProviderForm({
  draft, setDraft, kinds, onSave, busy, credentials = []
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
