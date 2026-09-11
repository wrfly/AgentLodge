import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useChat } from '../store/chat';
import { Message } from './Message';
import { Button, Spinner } from './ui';

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
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

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
        <h3 className="flex-1 text-[13.5px] font-medium">{t('Thread')}</h3>
        <Button variant="ghost" onClick={closeSub} title={t('Close')}>
          <X size={14} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && streaming ? (
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
    </aside>
  );
}
