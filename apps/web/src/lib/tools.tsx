import {
  Bot,
  Braces,
  FileDiff,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { t } from './i18n';

const ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  Write: Pencil,
  Edit: Pencil,
  NotebookEdit: Pencil,
  Bash: SquareTerminal,
  BashOutput: SquareTerminal,
  Shell: SquareTerminal,
  ApplyPatch: FileDiff,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Bot,
  Agent: Bot,
  TodoWrite: ListChecks,
};

export function toolIcon(name: string): LucideIcon {
  return ICONS[name] ?? (name.startsWith('mcp__') ? Braces : Wrench);
}

/** One-line summary shown when a tool card is collapsed */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  // The workspace directory is a UUID, so showing the parent just fills the line
  // with noise — file name only
  const base = (p?: string) => (p ? p.split('/').filter(Boolean).pop() : undefined);

  switch (name) {
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return base(str('file_path') ?? str('notebook_path')) ?? '';
    case 'Edit':
      return base(str('file_path')) ?? '';
    case 'Bash':
    case 'BashOutput':
    case 'Shell':
      return str('command') ?? str('description') ?? '';
    case 'ApplyPatch': {
      const changes = i.changes;
      if (!Array.isArray(changes)) return '';
      const names = changes
        .map((c) => (c as { path?: string }).path)
        .filter((p): p is string => Boolean(p))
        .map((p) => p.split('/').pop());
      return names.length > 2
        ? t('{first} and {n} files in total', { first: names.slice(0, 2).join(', '), n: names.length })
        : names.join(', ');
    }
    case 'Grep':
      return [str('pattern'), base(str('path'))].filter(Boolean).join('  ·  ');
    case 'Glob':
      return str('pattern') ?? '';
    case 'WebFetch':
    case 'WebSearch':
      return str('url') ?? str('query') ?? '';
    case 'Task':
    case 'Agent':
      return str('description') ?? str('subagent_type') ?? '';
    case 'TodoWrite': {
      const todos = i.todos;
      return Array.isArray(todos) ? t('{n} item(s)', { n: todos.length }) : '';
    }
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
      return first ?? '';
    }
  }
}

/** Short stat line shown on the result section */
export function resultSummary(content: string, isError: boolean): string {
  if (isError) return t('failed');
  const lines = content.split('\n').length;
  if (!content.trim()) return t('no output');
  return lines > 1 ? t('{n} lines', { n: lines }) : t('{n} chars', { n: content.length });
}
