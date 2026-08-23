import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { me, type ApiKeyRow } from '../lib/api';
import { Banner, Button, Card, Empty, Field, Input, Page, Spinner, fmtDate, fmtTokens } from '../components/ui';
import { useT } from '../lib/i18n';

/**
 * "Point my own claude / codex at this."
 *
 * Same backend and same quota as the web app. The one difference is that tools
 * run on your machine rather than in our container, so they can reach your
 * local files and we cannot see any of it.
 */
export function ApiKeysPage() {
  const t = useT();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [install, setInstall] = useState<{ command: string; script: string } | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await me.apiKeys();
      setKeys(r.keys);
      // With PUBLIC_GATEWAY_URL unset, fall back to this origin — which is exactly
      // right for single-machine development
      setBaseUrl(r.baseUrl || window.location.origin);
      setInstall(r.install);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const r = await me.createApiKey(name.trim());
      setFresh(r.plaintext);
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (k: ApiKeyRow) => {
    setError(null);
    try {
      await me.revokeApiKey(k.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const live = keys?.filter((k) => !k.revokedAt) ?? [];

  return (
    <Page
      title={t('API keys')}
      subtitle={t('Point the Claude Code or Codex on your machine at this, on the same account and the same quota.')}
    >
      {error && <Banner tone="error">{error}</Banner>}

      {fresh && (
        <Card
          title={t('New key')}
          description={t('Shown once. Dismiss this and the plaintext is gone — we store only a hash.')}
        >
          <CopyBox text={fresh} mono />
          <div className="mt-3">
            <Button variant="ghost" onClick={() => setFresh(null)}>
              {t('I have saved it')}
            </Button>
          </div>
        </Card>
      )}

      <Card title={t('Create')}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('Name')} hint={t('So you can tell which machine this key is on, e.g. "work MacBook"')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) void create();
              }}
              placeholder={t("work MacBook")}
              className="w-64"
            />
          </Field>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={creating}
            onClick={() => void create()}
            className="mb-4"
          >
            <Plus size={14} />
            {t('Create')}
          </Button>
        </div>
      </Card>

      {keys === null ? (
        <Spinner />
      ) : keys.length === 0 ? (
        <Empty text={t('No keys yet. Create one above, then follow the setup below.')} />
      ) : (
        <Card title={t('Keys ({n} active)', { n: live.length })}>
          <div className="divide-y divide-line">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 py-2.5">
                <KeyRound
                  size={14}
                  className={clsx('shrink-0', k.revokedAt ? 'text-faint' : 'text-accent')}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={clsx('truncate text-[13px]', k.revokedAt && 'text-faint line-through')}>
                      {k.name}
                    </span>
                    <span className="shrink-0 rounded bg-bubble px-1.5 py-0.5 font-mono text-[11px] text-muted">
                      {k.prefix}…
                    </span>
                    {k.revokedAt && (
                      <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger">
                        {t('Revoked')}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px] text-faint">
                    <span>{t('created {when}', { when: fmtDate(k.createdAt) })}</span>
                    <span>
                      {k.lastUsedAt
                        ? t('last used {when}', { when: fmtDate(k.lastUsedAt) })
                        : t('never used')}
                    </span>
                    {k.usage && (
                      <span>
                        {t('{calls} calls · {tokens} billable tokens', {
                          calls: k.usage.calls,
                          tokens: fmtTokens(k.usage.billableTokens),
                        })}
                      </span>
                    )}
                  </div>
                </div>
                {!k.revokedAt && (
                  <Button variant="ghost" onClick={() => void revoke(k)}>
                    <Trash2 size={14} />
                    {t('Revoke')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Setup baseUrl={baseUrl} fresh={fresh} install={install} />
    </Page>
  );
}

/**
 * The install command, with the key dropped in.
 *
 * The key only exists in the browser, and only for as long as this page is open:
 * the server hands the plaintext over once, at creation, and keeps a hash. Before
 * that — or after a reload — the placeholder is left visible so it reads as
 * something to replace rather than as a working command.
 */
function fillIn(command: string, key: string | null): string {
  return command.replace('__AGENTLODGE_KEY__', key ?? '<your key>');
}

function Setup({
  baseUrl,
  fresh,
  install,
}: {
  baseUrl: string;
  fresh: string | null;
  install: { command: string; script: string } | null;
}) {
  const t = useT();
  return (
    <Card
      title={t('Setup')}
      description={
        fresh
          ? t('The key you just created is already filled in below.')
          : t('Replace <your key> with the key you got when you created it, al_ and all.')
      }
    >
      <div className="space-y-4">
        <Block title="Claude Code">
          {install ? (
            <>
              <CopyBox text={fillIn(install.command, fresh)} />
              <Script text={install.script} />
            </>
          ) : (
            <Spinner />
          )}
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            {t('It writes the key to ~/.agentlodge/key, a claude wrapper next to it, and one line on your shell rc. Swapping the key later is one edit of that file — the wrapper rebuilds the rest on every run.')}
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            {t('Then open a new terminal and run claude as usual. Your own claude.ai login lives elsewhere and is untouched; quota and billing are the same account as the web app. Undo it with ~/.agentlodge/uninstall.sh.')}
          </p>
        </Block>

        <Block title="Codex">
          <CopyBox
            text={[
              `export OPENAI_API_KEY=${fresh ?? '<your key>'}`,
              `codex \\`,
              `  -c model_provider=agentlodge \\`,
              `  -c model_providers.agentlodge.name=AgentLodge \\`,
              `  -c model_providers.agentlodge.base_url=${baseUrl}/v1/ \\`,
              `  -c model_providers.agentlodge.wire_api=responses`,
            ].join('\n')}
          />
        </Block>

        <div className="rounded-lg border border-line bg-bubble/40 p-3 text-[12.5px] leading-relaxed text-muted">
          <p className="mb-1.5 font-medium text-ink">{t('How this differs from the web app')}</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              {t('Tools run on your own machine — they read and write your local files, not ours. We cannot see it and cannot control it.')}
            </li>
            <li>{t('Quota, rate limiting, billing and request traces are shared, on the same account as the web app.')}</li>
            <li>{t('Conversation history does not appear in the list here — we record usage and request traces only.')}</li>
            <li>{t('A leaked key means somebody spends your quota. Revoking takes effect immediately.')}</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}

/**
 * The script the command downloads, behind a fold.
 *
 * `curl … | sh` is only as good as the reader's chance to look first, and a
 * seventy-line block above the fold would push everything else off the screen.
 */
function Script({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
        {open ? t('Hide the script') : t('Read the script first')}
      </Button>
      {open && (
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-bubble/60 p-3 text-[11.5px] leading-relaxed">
          {text}
        </pre>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[12.5px] font-medium">{title}</div>
      {children}
    </div>
  );
}

function CopyBox({ text, mono }: { text: string; mono?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard is unavailable outside https; leave the text for manual selection */
    }
  };
  return (
    <div className="relative">
      <pre
        className={clsx(
          'overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-bubble/60 p-3 pr-20 text-[12px] leading-relaxed',
          mono && 'font-mono',
        )}
      >
        {text}
      </pre>
      <Button variant="ghost" onClick={() => void copy()} className="absolute right-1.5 top-1.5">
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? t('Copied') : t('Copy')}
      </Button>
    </div>
  );
}
