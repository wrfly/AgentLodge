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
  /** How much thinking the upstream reported when it did not report the thinking itself */
  tokens?: number;
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
  /**
   * Bumped whenever the workspace changes from outside the files panel.
   *
   * The composer can now upload — paste, drop, the paperclip — and the panel is its
   * sibling, holding its own list. Without something to watch, a file attached while the
   * panel is open simply does not appear in it.
   */
  filesVersion: number;
  messages: ChatMessage[];
  streaming: boolean;
  loading: boolean;
  connected: boolean;
  error: string | null;
  /**
   * The agent whose workspace has been bootstrapped, or null.
   *
   * `activeId` used to answer this: it was non-null the moment the chat page had been set
   * up, because setting it up created a conversation. A draft has no id and is a perfectly
   * initialised state, so the question needs its own answer — without one, coming back from
   * the settings page would re-bootstrap and drop somebody who was drafting into their
   * newest old thread.
   */
  bootstrappedFor: AgentId | null;
  /** The mobile drawer. Transient: choosing a conversation closes it again */
  sidebarOpen: boolean;
  /**
   * Whether the wide-screen sidebar is folded away. A preference rather than a state — it
   * is remembered per device, and none of the conversation traffic touches it.
   */
  sidebarCollapsed: boolean;

  bootstrap: (agent: AgentId) => Promise<void>;
  reset: () => void;
  refreshList: () => Promise<void>;
  newConversation: () => Promise<void>;
  /**
   * The id to act on, creating the conversation this draft stands for if it has none yet.
   *
   * A conversation is a row from the first message on, not from the moment somebody looked
   * at the chat page. Everything conversation-shaped on the server — the stream, the
   * message, an upload — needs the row first, so whoever is about to do one of those calls
   * this and works with what it returns.
   *
   * Returns null when the draft was abandoned while the create was in the air; the caller
   * has nothing to do in that case. Throws when the create itself failed, so the caller's
   * own error handling — which it has, because it was about to make a request — reports it.
   */
  ensureConversation: () => Promise<string | null>;
  select: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEffort: (effort: string) => Promise<void>;
  setThinking: (thinking: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setSidebar: (open: boolean) => void;
  /**
   * Show and hide the sidebar, whichever of the two it is at this width.
   *
   * One button says "hide the sidebar" and the viewport decides what that means: the drawer
   * shuts on a narrow screen, the column folds on a wide one. The caller cannot tell them
   * apart — the breakpoint is a CSS class, not something React knows — so both are set.
   */
  showSidebar: () => void;
  hideSidebar: () => void;
  bumpFiles: () => void;
  dismissError: () => void;
  _applyBatch: (batch: ServerEvent[]) => void;
}

/* ---- The SSE connection and rAF batching. Kept outside the store, so none of it becomes React state. ---- */

let closeSource: (() => void) | null = null;
let queue: ServerEvent[] = [];
let raf: number | null = null;

/**
 * The conversation being created right now, if one is.
 *
 * Two acts can turn the same draft into a row at almost the same instant: a second file
 * dropped while the first is still uploading, or a drop and a send. Both would POST, and the
 * second row would be the one nobody is looking at. Out here rather than in the store for
 * the same reason the stream is — it is not something React renders.
 */
let creating: Promise<string | null> | null = null;

/**
 * Which draft the store is on, counted rather than named.
 *
 * A create takes a round trip, and the person does not have to wait for it: they can click
 * another conversation, switch agent or sign out while it is in the air. The response would
 * then make a conversation active that nobody asked for, in a list belonging to the other
 * agent, and take the stream with it. Bumped by everything that moves off the draft, and
 * read back after the await to decide whether the answer still has a place to go.
 */
let draftEpoch = 0;

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

/**
 * Where the folded sidebar is remembered.
 *
 * On the device, like the theme and the language, and for the same reason: which of your
 * screens has room for a conversation list is not a fact about your account.
 */
const COLLAPSED_KEY = 'agentlodge-sidebar-collapsed';

