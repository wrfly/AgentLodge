import { useSyncExternalStore } from 'react';
import type { AgentId } from './protocol';

export const AGENTS: Array<{ id: AgentId; path: string; label: string }> = [
  { id: 'claude', path: '/claude', label: 'Claude Code' },
  { id: 'codex', path: '/codex', label: 'Codex' },
];

export type AdminTab = 'overview' | 'users' | 'invites' | 'settings' | 'trace_logs' | 'audit';
const ADMIN_TABS: AdminTab[] = ['overview', 'users', 'invites', 'settings', 'trace_logs', 'audit'];

export type Route =
  | { name: 'chat'; agent: AgentId }
  | { name: 'usage' }
  | { name: 'profile' }
  | { name: 'memory' }
  | { name: 'traces' }
  | { name: 'api-keys' }
  | { name: 'settings' }
  | { name: 'admin'; tab: AdminTab }
  | { name: 'register'; code?: string; email?: string }
  | { name: 'reset-password'; token?: string };

/** Routes reachable without signing in */
export function isPublic(route: Route): boolean {
  return route.name === 'register' || route.name === 'reset-password';
}

const DEFAULT_AGENT: AgentId = 'claude';

function parse(url: URL): Route {
  const [, first, second] = url.pathname.split('/');
  const q = url.searchParams;

  switch (first) {
    case 'claude':
    case 'codex':
      return { name: 'chat', agent: first };
    case 'usage':
      return { name: 'usage' };
    case 'profile':
      return { name: 'profile' };
    case 'memory':
      return { name: 'memory' };
    case 'traces':
      return { name: 'traces' };
    case 'api-keys':
      return { name: 'api-keys' };
    case 'settings':
      return { name: 'settings' };
    case 'admin':
      return {
        name: 'admin',
        tab: ADMIN_TABS.includes(second as AdminTab) ? (second as AdminTab) : 'overview',
      };
    case 'register':
      return {
        name: 'register',
        code: q.get('code') ?? undefined,
        email: q.get('email') ?? undefined,
      };
    case 'reset-password':
      return { name: 'reset-password', token: q.get('token') ?? undefined };
    default:
      return { name: 'chat', agent: DEFAULT_AGENT };
  }
}

/** Few enough routes that a router library would cost more than it saves */
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function navigate(path: string, replace = false): void {
  if (window.location.pathname + window.location.search === path) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
  emit();
}

window.addEventListener('popstate', emit);

// useSyncExternalStore needs a stable snapshot reference, or it re-renders forever
let cachedHref = '';
let cachedRoute: Route = { name: 'chat', agent: DEFAULT_AGENT };

function snapshot(): Route {
  if (window.location.href !== cachedHref) {
    cachedHref = window.location.href;
    cachedRoute = parse(new URL(window.location.href));
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snapshot,
    () => cachedRoute,
  );
}

const KNOWN = [
  'claude',
  'codex',
  'usage',
  'profile',
  'memory',
  'traces',
  'settings',
  'admin',
  'register',
  'reset-password',
];

/** Fill in the default agent for the root or an unknown path, so the address bar always says where you are */
export function normalizePath(): void {
  const seg = window.location.pathname.split('/')[1] ?? '';
  if (!KNOWN.includes(seg)) {
    window.history.replaceState(null, '', `/${DEFAULT_AGENT}`);
  }
}
