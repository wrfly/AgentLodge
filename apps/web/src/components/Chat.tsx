import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, FolderOpen, PanelLeft, PlugZap, Sparkles, WifiOff } from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';
import { useChat } from '../store/chat';
import { useAgents } from '../store/agents';
import { AGENTS } from '../lib/route';
import type { AgentId } from '../lib/protocol';
import { Message } from './Message';
import { Composer } from './Composer';
import { FilesPanel } from './FilesPanel';

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

function SessionTotals() {
  const t = useT();
  const messages = useChat((s) => s.messages);
  const totals = messages.reduce(
    (acc, m) => {
      if (!m.usage) return acc;
      acc.in += m.usage.inputTokens + m.usage.cacheReadTokens + m.usage.cacheCreationTokens;
      acc.out += m.usage.outputTokens;
      acc.cost += m.usage.costUsd;
      return acc;
    },
    { in: 0, out: 0, cost: 0 },
  );
  if (!totals.in && !totals.out) return null;

  return (
    <div
      className="hidden shrink-0 items-center gap-2 rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-faint sm:flex"
      title={t('Total usage for this conversation')}
    >
      <span>↑{(totals.in / 1000).toFixed(1)}k</span>
      <span>↓{(totals.out / 1000).toFixed(1)}k</span>
      {totals.cost > 0 && <span>${totals.cost.toFixed(3)}</span>}
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
  const setSidebar = useChat((s) => s.setSidebar);
  const activeId = useChat((s) => s.activeId);

  const agentInfo = useAgents((s) => s.info(agent));
  const agentsLoaded = useAgents((s) => s.loaded);
  const unavailable = Boolean(agentsLoaded && agentInfo && !agentInfo.availability.available);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

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
        <button
          onClick={() => setSidebar(true)}
          className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-bubble hover:text-ink md:hidden"
          aria-label={t("Open sidebar")}
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

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto">
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
              <div className="py-4">
                {messages.map((m) => (
                  <Message key={m.id} message={m} />
                ))}
              </div>
            )}
          </div>
          {!unavailable && <Composer agent={agent} />}
        </div>

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
    </div>
  );
}
