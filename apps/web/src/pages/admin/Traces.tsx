/**
 * Egress traces, as the audit proxy recorded them.
 *
 * Split out of AdminPage.tsx, which had grown to 2700 lines; one file per tab now.
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { admin, type AdminTraces, type TraceDetail } from '../../lib/api';
import { Banner, Button, Card, Empty, Spinner, fmtDate } from '../../components/ui';
import { useT } from '../../lib/i18n';

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
export function TraceLogs() {
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
            chars: sys.reduce((a, b) => a + (b.chars ?? 0), 0)
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
