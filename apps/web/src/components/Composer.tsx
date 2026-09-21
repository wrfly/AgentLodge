import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Brain, Clock, Gauge, Paperclip, Sparkle, Square } from 'lucide-react';
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

  /*
   * Something carried over from a thread.
   *
   * Appended rather than replacing, and focused at the end, because the point of landing it
   * here instead of posting it is that the person gets to say what they want done with it.
   */
  const carried = useChat((s) => s.carried);
  const clearCarried = useChat((s) => s.clearCarried);
  useEffect(() => {
    if (!carried) return;
    setValue((v) => (v.trim() ? `${v.replace(/\s+$/, '')}\n\n${carried.text}` : carried.text));
    clearCarried();
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [carried, clearCarried]);

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
  const ensureConversation = useChat((s) => s.ensureConversation);

  const quota = useQuota((s) => s.quota);
  const deferred = useChat((s) => s.deferred);
  const cancelDeferred = useChat((s) => s.cancelDeferred);

  /*
   * Over the ceiling stops the box either way; which of the two it is decides what is said
   * underneath, and `held` is checked first everywhere.
   *
   * They are both true at the same time, and have to be: a held turn exists *because* the
   * quota is exhausted, so `blocked` is still what it always was. Showing the red "ask an
   * administrator" line under a question that is already queued to send itself would be
   * telling somebody to go and do something that has been done.
   */
  const held = Boolean(deferred);
  const blocked = Boolean(quota?.exceeded && quota?.hardStop);

  /**
   * How many more turns of this person's usual size fit in what is left, when that is few
   * enough to be worth saying. Null the rest of the time — a running count of a number
   * nobody is near is noise, and it would push the keyboard hint off every screen.
   *
   * **The fewest turns, across every capped window** — not `quota.tightest`, which was the
   * first thing this used and was wrong. `tightest` is the highest *ratio*, and a ratio
   * says nothing about how many turns fit: a 5-hour ceiling of 1M half spent leaves 500k,
   * while a monthly ceiling of 100M three-fifths spent leaves 40M and the higher ratio. On
   * turns of 250k that is two more against a hundred and sixty — and naming the month
   * would have suppressed the warning exactly where it was needed. The two only agree when
   * every ceiling is the same size.
   */
  const runway = (() => {
    if (!quota || quota.exceeded || !quota.typicalTurn) return null;
    const per = quota.typicalTurn;
    let fewest: { turns: number; scope: QuotaScope } | null = null;
    for (const w of Object.values(quota.windows)) {
      if (w.limit === null || w.remaining === null) continue;
      const turns = Math.floor(w.remaining / per);
      if (!fewest || turns < fewest.turns) fewest = { turns, scope: w.scope };
    }
    return fewest && fewest.turns <= 5 ? fewest : null;
  })();

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

  /*
   * Switching conversation leaves the previous one's attachments behind: they are in that
   * workspace, not this one, and a stale row would name a file the agent cannot see.
   *
   * A draft becoming real is not a switch, though it moves the same value. Attaching a file
   * is one of the two things that create the conversation, so `null → id` arrives in the
   * middle of `attach` — clearing there would drop the rows for the very files being
   * uploaded, leaving nothing on screen and nothing for `submit` to name.
   */
  const wasActive = useRef(activeId);
  useEffect(() => {
    const was = wasActive.current;
    wasActive.current = activeId;
    if (was === null && activeId) return;
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
   *
   * It is also why attaching creates the conversation: the file has to land in a workspace,
   * and a workspace belongs to a row. Uploading is an act, not a look, so the row it needs
   * is a row worth having.
   */
  const attach = async (list: File[], fromPaste = false) => {
    if (!list.length) return;
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
      // Inside the try, so a create that fails marks these rows red like a failed upload
      const id = await ensureConversation();
      // The draft was left behind while this was in the air; the files belong to a
      // conversation nobody is looking at now
      if (!id) {
        const ids = new Set(rows.map((r) => r.id));
        setAttached((prev) => prev.filter((a) => !ids.has(a.id)));
        return;
      }
      const res = await files.upload(id, named);
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
    if (streaming || blocked || held) return;
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

  const canSend = (value.trim().length > 0 || ready.length > 0) && !streaming && !blocked && !held;
  const busyAttaching = attached.some((a) => a.status === 'uploading');
  /**
   * The controls under the box all change the next turn, so none of them moves during one.
   *
   * A missing conversation is no longer a reason to disable them. A draft is where the model
   * and the effort for the first turn get chosen, and the paperclip is one of the two things
   * that bring the conversation into being.
   */
  const locked = streaming;

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
            disabled={blocked || held}
            placeholder={
              held
                ? t('Waiting for the quota window — your question will send itself')
                : blocked
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
                agent !== 'codex' ? (
                  <Brain
                    size={11}
                    className={clsx('shrink-0', thinking ? 'text-accent' : 'text-faint')}
                  />
                ) : undefined
              }
              footer={
                agent !== 'codex' ? (
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

        {deferred ? (
          /*
           * A question that has been taken but has not gone.
           *
           * Amber rather than red: nothing has failed and nothing needs doing. It says the
           * clock time rather than "in 4h 20m" because the person will not be watching
           * this line when it happens — the time is something they can plan around, a
           * countdown is only true while it is on screen.
           *
           * Cancel is beside it and not hidden behind anything. It is the only way back to
           * a composer, and it hands the text over rather than discarding it.
           */
          <div className="mt-1.5 flex items-center justify-center gap-2 text-center text-[11.5px] text-amber-600 dark:text-amber-500">
            <Clock size={12} className="shrink-0" />
            <span>
              {t('Waiting for the {scope} quota — sends at {time}', {
                scope: SCOPE_LABEL[deferred.scope],
                time: new Date(deferred.releaseAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </span>
            <button
              onClick={() => void cancelDeferred()}
              className="underline underline-offset-2 transition hover:text-ink"
            >
              {t('Cancel')}
            </button>
          </div>
        ) : blocked ? (
          <div className="mt-1.5 text-center text-[11.5px] text-danger">
            {(() => {
              // The window that refused is the one to name — "used up" without saying which
              // window sends people to the console to work it out
              const hit = quota && Object.values(quota.windows).find((w) => w.exceeded);
              if (!quota || !hit) return t('Quota used up — ask an administrator');
              const show = (v: number) =>
                fmtMoney(v, quota.currency);
              return t('{scope} quota used up ({used} / {limit}) — ask an administrator', {
                scope: SCOPE_LABEL[hit.scope],
                used: show(hit.used),
                limit: show(hit.limit ?? 0),
              });
            })()}
          </div>
        ) : attachError ? (
          <div className="mt-1.5 text-center text-[11.5px] text-danger">{attachError}</div>
        ) : runway ? (
          /*
           * The one place anything is said *before* a turn rather than after it.
           *
           * Everything else about quota is retrospective: the sidebar bar turns amber at
           * 90%, an email goes out once the turn that crossed the line has already been
           * paid for, and the composer only speaks up once the answer is 402. None of that
           * helps the person about to send a long-context turn at max effort into the last
           * of their month.
           *
           * It is said in turns because that is the unit the person is thinking in. The
           * number of billable tokens left answers nothing on its own — the same figure is
           * two turns for one person and forty for another — so it is divided by what their
           * own recent turns have actually cost. Not an estimate of *this* turn: a turn's
           * cost depends on how many upstream calls the agent decides to make, which nobody
           * knows in advance, and a confident wrong number is worse than an honest rate.
           */
          <div
            className={clsx(
              'mt-1.5 text-center text-[11.5px]',
              runway.turns === 0 ? 'text-danger' : runway.turns <= 2 ? 'text-amber-600 dark:text-amber-500' : 'text-faint',
            )}
          >
            {runway.turns === 0
              ? t('A turn your usual size would not fit in what is left of the {scope} quota', {
                  scope: SCOPE_LABEL[runway.scope],
                })
              : t('About {n} more turns of your usual size before the {scope} quota', {
                  n: runway.turns,
                  scope: SCOPE_LABEL[runway.scope],
                })}
          </div>
        ) : (
          <div className="mt-1.5 text-center text-[11px] text-faint">
            {t('Enter to send · Shift+Enter for a new line')}
          </div>
        )}
      </div>
    </div>
  );
}
