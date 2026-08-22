import { useEffect } from 'react';
import clsx from 'clsx';
import { useChat } from './store/chat';
import { useAuth } from './store/auth';
import { useAgents } from './store/agents';
import { useQuota } from './store/quota';
import { isPublic, navigate, normalizePath, useRoute, type Route } from './lib/route';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { AuthScreen } from './components/AuthScreen';
import { RegisterPage, ResetPasswordPage } from './pages/PublicPages';
import { UsagePage } from './pages/UsagePage';
import { MemoryPage } from './pages/MemoryPage';
import { TracesPage } from './pages/TracesPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminPage } from './pages/AdminPage';

/** Only the chat route needs the conversation list; other pages must not bootstrap */
function ChatPane({ agent }: { agent: 'claude' | 'codex' }) {
  const bootstrap = useChat((s) => s.bootstrap);
  const reset = useChat((s) => s.reset);
  const agentsLoaded = useAgents((s) => s.loaded);
  const available = useAgents((s) => s.info(agent)?.availability.available);
  const enabled = useAgents((s) => s.enabled)();

  /*
   * A deep link to an agent this deployment does not offer goes to one it does.
   *
   * Not the same as an agent whose CLI is missing: that one still belongs to
   * the deployment, so its page stays and explains itself. This one was turned
   * off by an administrator, and there is nothing to explain to the user —
   * a page saying "this does not exist here" is worse than simply being where
   * they can work.
   */
  useEffect(() => {
    if (!agentsLoaded || enabled.includes(agent)) return;
    const fallback = enabled[0];
    if (fallback) navigate(`/${fallback}`, true);
  }, [agent, agentsLoaded, enabled]);

  // Switching agent means switching workspace, so the list reloads wholesale.
  // Wait for the probe before deciding, or an agent whose CLI is not installed
  // gets an empty conversation created for nothing.
  useEffect(() => {
    if (!agentsLoaded) return;
    if (!available) {
      reset();
      return;
    }
    // Coming back from the admin, usage or memory page remounts this component
    // while the workspace has not changed. Bootstrapping again would clear
    // activeId and reselect the first row, which reads as clicking a
    // conversation doing nothing.
    //
    // The test is activeId, not "the list is non-empty": Shell now preloads the
    // list on non-chat routes (see below), so a non-empty list no longer means
    // this workspace has been initialised. Using it would make
    // deep-link-to-settings-then-chat skip bootstrap and land on a chat pane
    // with nothing selected.
    const s = useChat.getState();
    if (s.agent === agent && s.activeId) return;
    void bootstrap(agent);
  }, [agent, agentsLoaded, available, bootstrap, reset]);

  return <Chat agent={agent} />;
}

function Content({ route }: { route: Route }) {
  switch (route.name) {
    case 'chat':
      return <ChatPane agent={route.agent} />;
    case 'usage':
      return <UsagePage />;
    case 'memory':
      return <MemoryPage />;
    case 'traces':
      return <TracesPage />;
    case 'api-keys':
      return <ApiKeysPage />;
    case 'settings':
      return <SettingsPage />;
    case 'admin':
      return <AdminPage tab={route.tab} />;
    default:
      return null;
  }
}

function Shell({ route }: { route: Route }) {
  const sidebarOpen = useChat((s) => s.sidebarOpen);
  const setSidebar = useChat((s) => s.setSidebar);
  const refreshList = useChat((s) => s.refreshList);
  const loadAgents = useAgents((s) => s.load);
  const refreshQuota = useQuota((s) => s.refresh);

  // The sidebar's agent switcher is on every page, so load the agent list once, globally
  const agent = route.name === 'chat' ? route.agent : 'claude';
  const onChat = route.name === 'chat';

  useEffect(() => {
    void loadAgents();
    void refreshQuota();
  }, [loadAgents, refreshQuota]);

  /*
   * The sidebar renders on every route, but the bootstrap that fills the
   * conversation list hangs off ChatPane, and ChatPane only renders for the
   * chat route. So any first paint on another route — a bookmark, a shared
   * link, F5 on /settings — finds an empty store and draws "no conversations
   * yet". You had to visit the chat page to fix it, and since nothing is
   * persisted, reloading did not help either.
   *
   * This adds a plain load. Deliberately not bootstrap(): that clears the list,
   * resets activeId, and creates a conversation when the list comes back empty
   * — opening the settings page should not leave an empty conversation behind.
   */
  useEffect(() => {
    if (onChat) return; // the chat route is ChatPane's job; don't fetch twice
    if (useChat.getState().conversations.length) return;
    void refreshList();
  }, [onChat, refreshList]);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-bg text-ink">
      {/* Always-on sidebar, desktop */}
      <div className="hidden md:flex">
        <Sidebar agent={agent} />
      </div>

      {/* Drawer, mobile */}
      <div
        className={clsx(
          'fixed inset-0 z-40 md:hidden',
          sidebarOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div
          onClick={() => setSidebar(false)}
          className={clsx(
            'absolute inset-0 bg-black/40 transition-opacity',
            sidebarOpen ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          className={clsx(
            'absolute inset-y-0 left-0 transition-transform duration-200 ease-out',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar agent={agent} />
        </div>
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <Content route={route} />
      </main>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const ready = useAuth((s) => s.ready);
  const user = useAuth((s) => s.user);
  const restore = useAuth((s) => s.restore);

  useEffect(() => {
    normalizePath();
    void restore();
  }, [restore]);

  // Sign-up and password reset need no login, and must come before the auth gate
  if (route.name === 'register') return <RegisterPage code={route.code} email={route.email} />;
  if (route.name === 'reset-password') return <ResetPasswordPage token={route.token} />;

  // Render nothing until the session is restored, so the login screen does not flash
  if (!ready) return <div className="h-[100dvh] bg-bg" />;
  if (!user) return <AuthScreen />;

  // Non-admins asking for the admin console go back to chat
  if (route.name === 'admin' && user.role !== 'admin') {
    navigate('/claude', true);
    return null;
  }
  if (isPublic(route)) return null;

  return <Shell route={route} />;
}
