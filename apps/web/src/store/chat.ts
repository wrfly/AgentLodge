import { create } from 'zustand';
import { ApiError, api } from '../lib/api';
import { openEventStream } from '../lib/stream';
import { useQuota } from './quota';
import type {
  AgentId,
  ConversationSummary,
  MessageBlock,
  ServerEvent,
  StoredMessage,
  TurnUsage,
} from '../lib/protocol';

/* ---------- The client's block model: the persisted shape plus streaming state ---------- */

export interface LiveTextBlock {
  kind: 'text';
  blockId: number;
  text: string;
  streaming: boolean;
}
export interface LiveThinkingBlock {
  kind: 'thinking';
  blockId: number;
  text: string;
  streaming: boolean;
}
export interface LiveToolBlock {
  kind: 'tool_use';
  blockId: number;
  toolId: string;
  toolName: string;
  /** The partial input JSON assembled so far while streaming */
  inputPartial: string;
  input: unknown;
  result?: { isError: boolean; content: string };
  streaming: boolean;
}
export type LiveBlock = LiveTextBlock | LiveThinkingBlock | LiveToolBlock;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: LiveBlock[];
  createdAt: string;
  usage?: TurnUsage;
  error?: string;
  aborted?: boolean;
  pending?: boolean;
}

function toLive(b: MessageBlock): LiveBlock {
  if (b.kind === 'tool_use') {
    return {
      kind: 'tool_use',
      blockId: b.blockId,
      toolId: b.toolId,
      toolName: b.toolName,
      inputPartial: '',
      input: b.input,
      result: b.result,
      streaming: false,
    };
  }
  return { kind: b.kind, blockId: b.blockId, text: b.text, streaming: false };
}

function toChatMessage(m: StoredMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    blocks: m.blocks.map(toLive),
    createdAt: m.createdAt,
    usage: m.usage,
    error: m.error,
    aborted: m.aborted,
  };
}

/* ---------- store ---------- */

interface ChatState {
  agent: AgentId;
  conversations: ConversationSummary[];
  activeId: string | null;
  title: string;
  /** The model this conversation uses; an empty string leaves the CLI on its default */
  model: string;
  /** Reasoning effort; an empty string leaves the CLI on its default */
  effort: string;
  /** Whether the upstream is asked for the agent's thinking; on unless turned off */
  thinking: boolean;
  /** Place in the queue at the gateway's concurrency gate; 0 means not queued */
  queuePosition: number;
  messages: ChatMessage[];
  streaming: boolean;
  loading: boolean;
  connected: boolean;
  error: string | null;
  sidebarOpen: boolean;

  bootstrap: (agent: AgentId) => Promise<void>;
  reset: () => void;
  refreshList: () => Promise<void>;
  newConversation: () => Promise<void>;
  select: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEffort: (effort: string) => Promise<void>;
  setThinking: (thinking: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setSidebar: (open: boolean) => void;
  dismissError: () => void;
  _applyBatch: (batch: ServerEvent[]) => void;
}

/* ---- The SSE connection and rAF batching. Kept outside the store, so none of it becomes React state. ---- */

let closeSource: (() => void) | null = null;
let queue: ServerEvent[] = [];
let raf: number | null = null;

function flush() {
  raf = null;
  const batch = queue;
  queue = [];
  if (batch.length) useChat.getState()._applyBatch(batch);
}

function enqueue(e: ServerEvent) {
  queue.push(e);
  if (raf === null) raf = requestAnimationFrame(flush);
}

function closeStream() {
  closeSource?.();
  closeSource = null;
  queue = [];
  if (raf !== null) {
    cancelAnimationFrame(raf);
    raf = null;
  }
}

function openStream(conversationId: string) {
  closeStream();
  closeSource = openEventStream({
    conversationId,
    onEvent: enqueue,
    onStatus: (connected) => useChat.setState({ connected }),
  });
}

/** Find a block by blockId in the most recent assistant message */
function findBlock(msgs: ChatMessage[], blockId: number): LiveBlock | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant') continue;
    const b = m.blocks.find((x) => x.blockId === blockId);
    if (b) return b;
    if (!m.pending) break;
  }
  return undefined;
}

