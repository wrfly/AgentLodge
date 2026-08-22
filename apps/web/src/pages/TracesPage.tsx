import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Trash2, ChevronRight } from 'lucide-react';
import { me, type TraceBlock, type TraceDetail, type TraceSummary } from '../lib/api';
import { Banner, Button, Card, Empty, Page, Spinner, fmtDate, fmtTokens } from '../components/ui';
import { useT } from '../lib/i18n';

/**
 * "What I actually sent."
 *
 * The data comes from the metering gateway — the only place that holds both the
 * userId and the full payload. Directories are keyed by userId and the backend
 * builds the path from the authenticated identity alone, so nobody sees anyone
 * else's.
 *
 * This shows the request side: how long the system prompt is, which tools were
 * attached, how deep the history has grown, what went out this time. The answer
 * itself is already visible in the conversation, so it is not repeated here.
 */
export function TracesPage() {
  const t = useT();
  const [list, setList] = useState<TraceSummary[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await me.traces();
      setList(r.traces);
      setEnabled(r.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const open = async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    try {
      setDetail(await me.trace(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Page
      title={t('Request traces')}
      subtitle={t('Exactly what goes upstream each time — system prompt, tool list, history. You only see your own.')}
      actions={
        list?.length ? (
          <Button
            variant="ghost"
            onClick={async () => {
              await me.clearTraces();
              setOpenId(null);
              setDetail(null);
              void load();
            }}
          >
            <Trash2 size={14} />
            {t('Clear')}
          </Button>
        ) : null
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      {!enabled && (
        <Banner tone="warn">
          {t('An administrator turned request recording off (TRACE_REQUESTS=false); only past data is shown below.')}
        </Banner>
      )}

      {list === null ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty text={t('Nothing recorded yet. Send a message and come back.')} />
      ) : (
        <Card title={t('Last {n} upstream requests', { n: list.length })}>
          <div className="divide-y divide-line">
            {list.map((item) => (
              <div key={item.id}>
                <button
                  onClick={() => void open(item.id)}
                  className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-bubble/40"
                >
                  <ChevronRight
                    size={14}
                    className={clsx(
                      'shrink-0 text-faint transition-transform',
                      openId === item.id && 'rotate-90',
                    )}
                  />
                  <span
                    className={clsx(
                      'shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]',
                      item.status >= 200 && item.status < 300
                        ? 'bg-bubble text-muted'
                        : 'bg-danger/10 text-danger',
                    )}
                  >
                    {item.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {item.preview || <span className="text-faint">{t('(no text)')}</span>}
                  </span>
                  <span className="hidden shrink-0 gap-3 font-mono text-[11px] tabular-nums text-faint sm:flex">
                    <span>{t('{n} msgs', { n: item.messageCount })}</span>
                    <span>{t('{n} tools', { n: item.toolCount })}</span>
                    <span>{item.durationMs}ms</span>
                    <span>{fmtDate(item.at)}</span>
                  </span>
                </button>

                {openId === item.id && (
                  <div className="pb-4 pl-7 pr-1">
                    {detail ? <Detail d={detail} /> : <Spinner />}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </Page>
  );
}

function Detail({ d }: { d: TraceDetail }) {
  const t = useT();
  const u = d.response.usage ?? {};
  return (
    <div className="space-y-3 text-[12.5px]">
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
        <span>{t('model {v}', { v: d.model ?? '—' })}</span>
        <span>{t('protocol {v}', { v: d.wire })}</span>
        <span>{t('from {v}', { v: t(d.credential === 'api-key' ? 'your own CLI' : 'the web app') })}</span>
        <span>{t('upstream {v}', { v: d.upstream ?? '—' })}</span>
        <span>{t(d.stream ? 'streamed' : 'not streamed')}</span>
        {d.response.ttftMs != null && <span>{t('first byte {v}ms', { v: d.response.ttftMs })}</span>}
        {d.response.queueWaitMs ? <span>{t('queued {v}ms', { v: d.response.queueWaitMs })}</span> : null}
      </div>

      <div className="flex flex-wrap gap-3 text-[11px]">
        {[
          ['input', u.inputTokens],
          ['cache read', u.cacheReadTokens],
          ['cache write', u.cacheCreationTokens],
          ['output', u.outputTokens],
        ].map(([label, v]) => (
          <span key={label as string} className="rounded bg-bubble px-2 py-1">
            {label} <b className="font-mono tabular-nums">{fmtTokens(Number(v ?? 0))}</b>
          </span>
        ))}
      </div>

      {d.response.error && <Banner tone="error">{d.response.error}</Banner>}

      {d.system.length > 0 && (
        <Section title={t('System prompt ({n} blocks)', { n: d.system.length })}>
          {d.system.map((b, i) => (
            <Block key={i} b={b} />
          ))}
        </Section>
      )}

      {d.tools.length > 0 && (
        <Section
          title={t('Tools ({n}, {chars} chars total)', {
            n: d.tools.length,
            chars: fmtTokens(d.tools.reduce((a, tool) => a + tool.chars, 0)),
          })}
        >
          <div className="flex flex-wrap gap-1.5">
            {d.tools.map((tool) => (
              <span key={tool.name} className="rounded bg-bubble px-1.5 py-0.5 font-mono text-[11px]">
                {tool.name}
                <span className="text-faint"> {tool.chars}</span>
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title={t('Messages ({n})', { n: d.messages.length })}>
        <div className="space-y-2">
          {d.messages.map((m, i) => (
            <div key={i} className="rounded-lg border border-line p-2">
              <div className="mb-1 font-mono text-[11px] text-accent">{m.role}</div>
              {m.blocks.map((b, j) => (
                <Block key={j} b={b} />
              ))}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="rounded-lg border border-line">
      <summary className="cursor-pointer px-2.5 py-1.5 text-[12px] font-medium text-muted">
        {title}
      </summary>
      <div className="border-t border-line p-2.5">{children}</div>
    </details>
  );
}

function Block({ b }: { b: TraceBlock }) {
  const t = useT();
  const body = b.text ?? b.input ?? '';
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="mb-0.5 flex items-center gap-2 font-mono text-[10.5px] text-faint">
        <span>{b.type}</span>
        {b.name && <span className="text-accent">{b.name}</span>}
        {b.chars != null && <span>{t('{n} chars', { n: b.chars })}</span>}
        {b.cacheControl && <span className="text-amber-600">CACHE</span>}
        {b.isError && <span className="text-danger">ERROR</span>}
        {b.truncated && <span className="text-amber-600">{t('truncated')}</span>}
      </div>
      {body && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-bubble/60 p-2 font-mono text-[11.5px] leading-relaxed">
          {body}
        </pre>
      )}
    </div>
  );
}