export const useChat = create<ChatState>((set, get) => ({
  agent: 'claude',
  conversations: [],
  activeId: null,
  title: '',
  model: '',
  effort: '',
  thinking: true,
  queuePosition: 0,
  filesVersion: 0,
  messages: [],
  streaming: false,
  loading: false,
  connected: false,
  error: null,
  bootstrappedFor: null,
  sidebarOpen: false,
  sidebarCollapsed: localStorage.getItem(COLLAPSED_KEY) === '1',

  setSidebar: (open) => set({ sidebarOpen: open }),
  showSidebar: () => {
    localStorage.setItem(COLLAPSED_KEY, '0');
    set({ sidebarOpen: true, sidebarCollapsed: false });
  },
  hideSidebar: () => {
    localStorage.setItem(COLLAPSED_KEY, '1');
    set({ sidebarOpen: false, sidebarCollapsed: true });
  },
  bumpFiles: () => set((s) => ({ filesVersion: s.filesVersion + 1 })),
  dismissError: () => set({ error: null }),

  async bootstrap(agent) {
    closeStream();
    draftEpoch++;
    creating = null;
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
      // Claimed before the awaits below, not after them: React runs this effect twice in
      // development, and a flag set at the end lets the second pass straight through
      bootstrappedFor: agent,
    });
    await get().refreshList();
    const first = get().conversations[0];
    // Nothing to select is not a reason to create anything — the state set above is already
    // a draft, and it stays one until somebody says something
    if (first) await get().select(first.id);
  },

  reset() {
    closeStream();
    draftEpoch++;
    creating = null;
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
      // An agent whose CLI stops answering comes through here. Keeping the flag would mean
      // it never bootstraps again once it comes back
      bootstrappedFor: null,
    });
  },

  async refreshList() {
    try {
      set({ conversations: await api.listConversations(get().agent) });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  /**
   * Open a draft. Nothing is posted: the row is `ensureConversation`'s to make, when there
   * is finally something to put in it.
   *
   * The button used to post one on every press, so pressing it twice left two "New chat"
   * entries and pressing it again left a third, none of them with a message in them. A
   * conversation nobody has said anything in is not history yet, and three of them are just
   * three ways to lose the one that matters.
   *
   * Model, effort and thinking are left alone on purpose — a new conversation inherits the
   * settings on screen rather than asking again every time, and they travel with the draft
   * until it is created.
   */
  async newConversation() {
    closeStream();
    draftEpoch++;
    creating = null;
    set({
      activeId: null,
      title: '',
      messages: [],
      streaming: false,
      loading: false,
      queuePosition: 0,
      error: null,
      // On a phone this click came from inside the drawer
      sidebarOpen: false,
    });
  },

  async ensureConversation() {
    const open = get().activeId;
    if (open) return open;
    if (creating) return creating;

    const mine = draftEpoch;
    creating = (async () => {
      try {
        const conv = await api.createConversation(
          get().agent,
          get().model || undefined,
          get().effort || undefined,
          get().thinking,
        );

        /*
         * The draft this answers is gone — another conversation was clicked, the agent was
         * switched, somebody signed out. The row exists server-side and will show up in the
         * list; what must not happen is it becoming the active conversation, in whichever
         * list is on screen now, and taking the stream from the one that is.
         */
        if (draftEpoch !== mine) return null;

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
        }));
        /*
         * `messages` is not cleared and the three settings are not read back: the caller may
         * already have put its own message on screen, and a picker moved while this was in
         * the air holds the newer value. What was sent is what the row was created with; the
         * draft is the authority on the rest.
         */

        // Before the caller's own request goes out, so a turn's first events are not missed
        openStream(conv.id);
        return conv.id;
      } finally {
        creating = null;
      }
    })();
    return creating;
  },

  async select(id) {
    if (get().activeId === id && get().messages.length) return;
    // Whatever draft was being created is no longer the one on screen
    draftEpoch++;
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
    if (get().streaming) return;

    // Append the user's message optimistically, so the interface responds at once. Setting
    // `streaming` in the same breath is what stops a second Enter from sending twice — and,
    // now, from creating a second conversation.
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      blocks: [{ kind: 'text', blockId: 0, text, streaming: false }],
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, optimistic], streaming: true }));

    try {
      // The first message is the moment the row is worth having
      const id = await get().ensureConversation();
      if (!id) {
        // The draft was abandoned mid-flight; this message has nowhere to go and the
        // conversation now on screen is not the one it was typed into
        set((s) => ({
          streaming: false,
          messages: s.messages.filter((m) => m.id !== optimistic.id),
        }));
        return;
      }
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
    // Stop is on screen from the instant a message is sent, and for the first message that
    // instant is before the conversation exists. Wait for the id rather than doing nothing.
    const id = get().activeId ?? (creating ? await creating : null);
    if (!id) return;
    try {
      await api.abort(id);
    } catch {
      // Nothing was running any more — the turn finished between the click and this call.
      // Not worth a banner, and `void abort()` has nowhere to put a rejection.
    }
  },

  async rename(id, title) {
    await api.renameConversation(id, title);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
      title: s.activeId === id ? title : s.title,
    }));
  },

  /*
   * The three below share a shape: a draft keeps the value locally and hands it over when it
   * is created, and a conversation that exists is patched. `creating` is awaited rather than
   * treated as a draft — a picker moved while the create is in the air belongs to the row
   * that create is making, and setting it locally would leave the screen and the server
   * disagreeing about what the next turn runs on.
   */
  async setModel(model) {
    const id = get().activeId ?? (creating ? await creating : null);
    if (!id) {
      set({ model });
      return;
    }
    const prev = get().model;
    set({ model });
    try {
      await api.setModel(id, model);
    } catch (err) {
      set({ model: prev, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async setEffort(effort) {
    const id = get().activeId ?? (creating ? await creating : null);
    if (!id) {
      set({ effort });
      return;
    }
    const prev = get().effort;
    set({ effort });
    try {
      await api.setEffort(id, effort);
    } catch (err) {
      set({ effort: prev, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async setThinking(thinking) {
    const id = get().activeId ?? (creating ? await creating : null);
    if (!id) {
      set({ thinking });
      return;
    }
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
            // A subscription reports the size of the thinking instead of the thinking
            if (e.type === 'thinking.delta' && e.tokens && b?.kind === 'thinking') {
              b.tokens = (b.tokens ?? 0) + e.tokens;
            }
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
