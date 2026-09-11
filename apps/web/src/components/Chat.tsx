import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, FolderOpen, MessagesSquare, PanelLeft, PlugZap, Sparkles, WifiOff } from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';
import { useChat } from '../store/chat';
import { useAgents } from '../store/agents';
import { AGENTS } from '../lib/route';
import type { AgentId } from '../lib/protocol';
import { api, fmtMoney, type UsageTotals } from '../lib/api';
import { Message } from './Message';
import { Composer } from './Composer';
import { FilesPanel } from './FilesPanel';
import { SubChatPanel } from './SubChatPanel';
import { fmtTokens } from './ui';
import { SelectionAsk } from './SelectionAsk';

const NEAR_BOTTOM_PX = 120;

function Empty({ agent }: { agent: AgentId }) {
  const t = useT();
  const label = AGENTS.find((a) => a.id === agent)?.label ?? agent;
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-soft">
        <Sparkles size={20} className="text-accent" />
      </div>
      <h1 className="text-[22px] font-semibold tracking-tight">{t('What shall we work on?')}</h1>
      <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-muted">
        {t('Every conversation has its own working directory. {label} can read and write files and run commands in it.', { label })}
      </p>
    </div>
  );
}

/** Block entry when the agent's CLI is missing, rather than failing on the first message */
function Unavailable({ agent, reason }: { agent: AgentId; reason?: string }) {
  const t = useT();
  const label = AGENTS.find((a) => a.id === agent)?.label ?? agent;
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-bubble">
        <PlugZap size={20} className="text-faint" />
      </div>
      <h1 className="text-[18px] font-semibold tracking-tight">{t('{label} is not connected', { label })}</h1>
      <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-muted">
        {reason ?? t('The command-line tool was not found on this machine.')}
      </p>
    </div>
  );
}

/**
 * What this conversation has cost, and on which models.
 *
 * From the server rather than from the messages on screen. It used to add up
 * `message.usage.costUsd` — what the CLI reported spending — so the same conversation showed
 * one number here and a different one, in a different currency, on the usage page. This
 * reads `usage_records` through the price table, which is what the usage page and the quota
 * both read.
 *
 * Cache is its own figure. Folding it into "input" hid the thing most worth seeing: a long
 * conversation is mostly cache reads, at a tenth of the input price or, on Fable, a fortieth.
 */
function SessionTotals() {
  const t = useT();
  const activeId = useChat((s) => s.activeId);
  const streaming = useChat((s) => s.streaming);
  const [data, setData] = useState<{ currency: string; byModel: Array<UsageTotals & { model: string }> } | null>(null);
  const [open, setOpen] = useState(false);

  // Refetched when a turn finishes, which is when the figures change
  useEffect(() => {
    if (!activeId || streaming) return;
    let live = true;
    void api
      .conversationUsage(activeId)
      .then((d) => { if (live) setData(d); })
      .catch(() => {});
    return () => { live = false; };
  }, [activeId, streaming]);

  const rows = data?.byModel ?? [];
  if (rows.length === 0) return null;

  const sum = (pick: (r: UsageTotals) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const input = sum((r) => r.inputTokens);
  const cache = sum((r) => r.cacheReadTokens + r.cacheCreationTokens);
  const output = sum((r) => r.outputTokens);
  const cost = sum((r) => r.costMicro);
  const currency = data?.currency ?? 'USD';

  return (
    <div className="relative hidden shrink-0 sm:block">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('What this conversation has cost')}
        className={clsx(
          'flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-[11px] transition',
          open ? 'border-line-strong text-ink' : 'border-line text-faint hover:text-muted',
        )}
      >
        <span>↑{fmtTokens(input)}</span>
        <span>⛁{fmtTokens(cache)}</span>
        <span>↓{fmtTokens(output)}</span>
        <span>{fmtMoney(cost, currency)}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1.5 w-[340px] rounded-xl border border-line bg-surface p-3 shadow-lg">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-faint">
                <th className="pb-1.5 font-medium">{t('Model')}</th>
                <th className="pb-1.5 text-right font-medium">{t('In')}</th>
                <th className="pb-1.5 text-right font-medium">{t('Cache')}</th>
                <th className="pb-1.5 text-right font-medium">{t('Out')}</th>
                <th className="pb-1.5 text-right font-medium">{t('Cost')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className="border-b border-line last:border-0">
                  <td className="py-1.5 pr-2 font-mono text-[11px] text-muted">
                    {r.model || t('(default)')}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{fmtTokens(r.inputTokens)}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-muted">
                    {fmtTokens(r.cacheReadTokens + r.cacheCreationTokens)}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{fmtTokens(r.outputTokens)}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{fmtMoney(r.costMicro, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Published list prices, seeded into the price table an administrator can edit —
              see the Pricing card in the console */}
          <p className="mt-2 text-[11px] text-faint">{t('Priced from the model price table.')}</p>
        </div>
      )}
    </div>
  );
}