export const useChat = create<ChatState>((set, get) => ({
  agent: 'claude',
  conversations: [],
  activeId: null,
  title: '',
  model: '',
  effort: '',
  thinking: true,
  queuePosition: 0,
  messages: [],
  streaming: false,
  loading: false,
  connected: false,
  error: null,
  sidebarOpen: false,

  setSidebar: (open) => set({ sidebarOpen: open }),
  dismissError: () => set({ error: null }),

  async bootstrap(agent) {
    closeStream();
    set({
      agent,
      conversations: [],
      messages: [],
      activeId: null,
      title: '',
      model: '',
      effort: '',
      thinking: true,
      streaming: false,
      error: null,
    });
    await get().refreshList();
    const first = get().conversations[0];
    if (first) await get().select(first.id);
    else await get().newConversation();
  },

  reset() {
    closeStream();
    set({
      conversations: [],
      messages: [],
      activeId: null,
      title: '',
      model: '',
      effort: '',
      thinking: true,
      streaming: false,
      connected: false,
      error: null,
    });
  },

  async refreshList() {
    try {
      set({ conversations: await api.listConversations(get().agent) });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async newConversation() {
    try {
      // A new conversation inherits the current settings, rather than asking again every time
      const conv = await api.createConversation(
        get().agent,
        get().model || undefined,
        get().effort || undefined,
        get().thinking,
      );
      set((s) => ({
        conversations: [
          {
            id: conv.id,
            title: conv.title,
            agent: conv.agent,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            messageCount: 0,
          },
          ...s.conversations,
        ],
        activeId: conv.id,
        title: conv.title,
        model: conv.model ?? '',
        effort: conv.effort ?? '',
        thinking: conv.thinking ?? true,
        messages: [],
        streaming: false,
        sidebarOpen: false,
      }));
      openStream(conv.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async select(id) {
    if (get().activeId === id && get().messages.length) return;
    set({ loading: true, activeId: id, messages: [], sidebarOpen: false });
    try {
      const conv = await api.getConversation(id);
      set({
        title: conv.title,
        model: conv.model ?? '',
        effort: conv.effort ?? '',
        thinking: conv.thinking ?? true,
        messages: conv.messages.map(toChatMessage),
        streaming: conv.busy,
        loading: false,
      });
      openStream(id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async send(text) {
    const id = get().activeId;
    if (!id || get().streaming) return;

    // Append the user's message optimistically, so the interface responds at once
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      blocks: [{ kind: 'text', blockId: 0, text, streaming: false }],
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, optimistic], streaming: true }));

    try {
      const { userMessage } = await api.sendMessage(id, text);
      set((s) => ({
        messages: s.messages.map((m) => (m.id === optimistic.id ? toChatMessage(userMessage) : m)),
      }));
    } catch (err) {
      // 402 = out of allowance. Refresh the quota while we are here, and the composer disables itself immediately.
      if (err instanceof ApiError && err.status === 402) void useQuota.getState().refresh();
      set((s) => ({
        streaming: false,
        error: err instanceof Error ? err.message : String(err),
        messages: s.messages.filter((m) => m.id !== optimistic.id),
      }));
    }
  },

  async abort() {
    const id = get().activeId;
    if (id) await api.abort(id);
  },

  async rename(id, title) {
    await api.renameConversation(id, title);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
      title: s.activeId === id ? title : s.title,
    }));
  },

  async setModel(model) {
    const id = get().activeId;
    if (!id) return;
    const prev = get().model;
    set({ model });
    try {
      await api.setModel(id, model);
    } catch (err) {
      set({ model: prev, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async setEffort(effort) {
    const id = get().activeId;
    if (!id) return;
    const prev = get().effort;
    set({ effort });
    try {
      await api.setEffort(id, effort);
    } catch (err) {
      set({ effort: prev, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async setThinking(thinking) {
    const id = get().activeId;
    if (!id) return;
    const prev = get().thinking;
    set({ thinking });
    try {
      await api.setThinking(id, thinking);
    } catch (err) {
      set({ thinking: prev, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async remove(id) {
    await api.deleteConversation(id);
    const rest = get().conversations.filter((c) => c.id !== id);
    set({ conversations: rest });
    if (get().activeId === id) {
      closeStream();
      const next = rest[0];
      if (next) await get().select(next.id);
      else await get().newConversation();
    }
  },

  _applyBatch(batch) {
    set((state) => {
      const messages = state.messages.slice();
      let streaming = state.streaming;
      let queuePosition = state.queuePosition;
      let title = state.title;
      let conversations = state.conversations;

      // Clone the trailing message once per frame, instead of allocating a new object per delta
      const cloned = new Set<number>();
      const mutable = (idx: number): ChatMessage | undefined => {
        const m = messages[idx];
        if (!m) return undefined;
        if (!cloned.has(idx)) {
          const copy: ChatMessage = { ...m, blocks: m.blocks.map((b) => ({ ...b })) };
          messages[idx] = copy;
          cloned.add(idx);
          return copy;
        }
        return m;
      };
      const lastAssistant = (): ChatMessage | undefined => {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === 'assistant') return mutable(i);
        }
        return undefined;
      };

      for (const e of batch) {
        switch (e.type) {
          case 'turn.started': {
            messages.push({
              id: e.turnId,
              role: 'assistant',
              blocks: [],
              createdAt: new Date().toISOString(),
              pending: true,
            });
            cloned.add(messages.length - 1);
            streaming = true;
            queuePosition = 0;
            break;
          }

          case 'block.start': {
            const msg = lastAssistant();
            if (!msg?.pending) break;
            if (msg.blocks.some((b) => b.blockId === e.blockId)) break;
            msg.blocks.push(
              e.kind === 'tool_use'
                ? {
                    kind: 'tool_use',
                    blockId: e.blockId,
                    toolId: e.toolId ?? `tool_${e.blockId}`,
                    toolName: e.toolName ?? 'unknown',
                    inputPartial: '',
                    input: {},
                    streaming: true,
                  }
                : { kind: e.kind, blockId: e.blockId, text: '', streaming: true },
            );
            break;
          }

          case 'text.delta':
          case 'thinking.delta': {
            queuePosition = 0;
            lastAssistant();
            const b = findBlock(messages, e.blockId);
            if (b && b.kind !== 'tool_use') b.text += e.text;
            break;
          }

          case 'tool.input.delta': {
            lastAssistant();
            const b = findBlock(messages, e.blockId);
            if (b?.kind === 'tool_use') b.inputPartial += e.partial;
            break;
          }

          case 'tool.input': {
            lastAssistant();
            const b = findBlock(messages, e.blockId);
            if (b?.kind === 'tool_use') b.input = e.input;
            break;
          }

          case 'block.stop': {
            lastAssistant();
            const b = findBlock(messages, e.blockId);
            if (b) b.streaming = false;
            break;
          }

          case 'tool.result': {
            const msg = lastAssistant();
            const b = msg?.blocks.find(
              (x): x is LiveToolBlock => x.kind === 'tool_use' && x.toolId === e.toolId,
            );
            if (b) {
              b.result = { isError: e.isError, content: e.content };
              b.streaming = false;
            }
            break;
          }

          case 'turn.completed':
          case 'turn.error':
          case 'turn.aborted': {
            const msg = lastAssistant();
            if (msg) {
              msg.pending = false;
              msg.blocks.forEach((b) => (b.streaming = false));
              if (e.type === 'turn.completed') msg.usage = e.usage;
              if (e.type === 'turn.error') msg.error = e.message;
              if (e.type === 'turn.aborted') msg.aborted = true;
            }
            streaming = false;
            queuePosition = 0;
            void get().refreshList();
            break;
          }

          case 'title.updated': {
            title = e.title;
            conversations = conversations.map((c) =>
              c.id === e.conversationId ? { ...c, title: e.title } : c,
            );
            break;
          }

          case 'quota.updated':
            useQuota.getState().set(e.quota);
            break;

          case 'queue.waiting':
            queuePosition = e.position;
            break;

          case 'heartbeat':
            break;
        }
      }

      return { messages, streaming, title, conversations, queuePosition };
    });
  },
}));
