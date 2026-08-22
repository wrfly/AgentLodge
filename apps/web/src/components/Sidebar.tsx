import { useMemo, useState } from 'react';
import {
  BarChart3,
  Brain,
  ChevronsUpDown,
  KeyRound,
  LogOut,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  Radar,
  Pencil,
  Settings,
  Shield,
  Download,
  Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { useChat } from '../store/chat';
import { useAuth } from '../store/auth';
import type { AgentId, ConversationSummary } from '../lib/protocol';
import { ThemeToggle } from './ThemeToggle';
import { AgentSwitcher } from './AgentSwitcher';
import { QuotaBar } from './QuotaBar';
import { navigate, useRoute } from '../lib/route';
import { useT } from '../lib/i18n';
import { LocaleToggle } from './LocaleToggle';
import { exportConversation } from '../lib/api';

/**
 * Buckets a conversation by age.
 *
 * Returns a key rather than a label: this runs outside React, where the
 * translator hook is not available, and a bucket is a fact about the date
 * while its wording is a fact about the reader.
 */
type GroupKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'older';

function groupOf(iso: string): GroupKey {
  const d = new Date(iso);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diff = startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = 86400_000;
  if (diff <= 0) return 'today';
  if (diff <= day) return 'yesterday';
  if (diff <= 7 * day) return 'last7';
  if (diff <= 30 * day) return 'last30';
  return 'older';
}

const ORDER: GroupKey[] = ['today', 'yesterday', 'last7', 'last30', 'older'];

const GROUP_LABEL: Record<GroupKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Previous 7 days',
  last30: 'Previous 30 days',
  older: 'Older',
};

