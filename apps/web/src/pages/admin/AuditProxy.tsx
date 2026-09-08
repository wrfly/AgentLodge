/**
 * The audit proxy's configuration and its allowlist.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import { admin, type AuditProxyStatus } from '../../lib/api';
import { Banner, Button, Card, Field, Toggle } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { WithUnit } from './shared';

export function AuditProxyCard() {
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
                maxBytes: Math.round(Number(gb) * 1024 ** 3)
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
