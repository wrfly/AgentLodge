import { useState } from 'react';
import { Brain, ChevronRight, CircleAlert, OctagonX } from 'lucide-react';
import clsx from 'clsx';
import { useChat, type ChatMessage, type LiveBlock } from '../store/chat';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { useT } from '../lib/i18n';

function ThinkingBlock({ block }: { block: Extract<LiveBlock, { kind: 'thinking' }> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="fade-up my-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-[12.5px] text-faint hover:text-muted"
      >
        <ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} />
        <Brain size={13} />
        <span className="italic">{block.streaming ? t('Thinking…') : t('Thought process')}</span>
      </button>
      {open && (
        <div className="mt-1.5 border-l-2 border-line pl-3 text-[13.5px] leading-[1.7] whitespace-pre-wrap text-muted italic">
          {block.text || t('(empty)')}
        </div>
      )}
    </div>
  );
}

function UsageFooter({ usage }: { usage: NonNullable<ChatMessage['usage']> }) {
  const t = useT();
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const parts = [
    `↑ ${total.toLocaleString()}`,
    `↓ ${usage.outputTokens.toLocaleString()}`,
    usage.durationMs ? `${(usage.durationMs / 1000).toFixed(1)}s` : null,
    usage.costUsd ? `$${usage.costUsd.toFixed(4)}` : null,
  ].filter(Boolean);

  return (
    <div
      className="mt-2 flex gap-3 font-mono text-[11px] text-faint opacity-0 transition-opacity group-hover/msg:opacity-100"
      title={t('in {in} · cache read {read} · cache write {write} · out {out}', {
        in: usage.inputTokens,
        read: usage.cacheReadTokens,
        write: usage.cacheCreationTokens,
        out: usage.outputTokens,
      })}
    >
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );
}

/** While queued, say what is being waited on — a bare spinner leaves people guessing */
function PendingIndicator() {
  const t = useT();
  const queuePosition = useChat((s) => s.queuePosition);
  return (
    <div className="flex items-center gap-2 py-1 text-[13px] text-faint">
      <span className="inline-flex gap-1">
        <span className="size-1.5 animate-bounce rounded-full bg-faint [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-faint [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-faint" />
      </span>
      {queuePosition > 0
        ? t('Queued — {n} request(s) ahead', { n: queuePosition })
        : t('Thinking')}
    </div>
  );
}

export function Message({ message }: { message: ChatMessage }) {
  const t = useT();
  if (message.role === 'user') {
    const text = message.blocks.map((b) => (b.kind === 'tool_use' ? '' : b.text)).join('');
    return (
      <div className="fade-up flex justify-end px-4 py-2.5">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[15px] leading-[1.7] whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  const empty = message.blocks.length === 0;

  return (
    <div className="group/msg px-4 py-2.5">
      {empty && message.pending && <PendingIndicator />}

      {message.blocks.map((block) => {
        if (block.kind === 'tool_use') return <ToolCard key={block.blockId} block={block} />;
        if (block.kind === 'thinking') return <ThinkingBlock key={block.blockId} block={block} />;
        return (
          <div key={block.blockId} className="fade-up">
            <Markdown text={block.text} />
            {block.streaming && <span className="caret" />}
          </div>
        );
      })}

      {message.error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[13px] text-danger">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap">{message.error}</span>
        </div>
      )}

      {message.aborted && (
        <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-faint">
          <OctagonX size={13} />
          {t('Generation stopped')}
        </div>
      )}

      {message.usage && !message.pending && <UsageFooter usage={message.usage} />}
    </div>
  );
}