function Item({ conv }: { conv: ConversationSummary }) {
  const activeId = useChat((s) => s.activeId);
  const select = useChat((s) => s.select);
  const rename = useChat((s) => s.rename);
  const remove = useChat((s) => s.remove);

  const t = useT();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.title);

  const active = activeId === conv.id;

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== conv.title) void rename(conv.id, next);
    else setDraft(conv.title);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(conv.title);
            setEditing(false);
          }
        }}
        className="w-full rounded-lg border border-accent/50 bg-surface px-2.5 py-1.5 text-[13.5px] outline-none"
      />
    );
  }

  return (
    <div
      className={clsx(
        'group relative flex items-center rounded-lg transition-colors',
        active ? 'bg-bubble' : 'hover:bg-bubble/60',
      )}
    >
      <button
        onClick={() => {
          // The sidebar is on the admin, usage and memory pages too. Clicking a
          // conversation there has to return to the chat route as well —
          // otherwise only the store changes and the screen stays where it was,
          // which reads as the click doing nothing. select writes activeId
          // synchronously, so select first, then navigate.
          void select(conv.id);
          navigate(`/${conv.agent}`);
        }}
        className="min-w-0 flex-1 truncate px-2.5 py-1.5 text-left text-[13.5px] text-ink"
        title={conv.title}
      >
        {conv.title}
      </button>

      <button
        onClick={() => setMenu((v) => !v)}
        className={clsx(
          'mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition hover:bg-line-strong hover:text-ink',
          menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
        )}
        aria-label={t('Conversation actions')}
      >
        <MoreHorizontal size={14} />
      </button>

      {menu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div className="absolute top-full right-1 z-20 mt-0.5 w-32 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
            <button
              onClick={() => {
                setMenu(false);
                setEditing(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-elevated"
            >
              <Pencil size={12} /> {t('Rename')}
            </button>
            <button
              onClick={() => {
                setMenu(false);
                void exportConversation(conv.id, conv.title);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-elevated"
            >
              <Download size={12} /> {t('Export as Markdown')}
            </button>
            <button
              onClick={() => {
                setMenu(false);
                void remove(conv.id);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-danger hover:bg-elevated"
            >
              <Trash2 size={12} /> {t('Delete')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Sidebar({ agent }: { agent: AgentId }) {
  const t = useT();
  const conversations = useChat((s) => s.conversations);
  const newConversation = useChat((s) => s.newConversation);
  const setSidebar = useChat((s) => s.setSidebar);
  // On non-chat routes props.agent is always claude, so navigation has to use
  // whichever agent the store is actually on
  const chatAgent = useChat((s) => s.agent);

  const groups = useMemo(() => {
    const map = new Map<string, ConversationSummary[]>();
    for (const c of conversations) {
      const g = groupOf(c.updatedAt);
      const arr = map.get(g);
      if (arr) arr.push(c);
      else map.set(g, [c]);
    }
    return ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [conversations]);

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="px-1 text-[14px] font-semibold tracking-tight">AgentLodge</span>
        <button
          onClick={() => setSidebar(false)}
          className="flex size-7 items-center justify-center rounded-md text-faint hover:bg-bubble hover:text-ink md:hidden"
          aria-label={t('Collapse sidebar')}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <AgentSwitcher current={agent} />
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={() => {
            navigate(`/${chatAgent}`);
            void newConversation();
          }}
          className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[13.5px] font-medium transition hover:border-line-strong"
        >
          <MessageSquarePlus size={15} className="text-accent" />
          {t('New chat')}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map(([label, items]) => (
          <div key={label} className="mb-2">
            <div className="px-2.5 py-1.5 text-[11px] font-medium tracking-wide text-faint">
              {t(GROUP_LABEL[label])}
            </div>
            <div className="space-y-0.5">
              {items.map((c) => (
                <Item key={c.id} conv={c} />
              ))}
            </div>
          </div>
        ))}
        {conversations.length === 0 && (
          <p className="px-3 py-4 text-[12.5px] text-faint">{t('No conversations yet')}</p>
        )}
      </nav>

      <div className="border-t border-line px-3 py-2.5">
        <QuotaBar />
        <AccountMenu />
      </div>
    </aside>
  );
}

/**
 * Account menu: usage, memory, traces, keys, settings and admin, plus theme,
 * language and sign-out, all folded into one row.
 *
 * These used to be six full-width buttons stacked under a theme switch and a
 * user row, which filled most of the lower half of the sidebar and squeezed the
 * conversation list — the thing the sidebar is for — into whatever was left.
 * They are all low-traffic entry points, and the user row was already the
 * identity area, so folding them in turns six rows into one.
 *
 * Opens upward (bottom-full): the row is pinned to the bottom of the sidebar,
 * so there is no space below it.
 */
function AccountMenu() {
  const t = useT();
  const route = useRoute();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const reset = useChat((s) => s.reset);
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const items = [
    { path: '/usage', label: 'Usage', icon: BarChart3, name: 'usage' },
    { path: '/memory', label: 'Memory', icon: Brain, name: 'memory' },
    { path: '/traces', label: 'Request traces', icon: Radar, name: 'traces' },
    { path: '/api-keys', label: 'API keys', icon: KeyRound, name: 'api-keys' },
    { path: '/settings', label: 'Settings', icon: Settings, name: 'settings' },
    ...(user.role === 'admin'
      ? [{ path: '/admin', label: 'Admin console', icon: Shield, name: 'admin' }]
      : []),
  ];

  // While you are on one of these pages, the collapsed row still has to say so
  const here = items.find((it) => it.name === route.name);

  return (
    <div className="relative mb-2">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1 w-full overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
            {items.map((it) => (
              <button
                key={it.path}
                onClick={() => {
                  setOpen(false);
                  navigate(it.path);
                }}
                className={clsx(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition',
                  route.name === it.name ? 'bg-bubble text-ink' : 'hover:bg-elevated',
                )}
              >
                <it.icon size={13} />
                {t(it.label)}
              </button>
            ))}

            <div className="my-1 border-t border-line" />
            <div className="space-y-1.5 px-2 py-1">
              <ThemeToggle />
              <LocaleToggle />
            </div>
            <div className="my-1 border-t border-line" />

            <button
              onClick={() => {
                setOpen(false);
                reset();
                void logout();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-danger hover:bg-elevated"
            >
              <LogOut size={13} /> {t('Sign out')}
            </button>
          </div>
        </>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={clsx(
          'flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 transition',
          open ? 'bg-bubble' : 'hover:bg-bubble/60',
        )}
      >
        <div
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent"
          aria-hidden
        >
          {user.username.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[12.5px] font-medium">{user.username}</div>
          <div className="truncate text-[10.5px] text-faint">
            {here ? t(here.label) : t(user.role === 'admin' ? 'Administrator' : 'Account')}
          </div>
        </div>
        <ChevronsUpDown size={13} className="shrink-0 text-faint" />
      </button>
    </div>
  );
}
