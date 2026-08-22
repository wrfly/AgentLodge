import { create } from 'zustand';
import { auth, setAccessToken, setUnauthorizedHandler, type PublicUser } from '../lib/api';

interface AuthState {
  user: PublicUser | null;
  /** On a cold start, try the cookie first and render nothing until that has settled */
  ready: boolean;
  error: string | null;
  busy: boolean;

  restore: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (input: {
    email: string;
    username: string;
    password: string;
    inviteCode: string;
  }) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
}

/** The access token lasts 15 minutes; renew it silently a minute before it lapses */
let refreshTimer: number | null = null;

function scheduleRefresh(expiresIn: number) {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  const delay = Math.max((expiresIn - 60) * 1000, 30_000);
  refreshTimer = window.setTimeout(() => {
    void auth.restore().then((res) => {
      if (res) scheduleRefresh(res.expiresIn);
    });
  }, delay);
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,
  error: null,
  busy: false,

  clearError: () => set({ error: null }),

  async restore() {
    try {
      const res = await auth.restore();
      if (res) {
        scheduleRefresh(res.expiresIn);
        set({ user: res.user });
      }
    } finally {
      set({ ready: true });
    }
  },

  async login(email, password) {
    set({ busy: true, error: null });
    try {
      const res = await auth.login({ email, password });
      setAccessToken(res.accessToken);
      scheduleRefresh(res.expiresIn);
      set({ user: res.user, busy: false });
      return true;
    } catch (err) {
      set({ busy: false, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  async register(input) {
    set({ busy: true, error: null });
    try {
      const res = await auth.register(input);
      setAccessToken(res.accessToken);
      scheduleRefresh(res.expiresIn);
      set({ user: res.user, busy: false });
      return true;
    } catch (err) {
      set({ busy: false, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  async logout() {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    await auth.logout().catch(() => {});
    setAccessToken(null);
    set({ user: null });
  },
}));

// The access token can no longer be refreshed either — back to the sign-in page
setUnauthorizedHandler(() => {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  useAuth.setState({ user: null });
});
