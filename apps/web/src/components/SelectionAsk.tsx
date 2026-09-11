import { useEffect, useState } from 'react';
import { MessageSquareQuote } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useChat } from '../store/chat';

/** Long enough to be a passage rather than a stray click */
const MIN_CHARS = 2;
/** What the server is handed. A whole essay selected by accident is not a question. */
const MAX_CHARS = 4000;

interface At {
  text: string;
  x: number;
  y: number;
}

/**
 * The button that appears over a selection inside the transcript.
 *
 * Positioned against the viewport and rendered fixed, because the transcript scrolls under
 * it and a button anchored to the document would drift off the passage it belongs to.
 *
 * Only selections inside `[data-transcript]` count: highlighting the composer, the sidebar or
 * the panel's own messages is not asking a question about the conversation.
 */
export function SelectionAsk() {
  const t = useT();
  const [at, setAt] = useState<At | null>(null);
  const openSub = useChat((s) => s.openSub);
  const activeId = useChat((s) => s.activeId);

  useEffect(() => {
    const read = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!sel || sel.rangeCount === 0 || text.length < MIN_CHARS) return setAt(null);

      const range = sel.getRangeAt(0);
      const host = range.commonAncestorContainer;
      const el = host.nodeType === Node.ELEMENT_NODE ? (host as Element) : host.parentElement;
      if (!el?.closest('[data-transcript]')) return setAt(null);

      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return setAt(null);
      setAt({ text: text.slice(0, MAX_CHARS), x: r.left + r.width / 2, y: r.top });
    };

    // `selectionchange` fires mid-drag, so the button would jump around while selecting;
    // the pointer and key events are the moments a selection is finished
    // Clicking away clears the selection without either of the others firing in every browser
    const cleared = () => {
      if (!window.getSelection()?.toString().trim()) setAt(null);
    };
    document.addEventListener('mouseup', read);
    document.addEventListener('keyup', read);
    document.addEventListener('selectionchange', cleared);
    return () => {
      document.removeEventListener('mouseup', read);
      document.removeEventListener('keyup', read);
      document.removeEventListener('selectionchange', cleared);
    };
  }, []);

  if (!at || !activeId) return null;

  return (
    <button
      onMouseDown={(e) => e.preventDefault()} // keep the selection alive through the click
      onClick={() => {
        void openSub(at.text);
        window.getSelection()?.removeAllRanges();
        setAt(null);
      }}
      style={{ left: at.x, top: Math.max(at.y - 38, 8) }}
      className="fixed z-40 -translate-x-1/2 flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[12.5px] shadow-lg transition hover:border-accent"
    >
      <MessageSquareQuote size={13} className="text-accent" />
      {t('Ask about this')}
    </button>
  );
}
