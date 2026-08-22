import { create } from 'zustand';
import { api, type AgentInfo } from '../lib/api';
import type { AgentId } from '../lib/protocol';
import { AGENTS } from '../lib/route';

interface AgentsState {
  agents: AgentInfo[];
  loaded: boolean;
  load: () => Promise<void>;
  info: (id: AgentId) => AgentInfo | undefined;
  /**
   * The agents an administrator actually offers.
   *
   * Before the list has loaded this returns every id the router knows, so the
   * UI does not blink through a state where nothing is offered — and so a
   * deep link is not redirected away on the strength of an empty list.
   */
  enabled: () => AgentId[];
}

export const useAgents = create<AgentsState>((set, get) => ({
  agents: [],
  loaded: false,

  async load() {
    try {
      set({ agents: await api.agents(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  info: (id) => get().agents.find((a) => a.id === id),

  enabled: () => {
    const { agents, loaded } = get();
    if (!loaded) return AGENTS.map((a) => a.id);
    const on = agents.filter((a) => a.enabled).map((a) => a.id);
    // An empty list would leave the user with no agent at all. The server
    // refuses to store that, so this only guards against a response we did
    // not expect.
    return on.length ? on : AGENTS.map((a) => a.id);
  },
}));
