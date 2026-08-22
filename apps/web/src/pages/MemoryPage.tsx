import { useEffect, useRef, useState } from 'react';
import { Brain, RotateCcw, Save } from 'lucide-react';
import { me, type MemoryDoc } from '../lib/api';
import { Banner, Button, Card, Page, Spinner, fmtDate } from '../components/ui';
import { useT } from '../lib/i18n';

/**
 * Memory editor.
 *
 * Stores MEMORY.md in the user's working directory and mirrors it to CLAUDE.md
 * and AGENTS.md, which each CLI picks up through its own native mechanism — no
 * prompt stitching involved.
 */
export function MemoryPage() {
  const t = useT();
  const [doc, setDoc] = useState<MemoryDoc | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const d = await me.memory();
        setDoc(d);
        setContent(d.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const dirty = doc !== null && content !== doc.content;
  const bytes = new TextEncoder().encode(content).length;
  const overLimit = doc !== null && bytes > doc.maxBytes;

  const save = async () => {
    if (!dirty || overLimit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await me.saveMemory(content);
      setDoc((d) => (d ? { ...d, content, stats: res.stats } : d));
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const res = await me.resetMemory();
      setContent(res.content);
      setDoc((d) => (d ? { ...d, content: res.content } : d));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl+S to save
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
  };

  if (!doc && !error) return <Spinner />;

  return (
    <Page
      title={t('Memory')}
      subtitle={t('Whatever you write here is picked up by both Claude Code and Codex at the start of every conversation')}
      actions={
        <>
          <Button onClick={() => void reset()} disabled={saving}>
            <RotateCcw size={13} />
            {t('Restore template')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || overLimit}>
            <Save size={13} />
            {dirty ? t('Save') : t('Saved')}
          </Button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      {savedAt && !dirty && <Banner tone="success">{t('Saved — it takes effect on the next turn')}</Banner>}

      <Card
        title="MEMORY.md"
        description={t('Markdown. Write what you want remembered for the long run: who you are, technical preferences, project background, tone.')}
      >
        <textarea
          ref={ta}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          rows={22}
          className="w-full resize-y rounded-lg border border-line bg-bg p-3 font-mono text-[13px] leading-[1.7] outline-none focus:border-accent/60"
          placeholder={t('# About me\nI am…')}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-faint">
          <span>
            {t('{used} / {max} bytes', { used: bytes.toLocaleString(), max: doc?.maxBytes.toLocaleString() ?? '' })}
            {overLimit && <span className="ml-1 text-danger">{t('over the limit')}</span>}
            {doc?.stats.updatedAt && ` · ${t('updated {when}', { when: fmtDate(doc.stats.updatedAt) })}`}
          </span>
          <span>{t('⌘S / Ctrl+S to save')}</span>
        </div>
      </Card>

      <Card title={t('How it takes effect')}>
        <div className="space-y-2 text-[13px] leading-relaxed text-muted">
          <p className="flex items-start gap-2">
            <Brain size={14} className="mt-0.5 shrink-0 text-accent" />
            <span>
              {t('The text is written into your working directory:')}
              <code className="mx-1 rounded border border-line bg-elevated px-1 py-0.5 font-mono text-[12px]">
                MEMORY.md
              </code>
              {t(', and mirrored to')}
              <code className="mx-1 rounded border border-line bg-elevated px-1 py-0.5 font-mono text-[12px]">
                CLAUDE.md
              </code>
              {t('and')}
              <code className="mx-1 rounded border border-line bg-elevated px-1 py-0.5 font-mono text-[12px]">
                AGENTS.md
              </code>
              。
            </span>
          </p>
          <p>
            {t('A conversation works in a subdirectory of these, and both CLIs walk upward to load them. So this is not prompt injection: it costs no conversation history, and an edit applies from the next turn.')}
          </p>
          <p className="text-faint">
            {t('Note that it applies to every conversation, on both the Claude and Codex sides. Writing a lot of it eats into each turn\'s context budget.')}
          </p>
        </div>
      </Card>
    </Page>
  );
}
