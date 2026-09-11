import { memo, useState } from 'react';
import { Brain, ChevronRight, CircleAlert, CornerUpLeft, OctagonX, Pencil, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { useChat, type ChatMessage, type LiveBlock } from '../store/chat';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { Button } from './ui';
import { useT } from '../lib/i18n';
import { StreamingContext } from '../lib/streaming';

/**
 * The thinking, or what there is of it.
 *
 * A subscription does not return the reasoning — every delta arrives empty with a token
 * count beside it — so with no text there is nothing to expand and the line says how much
 * thinking there was. An upstream that does return it keeps the panel it always had.
 */
function ThinkingBlock({ block }: { block: Extract<LiveBlock, { kind: 'thinking' }> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const n = block.tokens ? block.tokens.toLocaleString() : '';

  const label = block.streaming
    ? n
      ? t('Thinking… ~{n} tokens', { n })
      : t('Thinking…')
    : block.text
      ? t('Thought process')
      : n
        ? t('Thought for ~{n} tokens', { n })
        : t('Thought process');

  const line = (
    <>
      <Brain size={13} />
      <span className="italic">{label}</span>
    </>
  );

  if (!block.text) {
    return (
      <div className="fade-up my-2 flex items-center gap-1.5 py-0.5 pl-[18px] text-[12.5px] text-faint">
        {line}
      </div>
    );
  }

  return (
    <div className="fade-up my-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-[12.5px] text-faint hover:text-muted"
      >
        <ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} />
        {line}
      </button>
      {open && (
        <div className="mt-1.5 border-l-2 border-line pl-3 text-[13.5px] leading-[1.7] whitespace-pre-wrap text-muted italic">
          {block.text}
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
      // No margin of its own: the row it sits in owns the spacing, and a `mt-2` here pushed
      // the figures half a line below the buttons beside them
      className="flex gap-3 font-mono text-[11.5px] text-faint opacity-0 transition-opacity group-hover/msg:opacity-100"
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

/**
 * A question, and the two things you can do to one you have already asked.
 *
 * Editing is not one action. Correcting the newest question means the answer was to the
 * wrong question, so it goes and the corrected one is asked in its place; editing something
 * from several turns back is a different path from that point, and the exchanges after it
 * happened — so that branches into its own conversation rather than deleting them. Which of
 * the two it is follows from the position, so it is not a choice anybody is asked to make;
 * the button says which one it will be.
 */
function UserMessage({ message, inThread }: { message: ChatMessage; inThread: boolean }) {
  const t = useT();
  const text = message.blocks.map((b) => (b.kind === 'tool_use' ? '' : b.text)).join('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const editMessage = useChat((s) => s.editMessage);
  const streaming = useChat((s) => s.streaming);
  const isLastQuestion = useChat(
    (s) => [...s.messages].reverse().find((m) => m.role === 'user')?.id === message.id,
  );
  /*
   * The newest question only.
   *
   * Editing an older one used to branch the conversation, and the semantics did not survive
   * having a workspace: the agent had spent those turns writing files, and none of it can be
   * rewound, so a branch at turn three was a conversation looking at turn ten's directory.
   * Asking about an older passage is what a thread is for.
   *
   * Also not in the thread panel, where `editMessage` would act on the conversation the page
   * is on rather than the one being read.
   */
  const savable = isLastQuestion && !inThread && !message.id.startsWith('local-');

  const save = async () => {
    const next = draft.trim();
    if (!next || next === text) return setEditing(false);
    setBusy(true);
    await editMessage(message.id, next);
    setBusy(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="fade-up flex justify-end px-4 py-2.5">
        <div className="w-full max-w-[85%] rounded-2xl border border-line-strong bg-surface p-2.5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
            }}
            rows={Math.min(draft.split('\n').length + 1, 12)}
            className="w-full resize-none bg-transparent text-[15px] leading-[1.7] outline-none"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-faint">
              {t('Replaces the answer below')}
            </span>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button onClick={() => void save()} disabled={busy || !draft.trim()}>
              {t('Send')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group/msg fade-up flex justify-end px-4 py-2.5">
      <div className="flex max-w-[85%] flex-col items-end">
        <div className="rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[15px] leading-[1.7] whitespace-pre-wrap">
          {text}
        </div>
        {savable && !streaming && (
          <button
            onClick={() => { setDraft(text); setEditing(true); }}
            title={t('Edit and ask again')}
            className="mt-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-faint opacity-0 transition hover:text-muted group-hover/msg:opacity-100"
          >
            <Pencil size={11} />
            {t('Edit')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Take a thread's answer back to the conversation it came from.
 *
 * A thread is isolated: nothing asked in one reaches the main transcript or the model's
 * context there. Most of them are a passing question and that is exactly right. The ones
 * that turn out to matter need a way across, and the person who has just read the answer is
 * the one who knows which — so it lands in the composer, to be cut down and sent with
 * whatever they want done about it, rather than being posted over their head.
 */
function CarryButton({ message }: { message: ChatMessage }) {
  const t = useT();
  const carryIntoChat = useChat((s) => s.carryIntoChat);
  const closeSub = useChat((s) => s.closeSub);
  const text = message.blocks
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .join('')
    .trim();
  if (!text) return null;
  return (
    <button
      onClick={() => {
        carryIntoChat(`${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`);
        closeSub();
      }}
      title={t('Put this in the message box, to send on to the conversation')}
      className="flex items-center gap-1 text-[11.5px] text-faint opacity-0 transition hover:text-muted group-hover/msg:opacity-100"
    >
      <CornerUpLeft size={11} />
      {t('Take back')}
    </button>
  );
}

/**
 * Ask the last question again.
 *
 * Offered on the newest answer only: everything after an older one is downstream of it, and
 * silently discarding that is what the branch is for.
 */
function RetryButton() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const retry = useChat((s) => s.retry);
  return (
    <button
      onClick={() => { setBusy(true); void retry().finally(() => setBusy(false)); }}
      disabled={busy}
      title={t('Answer again')}
      className="flex items-center gap-1 text-[11.5px] text-faint opacity-0 transition hover:text-muted group-hover/msg:opacity-100 disabled:opacity-40"
    >
      <RotateCcw size={11} />
      {t('Retry')}
    </button>
  );
}

/**
 * Memoised on the message object. The store clones only the message a frame touched
 * (chat.ts, _applyBatch), so every earlier message arrives here as the same object as
 * last time and is skipped — without this, each delta re-rendered the whole transcript.
 */
export const Message = memo(function Message({
  message,
  isLatest = false,
  /** Rendered in the thread panel, where the affordances would act on the wrong conversation */
  inThread = false,
}: {
  message: ChatMessage;
  isLatest?: boolean;
  inThread?: boolean;
}) {
  const t = useT();
  if (message.role === 'user') return <UserMessage message={message} inThread={inThread} />;

  const empty = message.blocks.length === 0;

  return (
    <div className="group/msg px-4 py-2.5">
      {empty && message.pending && <PendingIndicator />}

      {message.blocks.map((block) => {
        if (block.kind === 'tool_use') return <ToolCard key={block.blockId} block={block} />;
        if (block.kind === 'thinking') return <ThinkingBlock key={block.blockId} block={block} />;
        return (
          <div key={block.blockId} className="fade-up">
            <StreamingContext.Provider value={block.streaming}>
              <Markdown text={block.text} />
            </StreamingContext.Provider>
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

      <div className="mt-2 flex items-center gap-3">
        {message.usage && !message.pending && <UsageFooter usage={message.usage} />}
        {isLatest && !message.pending && !inThread && <RetryButton />}
        {inThread && !message.pending && <CarryButton message={message} />}
      </div>
    </div>
  );
});
