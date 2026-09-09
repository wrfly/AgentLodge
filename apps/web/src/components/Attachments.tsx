import { FileText, Image as ImageIcon, Loader2, X } from 'lucide-react';
import clsx from 'clsx';
import { useT } from '../lib/i18n';
import { fmtSize } from './ui';

/**
 * A file the composer is holding for the next message.
 *
 * It is already in the workspace by the time it appears here: uploading on attach rather
 * than on send is what lets the row show progress and a failure, and it is the same place
 * the files panel puts things, so the agent reads them the same way.
 */
export interface Attachment {
  /** Local, so a row survives its name changing under it */
  id: string;
  /** The name in the workspace, which is what the message will say */
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

const isImage = (name: string) => /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i.test(name);

export function Attachments({
  items,
  onRemove,
}: {
  items: Attachment[];
  onRemove: (a: Attachment) => void;
}) {
  const t = useT();
  if (!items.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      {items.map((a) => {
        const Icon = a.status === 'uploading' ? Loader2 : isImage(a.name) ? ImageIcon : FileText;
        return (
          <span
            key={a.id}
            title={a.error ?? a.name}
            className={clsx(
              'group/att flex max-w-[15rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px]',
              a.status === 'error'
                ? 'border-danger/40 bg-danger/8 text-danger'
                : 'border-line bg-elevated text-muted',
            )}
          >
            <Icon size={12} className={clsx('shrink-0', a.status === 'uploading' && 'animate-spin')} />
            <span className="truncate">{a.name}</span>
            {a.status === 'done' && (
              <span className="shrink-0 text-[10.5px] text-faint">{fmtSize(a.size)}</span>
            )}
            <button
              type="button"
              onClick={() => onRemove(a)}
              aria-label={t('Remove attachment')}
              className="shrink-0 rounded text-faint transition hover:text-ink"
            >
              <X size={11} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
