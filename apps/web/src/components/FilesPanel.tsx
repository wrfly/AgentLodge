import { useEffect, useRef, useState } from 'react';
import {
  Download,
  File as FileIcon,
  Folder,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';
import { files, type FileEntry, type FilePreview } from '../lib/api';
import { Button, Empty, Spinner } from './ui';
import { CodeBlock } from './CodeBlock';

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function langOf(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python',
    go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php', sh: 'bash',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown',
    html: 'html', css: 'css', sql: 'sql', c: 'c', cpp: 'cpp',
  };
  return ext ? map[ext] : undefined;
}

/**
 * Workspace file panel for a conversation.
 *
 * Whatever the agent writes into its working directory — code, reports, data
 * files — is unreachable without this panel.
 */
export function FilesPanel({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const t = useT();
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [selected, setSelected] = useState<FilePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = async () => {
    setBusy(true);
    try {
      setEntries(await files.list(conversationId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const open = async (e: FileEntry) => {
    if (e.isDirectory) return;
    try {
      setSelected(await files.preview(conversationId, e.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await files.upload(conversationId, Array.from(list));
      setEntries(res.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const del = async (p: string) => {
    setBusy(true);
    try {
      const res = await files.remove(conversationId, p);
      setEntries(res.files);
      if (selected?.path === p) setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-sidebar md:w-[340px]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <h3 className="flex-1 text-[13.5px] font-medium">{t('Workspace files')}</h3>
        <Button variant="ghost" onClick={() => void load()} disabled={busy} title={t('Refresh')}>
          <RefreshCw size={13} />
        </Button>
        <Button variant="ghost" onClick={() => input.current?.click()} disabled={busy} title={t('Upload')}>
          <Upload size={13} />
        </Button>
        <Button variant="ghost" onClick={onClose} title={t('Close')}>
          <X size={14} />
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
      </div>

      {error && (
        <div className="border-b border-danger/25 bg-danger/8 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }}
      >
        {!entries ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <p className="text-[12.5px] text-faint">{t('No files in this conversation yet')}</p>
            <p className="mt-1 text-[11.5px] text-faint">{t('Drop files here to send them to the agent')}</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {entries.map((e) => (
              <div
                key={e.path}
                className={clsx(
                  'group flex items-center gap-2 rounded-lg px-2 py-1.5',
                  selected?.path === e.path ? 'bg-bubble' : 'hover:bg-bubble/60',
                )}
              >
                <button
                  onClick={() => void open(e)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  disabled={e.isDirectory}
                >
                  {e.isDirectory ? (
                    <Folder size={13} className="shrink-0 text-accent" />
                  ) : (
                    <FileIcon size={13} className="shrink-0 text-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{e.path}</span>
                  {!e.isDirectory && (
                    <span className="shrink-0 text-[10.5px] text-faint">{fmtSize(e.size)}</span>
                  )}
                </button>
                {!e.isDirectory && (
                  <div className="flex shrink-0 gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <button
                      onClick={() => void files.download(conversationId, e.path)}
                      title={t("Download")}
                      className="flex size-6 items-center justify-center rounded-md text-faint hover:bg-line-strong hover:text-ink"
                    >
                      <Download size={12} />
                    </button>
                    <button
                      onClick={() => void del(e.path)}
                      title={t("Delete")}
                      className="flex size-6 items-center justify-center rounded-md text-faint hover:bg-line-strong hover:text-danger"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-line p-2">
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
              {selected.path}
            </span>
            <span className="shrink-0 text-[10.5px] text-faint">{fmtSize(selected.size)}</span>
          </div>
          {selected.binary ? (
            <Empty text={t('Binary file — download it to view')} />
          ) : (
            <>
              <CodeBlock code={selected.content ?? ''} lang={langOf(selected.path)} />
              {selected.truncated && (
                <p className="px-1 text-[11px] text-faint">{t('Preview truncated — download for the full contents')}</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-faint">
        {t('The agent can read and write uploaded files directly · 20MB max')}
      </div>
    </aside>
  );
}
