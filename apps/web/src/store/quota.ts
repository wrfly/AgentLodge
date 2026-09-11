import { create } from 'zustand';
import { me, type QuotaStatus } from '../lib/api';

interface QuotaState {
  quota: QuotaStatus | null;
  /**
   * How many times the figure has been written.
   *
   * Every source of a quota is a read taken at some instant, and they do not arrive in the
   * order they were taken: the usage page's request is issued, a turn finishes and pushes a
   * fresher one over the stream, and then the older read lands and puts the bar back where it
   * was. Nothing in a `QuotaStatus` says when it was read, so callers take this number before
   * they ask and hand it back with the answer — if it has moved, something newer has already
   * been written and the answer is thrown away.
   */
  seq: number;
  refresh: () => Promise<void>;
  /** The server pushes the fresh quota over SSE when a turn ends; taking it saves a round trip */
  set: (q: QuotaStatus) => void;
  /** A quota that rode along with another response, kept only if nothing newer landed meanwhile */
  adopt: (q: QuotaStatus, since: number) => void;
  clear: () => void;
}

export const useQuota = create<QuotaState>((set, get) => ({
  quota: null,
  seq: 0,
  async refresh() {
    const mine = get().seq;
    try {
      const quota = await me.quota();
      if (get().seq !== mine) return;
      set((s) => ({ quota, seq: s.seq + 1 }));
    } catch {
      /* Not signed in, or the network is unhappy. Either way, stay quiet. */
    }
  },
  // Straight in: an event is written the moment the server computed it, so it is never the
  // stale one of the pair
  set: (quota) => set((s) => ({ quota, seq: s.seq + 1 })),
  adopt(quota, since) {
    if (get().seq !== since) return;
    set((s) => ({ quota, seq: s.seq + 1 }));
  },
  clear: () => set((s) => ({ quota: null, seq: s.seq + 1 })),
}));
