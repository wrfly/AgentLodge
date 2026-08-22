import { create } from 'zustand';
import { me, type QuotaStatus } from '../lib/api';

interface QuotaState {
  quota: QuotaStatus | null;
  refresh: () => Promise<void>;
  /** The server pushes the fresh quota over SSE when a turn ends; taking it saves a round trip */
  set: (q: QuotaStatus) => void;
  clear: () => void;
}

export const useQuota = create<QuotaState>((set) => ({
  quota: null,
  async refresh() {
    try {
      set({ quota: await me.quota() });
    } catch {
      /* Not signed in, or the network is unhappy. Either way, stay quiet. */
    }
  },
  set: (quota) => set({ quota }),
  clear: () => set({ quota: null }),
}));
