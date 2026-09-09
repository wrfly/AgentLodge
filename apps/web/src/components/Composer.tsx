import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Brain, Gauge, Paperclip, Sparkle, Square } from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';
import { groupByVendor } from '../lib/protocol';
import { useChat } from '../store/chat';
import { useAgents } from '../store/agents';
import { useQuota } from '../store/quota';
import { files, fmtMoney } from '../lib/api';
import { Attachments, type Attachment } from './Attachments';
import { SwitchTrack } from './ui';
import { AGENTS } from '../lib/route';
import type { EffortOption, ModelOption, QuotaScope } from '../lib/api';
import type { AgentId } from '../lib/protocol';
import { Picker } from './Picker';

/** Named so a refusal says which window ran out, not just that one did */
const SCOPE_LABEL: Record<QuotaScope, string> = { window: '5h', week: 'week', month: 'month' };

const MAX_HEIGHT = 240;

/**
 * A stable empty-array reference.
 *
 * zustand v5 compares selector results with Object.is, so writing `?? []`
 * returns a fresh array every time, which reads as a state change: infinite
 * re-render, React unmounts the tree, white screen.
 */
const NO_MODELS: ModelOption[] = [];
const NO_EFFORTS: EffortOption[] = [];

/** What the server's multipart limit accepts in one request */
const MAX_PER_UPLOAD = 10;

/**
 * What a browser calls a bitmap off the clipboard: `image.png`, and nothing more.
 *
 * A file copied in the file manager keeps its real name, and that name is worth keeping —
 * it is what the person will type when they ask about it. So only the generic one is
 * replaced.
 */
const CLIPBOARD_BITMAP = /^image\.[a-z0-9]+$/i;

/**
 * A name for something that arrived without a useful one.
 *
 * The upload route writes by name, so two pasted screenshots in one conversation would be
 * one file. The clock makes them distinct and keeps them recognisable in the listing.
 */
function pastedName(file: File): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? `.${file.type.split('/')[1] ?? 'bin'}`).toLowerCase();
  return `pasted-${stamp}-${Math.random().toString(36).slice(2, 6)}${ext}`;
}

