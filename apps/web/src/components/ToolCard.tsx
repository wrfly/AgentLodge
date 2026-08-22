import { useState } from 'react';
import { ChevronRight, CircleAlert, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { LiveToolBlock } from '../store/chat';
import { resultSummary, toolIcon, toolSummary } from '../lib/tools';
import { useT } from '../lib/i18n';

const MAX_PREVIEW = 4000;

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line px-3 py-2.5">
      <div className="mb-1.5 text-[10.5px] font-medium tracking-wider text-faint uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function Pre({ text, tone = 'normal' }: { text: string; tone?: 'normal' | 'add' | 'del' }) {
  const t = useT();
  return (
    <pre
      className={clsx(
        'max-h-72 overflow-auto rounded-lg px-2.5 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all',
        tone === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        tone === 'del' && 'bg-red-500/10 text-red-700 dark:text-red-300',
        tone === 'normal' && 'bg-bg text-muted',
      )}
    >
      {text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n… ${t('(truncated)')}` : text}
    </pre>
  );
}

function InputView({ name, input }: { name: string; input: unknown }) {
  const i = (input ?? {}) as Record<string, unknown>;

  if ((name === 'Bash' || name === 'Shell') && typeof i.command === 'string') {
    return <Pre text={i.command} />;
  }

  if (name === 'ApplyPatch' && Array.isArray(i.changes)) {
    const lines = (i.changes as Array<{ kind?: string; path?: string }>).map(
      (c) => `${(c.kind ?? 'change').padEnd(7)} ${c.path ?? ''}`,
    );
    return <Pre text={lines.join('\n')} tone="add" />;
  }

  if (name === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return (
      <div className="space-y-1.5">
        <Pre text={i.old_string} tone="del" />
        <Pre text={i.new_string} tone="add" />
      </div>
    );
  }

  if (name === 'Write' && typeof i.content === 'string') {
    return <Pre text={i.content} tone="add" />;
  }

  return <Pre text={JSON.stringify(input ?? {}, null, 2)} />;
}

export function ToolCard({ block }: { block: LiveToolBlock }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(block.toolName);
  const summary = toolSummary(block.toolName, block.input);
  const running = block.streaming || !block.result;
  const failed = block.result?.isError ?? false;

  return (
    <div
      className={clsx(
        'fade-up my-2.5 overflow-hidden rounded-xl border bg-surface transition-colors',
        failed ? 'border-danger/35' : 'border-line',
      )}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-elevated"
      >
        <ChevronRight
          size={13}
          className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-90')}
        />
        <Icon size={14} className={clsx('shrink-0', failed ? 'text-danger' : 'text-accent')} />
        <span className="shrink-0 text-[13px] font-medium">{block.toolName}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">
          {running ? (
            <Loader2 size={12} className="animate-spin" />
          ) : failed ? (
            <CircleAlert size={12} className="text-danger" />
          ) : (
            resultSummary(block.result?.content ?? '', false)
          )}
        </span>
      </button>

      {open && (
        <div className="text-[13px]">
          <Section label={t('Input')}>
            <InputView name={block.toolName} input={block.input} />
          </Section>
          {block.result && (
            <Section label={failed ? t('Error') : t('Result')}>
              <Pre text={block.result.content || t('(empty)')} tone={failed ? 'del' : 'normal'} />
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
