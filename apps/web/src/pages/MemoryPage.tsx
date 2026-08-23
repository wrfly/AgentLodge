import { useEffect, useState } from 'react';
import { Plus, Trash2, Undo2 } from 'lucide-react';
import { me, type MemoryDoc, type MemoryRecord } from '../lib/api';
import { Banner, Button, Card, Page, Spinner, fmtDate } from '../components/ui';
import { useT } from '../lib/i18n';

/**
 * Memory.
 *
 * The store is a directory of one fact per file, which the agent writes itself during a
 * conversation. This page is a window on it: read what it learned, correct it, add
 * something it could not have known, take back the last change.
 */
export function MemoryPage() {
  const t = useT();
  const [doc, setDoc] = useState<MemoryDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; body: string }>({ title: '', body: '' });

  const load = async () => setDoc(await me.memory());

  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startNew = () => {
    setEditing('');
    setDraft({ title: '', body: '' });
  };

  const startEdit = (r: MemoryRecord) => {
    setEditing(r.file);
    setDraft({ title: r.title, body: r.body });
  };

  const save = () =>
    run(async () => {
      if (!draft.title.trim() || !draft.body.trim()) return;
      await me.saveMemory({ file: editing || undefined, title: draft.title, body: draft.body });
      setEditing(null);
      await load();
    });

  const remove = (file: string) =>
    run(async () => {
      await me.deleteMemory(file);
      if (editing === file) setEditing(null);
      await load();
    });

  const undo = () =>
    run(async () => {
      await me.undoMemory();
      setEditing(null);
      await load();
    });

  if (!doc && !error) return <Spinner />;

  const records = doc?.records ?? [];
  const full = records.length >= (doc?.maxRecords ?? 0);

  return (
    <Page
      title={t('Memory')}
      subtitle={t('The assistant writes this as you talk, and reads it at the start of every conversation. Correct anything here, or add something it could not have picked up.')}
      actions={
        <>
          {doc?.lastChange && (
            <>
              <span className="self-center text-[12px] text-faint">
                {t('last changed by {who}, {when}', {
                  who: doc.lastChange.by === 'user' ? t('you') : t('the assistant'),
                  when: fmtDate(doc.lastChange.at),
                })}
              </span>
              <Button onClick={() => void undo()} disabled={busy}>
                <Undo2 size={13} />
                {t('Undo it')}
              </Button>
            </>
          )}
          <Button variant="primary" onClick={startNew} disabled={busy || full || editing === ''}>
            <Plus size={13} />
            {t('Add')}
          </Button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      {full && <Banner tone="warn">{t('At most {n} memories — delete one to add another', { n: doc?.maxRecords ?? 0 })}</Banner>}

      {editing === '' && (
        <Editor
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          maxBytes={doc?.maxBytes ?? 0}
          onSave={() => void save()}
          onCancel={() => setEditing(null)}
        />
      )}

      {records.length === 0 && editing !== '' && (
        <Card title={t('Nothing remembered yet')}>
          <p className="text-[13px] leading-relaxed text-muted">
            {t('Tell the assistant something worth keeping — how you want answers written, what you are building — and it records it on its own. You can also add one here.')}
          </p>
        </Card>
      )}

      {records.map((r) =>
        editing === r.file ? (
          <Editor
            key={r.file}
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            maxBytes={doc?.maxBytes ?? 0}
            onSave={() => void save()}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Card
            key={r.file}
            title={r.title}
            description={r.hook || undefined}
            actions={
              <div className="flex items-center gap-2">
                <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-faint">{r.type}</span>
                <Button onClick={() => startEdit(r)} disabled={busy}>
                  {t('Edit')}
                </Button>
                <Button onClick={() => void remove(r.file)} disabled={busy}>
                  <Trash2 size={13} />
                </Button>
              </div>
            }
          >
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{r.body}</div>
            {r.updatedAt && (
              <div className="mt-2 text-[11.5px] text-faint">{t('updated {when}', { when: fmtDate(r.updatedAt) })}</div>
            )}
          </Card>
        ),
      )}

    </Page>
  );
}

function Editor({
  draft,
  setDraft,
  busy,
  maxBytes,
  onSave,
  onCancel,
}: {
  draft: { title: string; body: string };
  setDraft: (d: { title: string; body: string }) => void;
  busy: boolean;
  maxBytes: number;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const bytes = new TextEncoder().encode(draft.body).length;
  const over = bytes > maxBytes;

  return (
    <Card title={t('Memory')}>
      <input
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        placeholder={t('A short name, e.g. “Deploys with podman”')}
        className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent/60"
      />
      <textarea
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        spellCheck={false}
        rows={6}
        placeholder={t('What should be remembered, and when it applies.')}
        className="mt-2 w-full resize-y rounded-lg border border-line bg-bg p-3 text-[13px] leading-[1.7] outline-none focus:border-accent/60"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-faint">
          {over && <span className="text-danger">{t('over the limit')}</span>}
        </span>
        <div className="flex gap-2">
          <Button onClick={onCancel} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onSave}
            loading={busy}
            disabled={over || !draft.title.trim() || !draft.body.trim()}
          >
            {t('Save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