export function Composer({ agent }: { agent: AgentId }) {
  const t = useT();
  const [value, setValue] = useState('');
  const composing = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const agentLabel = AGENTS.find((a) => a.id === agent)?.label ?? agent;

  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const abort = useChat((s) => s.abort);
  const activeId = useChat((s) => s.activeId);

  const model = useChat((s) => s.model);
  const setModel = useChat((s) => s.setModel);
  const effort = useChat((s) => s.effort);
  const setEffort = useChat((s) => s.setEffort);
  const thinking = useChat((s) => s.thinking);
  const setThinking = useChat((s) => s.setThinking);

  const bumpFiles = useChat((s) => s.bumpFiles);

  const quota = useQuota((s) => s.quota);
  const blocked = Boolean(quota?.exceeded && quota?.hardStop);

  const models = useAgents((s) => s.info(agent)?.models) ?? NO_MODELS;
  // vendor → family → version, so two upstreams' worth of names read as two rows
  const modelTree = useMemo(() => groupByVendor(models), [models]);
  const efforts = useAgents((s) => s.info(agent)?.efforts) ?? NO_EFFORTS;

  // Grow to fit the content
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!streaming) ref.current?.focus();
  }, [streaming]);

  // Switching conversation leaves the previous one's attachments behind: they are in that
  // workspace, not this one, and a stale row would name a file the agent cannot see
  useEffect(() => {
    setAttached([]);
    setAttachError(null);
  }, [activeId]);

  /**
   * Put files in the conversation's workspace and hold a row for each.
   *
   * The upload happens now rather than at send, which is what makes a failure visible while
   * there is still something to do about it, and what lets the row show a size. The cost is
   * that a file attached and never sent stays in the workspace — the same as one put there
   * through the files panel, and removable the same way.
   */
  const attach = async (list: File[], fromPaste = false) => {
    if (!activeId || !list.length) return;
    if (list.length > MAX_PER_UPLOAD) {
      setAttachError(t('At most {n} files at a time', { n: MAX_PER_UPLOAD }));
      return;
    }
    setAttachError(null);

    const named = list.map((f) =>
      !f.name || (fromPaste && CLIPBOARD_BITMAP.test(f.name))
        ? new File([f], pastedName(f), { type: f.type })
        : f,
    );
    const rows: Attachment[] = named.map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: f.name,
      size: f.size,
      status: 'uploading',
    }));
    setAttached((prev) => [...prev, ...rows]);

    try {
      const res = await files.upload(activeId, named);
      /*
       * The server decides the final name — it strips separators and leading dots — and
       * that name is what the message will say and what removing one will ask to delete.
       * Its list is in the order the parts arrived, so it lines up with these rows, unless
       * it refused one: then the count differs and there is nothing to line up, so the rows
       * keep the names they were given and the files panel is the place to see what landed.
       */
      const ids = new Set(rows.map((r) => r.id));
      const final = res.uploaded.length === named.length ? res.uploaded : null;
      setAttached((prev) => {
        let n = 0;
        return prev.map((a) =>
          ids.has(a.id) ? { ...a, name: final?.[n++] ?? a.name, status: 'done' as const } : a,
        );
      });
      bumpFiles();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ids = new Set(rows.map((r) => r.id));
      setAttached((prev) => prev.map((a) => (ids.has(a.id) ? { ...a, status: 'error', error: message } : a)));
      setAttachError(message);
    }
  };

  /** Taking a row off also takes the file out of the workspace; a failure only drops the row */
  const detach = async (a: Attachment) => {
    setAttached((prev) => prev.filter((x) => x.id !== a.id));
    if (a.status !== 'done' || !activeId) return;
    try {
      await files.remove(activeId, a.name);
      bumpFiles();
    } catch {
      /* The file stays, the row does not; the panel is where to deal with it */
    }
  };

  const ready = attached.filter((a) => a.status === 'done');

  const submit = () => {
    const text = value.trim();
    if (streaming || blocked) return;
    if (!text && !ready.length) return;
    /*
     * The names go into the message itself. There is no image block on this path — a turn
     * reaches the CLI as a prompt string — so naming the files is what tells the agent they
     * are there, and its working directory is the workspace they landed in, which makes a
     * bare name a path it can open.
     */
    const prompt = ready.length
      ? [text, t('Attached: {files}', { files: ready.map((a) => a.name).join(', ') })]
          .filter(Boolean)
          .join('\n\n')
      : text;
    setValue('');
    setAttached([]);
    setAttachError(null);
    void send(prompt);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an IME is composing is not a send
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (composing.current || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  const canSend = (value.trim().length > 0 || ready.length > 0) && !streaming && !blocked;
  const busyAttaching = attached.some((a) => a.status === 'uploading');
  /** The controls under the box all change the next turn, so none of them moves during one */
  const locked = !activeId || streaming;

  return (
    <div className="pointer-events-none shrink-0 bg-bg pt-3">
      <div className="pointer-events-auto mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragging(true);
          }}
          // Moving onto a child fires dragleave on the parent; without this the box flickers
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDragging(false);
            void attach(Array.from(e.dataTransfer.files));
          }}
          className={clsx(
            'rounded-2xl border bg-surface p-2 shadow-sm transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-line-strong focus-within:border-accent/50',
          )}
        >
          <Attachments items={attached} onRemove={(a) => void detach(a)} />
          <textarea
            ref={ref}
            value={value}
            rows={1}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onPaste={(e) => {
              // Only when the clipboard actually carries a file. Copying an image out of a
              // web page brings both a file and its markup, and text has to keep winning.
              const list = Array.from(e.clipboardData.files);
              if (!list.length) return;
              e.preventDefault();
              void attach(list, true);
            }}
            disabled={blocked}
            placeholder={
              blocked
                ? t('Quota is used up — you cannot start a new conversation')
                : streaming
                  ? t('Generating…')
                  : t('Message {agent}', { agent: agentLabel })
            }
            className="max-h-60 w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-[1.6] outline-none placeholder:text-faint"
          />

          {/* Controls share the row with the send button, under the box. Next to the
              title they were too easy to miss — nothing said they were clickable. */}
          <div className="mt-1 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={locked || busyAttaching}
              title={t('Attach files — paste or drop them here too')}
              aria-label={t('Attach files — paste or drop them here too')}
              className={clsx(
                'flex size-[26px] shrink-0 items-center justify-center rounded-lg border transition',
                locked || busyAttaching
                  ? 'cursor-not-allowed border-line text-faint'
                  : 'border-line text-muted hover:border-line-strong hover:bg-bubble hover:text-ink',
              )}
            >
              <Paperclip size={13} />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void attach(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <Picker
              icon={Sparkle}
              placeholder={t("Model")}
              value={model}
              options={models}
              vendors={modelTree}
              onChange={(id) => void setModel(id)}
              title={t("Switch model (affects later messages only)")}
              disabled={locked}
            />
            {/*
              The thinking switch rides in the effort menu rather than beside it. Both
              answer the same question — how much reasoning to ask for — and one of them
              was a whole button in the row for a single boolean.

              Claude only. Codex asks for its reasoning through the effort list itself
              (its `none`), and a switch that did nothing would be worse than none.
            */}
            <Picker
              icon={Gauge}
              placeholder={t("Effort")}
              value={effort}
              options={efforts}
              onChange={(id) => void setEffort(id)}
              title={t("Reasoning effort (affects later messages only)")}
              disabled={locked}
              mark={
                agent === 'claude' ? (
                  <Brain
                    size={11}
                    className={clsx('shrink-0', thinking ? 'text-accent' : 'text-faint')}
                  />
                ) : undefined
              }
              footer={
                agent === 'claude' ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={thinking}
                    onClick={() => void setThinking(!thinking)}
                    title={t('Show the thinking before the answer (affects later messages only)')}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated"
                  >
                    <Brain
                      size={13}
                      className={clsx('shrink-0', thinking ? 'text-accent' : 'text-faint')}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                      {t('Show thinking')}
                    </span>
                    <SwitchTrack checked={thinking} />
                  </button>
                ) : undefined
              }
            />

            <div className="flex-1" />

            {streaming ? (
              <button
                onClick={() => void abort()}
                title={t("Stop generating")}
                aria-label={t("Stop generating")}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bubble text-ink transition hover:bg-line-strong"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend}
                title={t("Send")}
                aria-label={t("Send")}
                className={clsx(
                  'flex size-8 shrink-0 items-center justify-center rounded-lg transition',
                  canSend
                    ? 'bg-accent text-white hover:opacity-90'
                    : 'cursor-not-allowed bg-bubble text-faint',
                )}
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>

        {blocked ? (
          <div className="mt-1.5 text-center text-[11.5px] text-danger">
            {(() => {
              // The window that refused is the one to name — "used up" without saying which
              // window sends people to the console to work it out
              const hit = quota && Object.values(quota.windows).find((w) => w.exceeded);
              if (!quota || !hit) return t('Quota used up — ask an administrator');
              const show = (v: number) =>
                quota.limitKind === 'cost' ? fmtMoney(v, quota.currency) : v.toLocaleString();
              return t('{scope} quota used up ({used} / {limit}) — ask an administrator', {
                scope: SCOPE_LABEL[hit.scope],
                used: show(hit.used),
                limit: show(hit.limit ?? 0),
              });
            })()}
          </div>
        ) : attachError ? (
          <div className="mt-1.5 text-center text-[11.5px] text-danger">{attachError}</div>
        ) : (
          <div className="mt-1.5 text-center text-[11px] text-faint">
            {t('Enter to send · Shift+Enter for a new line')}
          </div>
        )}
      </div>
    </div>
  );
}
