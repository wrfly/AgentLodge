import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Gauge, Sparkle, Square } from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';
import { useChat } from '../store/chat';
import { useAgents } from '../store/agents';
import { useQuota } from '../store/quota';
import { fmtMoney } from '../lib/api';
import { AGENTS } from '../lib/route';
import type { EffortOption, ModelOption } from '../lib/api';
import type { AgentId } from '../lib/protocol';
import { Picker } from './Picker';

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

export function Composer({ agent }: { agent: AgentId }) {
  const t = useT();
  const [value, setValue] = useState('');
  const composing = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const agentLabel = AGENTS.find((a) => a.id === agent)?.label ?? agent;

  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const abort = useChat((s) => s.abort);
  const activeId = useChat((s) => s.activeId);

  const model = useChat((s) => s.model);
  const setModel = useChat((s) => s.setModel);
  const effort = useChat((s) => s.effort);
  const setEffort = useChat((s) => s.setEffort);

  const quota = useQuota((s) => s.quota);
  const blocked = Boolean((quota?.exceeded || quota?.expired) && quota?.hardStop);

  const models = useAgents((s) => s.info(agent)?.models) ?? NO_MODELS;
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

  const submit = () => {
    const text = value.trim();
    if (!text || streaming || blocked) return;
    setValue('');
    void send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an IME is composing is not a send
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (composing.current || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  const canSend = value.trim().length > 0 && !streaming && !blocked;

  return (
    <div className="pointer-events-none sticky bottom-0 bg-gradient-to-t from-bg via-bg to-transparent pt-6">
      <div className="pointer-events-auto mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="rounded-2xl border border-line-strong bg-surface p-2 shadow-sm transition-colors focus-within:border-accent/50">
          <textarea
            ref={ref}
            value={value}
            rows={1}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
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
            <Picker
              icon={Sparkle}
              placeholder={t("Model")}
              value={model}
              options={models}
              onChange={(id) => void setModel(id)}
              title={t("Switch model (affects later messages only)")}
              allowCustom
              customPlaceholder="Custom model name — press Enter"
              disabled={!activeId || streaming}
            />
            <Picker
              icon={Gauge}
              placeholder={t("Effort")}
              value={effort}
              options={efforts}
              onChange={(id) => void setEffort(id)}
              title={t("Reasoning effort (affects later messages only)")}
              disabled={!activeId || streaming}
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
            {quota?.expired
              ? t('Your quota period has ended — ask an administrator to top it up')
              : quota?.limitKind === 'cost'
                ? t('Quota used up ({used} / {limit}) — ask an administrator', {
                    used: fmtMoney(quota.usedMicro, quota.currency),
                    limit: fmtMoney(quota.costLimitMicro, quota.currency),
                  })
                : t('Quota used up ({used} / {limit}) — ask an administrator', {
                    used: quota?.used.toLocaleString() ?? '',
                    limit: quota?.limit?.toLocaleString() ?? '',
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