export function Chat({ agent }: { agent: AgentId }) {
  const t = useT();
  const messages = useChat((s) => s.messages);
  const title = useChat((s) => s.title);
  const loading = useChat((s) => s.loading);
  const connected = useChat((s) => s.connected);
  const error = useChat((s) => s.error);
  const dismissError = useChat((s) => s.dismissError);
  const notice = useChat((s) => s.notice);
  const dismissNotice = useChat((s) => s.dismissNotice);
  const showSidebar = useChat((s) => s.showSidebar);
  const sidebarCollapsed = useChat((s) => s.sidebarCollapsed);
  const activeId = useChat((s) => s.activeId);

  const agentInfo = useAgents((s) => s.info(agent));
  const agentsLoaded = useAgents((s) => s.loaded);
  const unavailable = Boolean(agentsLoaded && agentInfo && !agentInfo.availability.available);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const subOpen = useChat((s) => s.subOpen);
  const showThreads = useChat((s) => s.showThreads);
  const closeSub = useChat((s) => s.closeSub);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stick.current = atBottom;
    setShowJump(!atBottom && el.scrollHeight > el.clientHeight + 200);
  };

  // Only auto-follow when the reader was already at the bottom
  useLayoutEffect(() => {
    if (!stick.current) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Jump to the bottom when switching conversation
  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stick.current = true;
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        {/* The drawer's handle on a narrow screen, and the way back from a folded
            sidebar on a wide one — where it is there only while it is folded */}
        <button
          onClick={showSidebar}
          className={clsx(
            'flex size-8 items-center justify-center rounded-md text-muted hover:bg-bubble hover:text-ink',
            !sidebarCollapsed && 'md:hidden',
          )}
          aria-label={t("Open sidebar")}
          title={t("Open sidebar")}
        >
          <PanelLeft size={17} />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-medium">{title || t('New chat')}</h2>
        {!connected && activeId && (
          <span
            className="flex shrink-0 items-center gap-1 text-[11px] text-faint"
            title={t('Event stream dropped — reconnecting')}
          >
            <WifiOff size={12} />
            {t('Reconnecting')}
          </span>
        )}
        {/* The way to a thread that was closed. Threads are not in the sidebar — a thread
            belongs to the conversation it was opened in — so without this the only way to
            one is selecting the same passage, and that opens a second thread rather than
            returning to the first. */}
        {!unavailable && activeId && (
          <button
            onClick={() => (subOpen ? closeSub() : void showThreads())}
            title={t('Threads')}
            aria-label={t('Threads')}
            className={clsx(
              'flex size-8 shrink-0 items-center justify-center rounded-md transition',
              subOpen ? 'bg-bubble text-ink' : 'text-muted hover:bg-bubble hover:text-ink',
            )}
          >
            <MessagesSquare size={16} />
          </button>
        )}
        {!unavailable && activeId && (
          <button
            onClick={() => setFilesOpen((v) => !v)}
            title={t("Workspace files")}
            aria-label={t("Workspace files")}
            className={clsx(
              'flex size-8 shrink-0 items-center justify-center rounded-md transition',
              filesOpen ? 'bg-bubble text-ink' : 'text-muted hover:bg-bubble hover:text-ink',
            )}
          >
            <FolderOpen size={16} />
          </button>
        )}
        <SessionTotals />
      </header>

      {error && (
        <div className="flex items-start gap-2 border-b border-danger/25 bg-danger/8 px-4 py-2 text-[13px] text-danger">
          <span className="flex-1">{error}</span>
          <button onClick={dismissError} className="shrink-0 underline">
            {t('Close')}
          </button>
        </div>
      )}

      {notice && !error && (
        <div className="flex items-start gap-2 border-b border-line bg-bubble px-4 py-2 text-[13px] text-muted">
          <span className="flex-1">{notice}</span>
          <button onClick={dismissNotice} className="shrink-0 underline">
            {t('Close')}
          </button>
        </div>
      )}

      {/*
        The composer is a sibling of the scroll area, not the last thing inside it. Inside,
        it could only be held down with `sticky`, and sticky does nothing until the container
        overflows — so with a few messages on screen the box sat under the last one, halfway
        up the page.
      */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className={clsx('mx-auto w-full max-w-3xl', messages.length === 0 && 'h-full')}>
            {unavailable ? (
              <Unavailable agent={agent} reason={agentInfo?.availability.reason} />
            ) : loading ? (
              <div className="flex h-full items-center justify-center text-[13px] text-faint">
                {t('Loading…')}
              </div>
            ) : messages.length === 0 ? (
              <Empty agent={agent} />
            ) : (
              /* Marks what a selection has to be inside to count as asking about the
                 conversation — see SelectionAsk */
              <div className="py-4" data-transcript>
                {messages.map((m, i) => (
                  /* Retry is offered on the newest answer only: everything after an older
                     one is downstream of it, and discarding that quietly is what editing an
                     older question branches for instead */
                  <Message key={m.id} message={m} isLatest={i === messages.length - 1} />
                ))}
              </div>
            )}
          </div>
        </div>
        {!unavailable && <Composer agent={agent} />}

        {showJump && (
          <button
            onClick={jump}
            className="absolute bottom-32 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-md transition hover:text-ink"
            aria-label={t("Back to bottom")}
          >
            <ArrowDown size={15} />
          </button>
        )}
      </div>
      </div>

      {filesOpen && activeId && (
        <div className="absolute inset-0 z-30 md:static md:z-auto">
          <FilesPanel conversationId={activeId} onClose={() => setFilesOpen(false)} />
        </div>
      )}

      {/* One at a time: both are the same column on a narrow screen, and a thread opened
          while the files are up would otherwise be behind them */}
      {subOpen && !filesOpen && (
        <div className="absolute inset-0 z-30 md:static md:z-auto">
          <SubChatPanel />
        </div>
      )}

      <SelectionAsk />
    </div>
  );
}
