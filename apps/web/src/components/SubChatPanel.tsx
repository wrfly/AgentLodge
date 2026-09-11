import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CornerDownLeft, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useChat } from '../store/chat';
import { DEFAULT_QUESTION } from './SelectionAsk';
import { Message } from './Message';
import { Button, Empty, Spinner, fmtDate } from './ui';

/**
 * A thread on a passage, beside the conversation instead of inside it.
 *
 * The reason it is a panel and not a message: asking "what does this mean" about something
 * said twenty turns ago is a detour, and taking a detour in the main transcript leaves the
 * transcript about the detour. Here the answer sits next to the passage that prompted it and
 * the conversation underneath is unchanged.
 *
 * It shares the parent's workspace and CLI session, so it can read the same files and knows
 * what was said before it — see `rootOf` on the server. What it does not share is the
 * transcript: nothing asked here appears over there.
 */
export function SubChatPanel() {
  const t = useT();
  const messages = useChat((s) => s.subMessages);
  const streaming = useChat((s) => s.subStreaming);
  const conversationId = useChat((s) => s.subConversationId);
  const sendSub = useChat((s) => s.sendSub);
  const closeSub = useChat((s) => s.closeSub);
  const threads = useChat((s) => s.threads);
  const quote = useChat((s) => s.subQuote);
  const openSub = useChat((s) => s.openSub);
  const showThreads = useChat((s) => s.showThreads);
  const openThread = useChat((s) => s.openThread);
  const [draft, setDraft] = useState('');
  const [question, setQuestion] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  // Pre-filled rather than blank: the default is what most people mean, and editing a
  // sentence is less work than writing one
  useEffect(() => {
    if (quote) setQuestion(t(DEFAULT_QUESTION));
  }, [quote, t]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft('');
    void sendSub(text);
  };

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-sidebar md:w-[380px]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        {/* Back to the list rather than out of the panel: a thread is one of several, and
            the way to the others is the list it came from */}
        {conversationId && (
          <Button variant="ghost" onClick={() => void showThreads()} title={t('All threads')}>
            <ArrowLeft size={14} />
          </Button>
        )}
        <h3 className="flex-1 text-[13.5px] font-medium">
          {quote ? t('Ask about this') : conversationId ? t('Thread') : t('Threads')}
        </h3>
        <Button variant="ghost" onClick={closeSub} title={t('Close')}>
          <X size={14} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {quote ? (
          <div className="p-3">
            <div className="mb-3 max-h-48 overflow-y-auto border-l-2 border-accent/50 pl-3 text-[13px] leading-[1.6] whitespace-pre-wrap text-muted">
              {quote}
            </div>
            <textarea
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (question.trim()) void openSub(quote, question);
                }
              }}
              rows={3}
              placeholder={t('What do you want to know about it?')}
              className="w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-[14px] leading-[1.6] outline-none focus:border-line-strong"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" onClick={closeSub}>{t('Cancel')}</Button>
              <Button onClick={() => question.trim() && void openSub(quote, question)} disabled={!question.trim()}>
                {t('Ask')}
              </Button>
            </div>
          </div>
        ) : !conversationId && !streaming ? (
          threads.length === 0 ? (
            <Empty text={t('No threads yet. Select a passage in the conversation to start one.')} />
          ) : (
            <div className="p-2">
              {threads.map((th) => (
                <button
                  key={th.id}
                  onClick={() => void openThread(th.id)}
                  className="mb-1 flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-bubble"
                >
                  <span className="line-clamp-2 text-[13px] leading-[1.5]">{th.about}</span>
                  <span className="text-[11px] text-faint">
                    {t('{n} messages', { n: th.messageCount })} · {fmtDate(th.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : messages.length === 0 && streaming ? (
          <div className="py-8">
            <Spinner />
          </div>
        ) : (
          <div className="py-2">
            {messages.map((m) => (
              <Message key={m.id} message={m} inThread />
            ))}
          </div>
        )}
        <div ref={bottom} />
      </div>

      {conversationId && (
      <div className="shrink-0 border-t border-line p-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface px-2.5 py-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={Math.min(draft.split('\n').length, 6)}
            placeholder={t('Ask about this')}
            // Nothing can be asked until the thread exists: its first question is the
            // selection, and it is on its way
            disabled={!conversationId}
            className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[14px] leading-[1.6] outline-none disabled:opacity-50"
          />
          <Button variant="ghost" onClick={send} disabled={!draft.trim() || streaming || !conversationId}>
            <CornerDownLeft size={14} />
          </Button>
        </div>
      </div>
      )}
    </aside>
  );
}
