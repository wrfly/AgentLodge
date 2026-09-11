import { create } from 'zustand';
import { ApiError, api } from '../lib/api';
import { openEventStream } from '../lib/stream';
import { useQuota } from './quota';
import type {
  ThreadSummary,
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

/**
 * A passage and a question about it, as one prompt.
 *
 * Markdown quotation rather than a sentence introducing it: the agent reads the same
 * convention everybody else does, and the thread's own transcript then shows the passage as
 * a quote above the question rather than as a wall of somebody else's words.
 */
export function quotedPrompt(quote: string, question: string): string {
  const quoted = quote.split('\n').map((l) => `> ${l}`).join('\n');
  return `${quoted}\n\n${question.trim()}`;
}

/** Everything from this message on, gone — the same cut the server just made */
/**
 * Everything from this message on, gone — the same cut the server just made.
 *
 * A miss means the message being cut at is not on screen, which is a disagreement with the
 * server, not an instruction to keep everything: returning the list whole would then append
 * the re-asked question below the one it replaces and show it twice. Dropping the tail is
 * the safe reading of "I do not know where this is".
 */
function cutAt(messages: ChatMessage[], messageId: string): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === messageId);
  return i === -1 ? [] : messages.slice(0, i);
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
   * Something worth saying that is not a failure — a fork whose workspace did not come
   * along, say. Kept apart from `error` so a red banner is never the messenger.
   */
  notice: string | null;
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
  /* The sub-conversation panel: a thread on a selection, sharing the parent's session */
  subOpen: boolean;
  subConversationId: string | null;
  subMessages: ChatMessage[];
  subStreaming: boolean;
  /** The threads in this conversation, for the list the panel shows when none is open */
  threads: ThreadSummary[];
  /**
   * A passage waiting for its question.
   *
   * Set by "ask my own question", which opens the panel on the quote with the question still
   * to be written. Asking about a passage with the default question skips this state
   * entirely — it goes straight to a thread.
   */
  subQuote: string | null;
  /**
   * Half-typed text in the panel: the question for a passage, and one draft per thread.
   *
   * In the store rather than in the panel because the panel unmounts — opening the files
   * panel takes the same column, and leaving the chat for another page takes the whole pane.
   * A follow-up typed into a thread and not yet sent used to be gone when you came back, and
   * so did a question rewritten over the default.
   */
  subQuestion: string;
  subDrafts: Record<string, string>;
  /**
   * Text on its way into the main composer, and the tick that says it is a fresh one.
   *
   * A thread is isolated on purpose, so anything worth keeping has to be carried over
   * deliberately. It lands in the composer rather than being posted: the person who just
   * read the answer is the one who knows which part of it matters, and they get to cut it
   * down and say what they want done with it before it becomes a turn.
   *
   * The counter is what makes carrying the same passage twice a second event.
   */
  carried: { text: string; nonce: number } | null;
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
  /** Correct the newest question: its answer goes and the corrected question is re-asked */
  /** Resolves true when the edit landed. False means the text is still the caller's to keep. */
  editMessage: (messageId: string, text: string) => Promise<boolean>;
  setSubQuestion: (text: string) => void;
  setSubDraft: (conversationId: string, text: string) => void;
  /** Ask the newest question again, optionally somewhere else */
  retry: (opts?: { model?: string; effort?: string }) => Promise<void>;
  /** Open the panel on the list of threads, without opening any of them */
  showThreads: () => Promise<void>;
  /** Open a thread that already exists */
  openThread: (id: string) => Promise<void>;
  /** Put a thread's answer into the main composer, for the reader to trim and send */
  carryIntoChat: (text: string) => void;
  /** The composer has taken it */
  clearCarried: () => void;
  /** Open the panel on a passage, with the question still to be written */
  quoteForQuestion: (quote: string) => void;
  /** Open a thread: the passage as context, and a question about it */
  openSub: (quote: string, question: string) => Promise<void>;
  /** Ask the sub-conversation something else */
  sendSub: (text: string) => Promise<void>;
  /** Stop a thread's turn */
  abortSub: () => Promise<void>;
  closeSub: () => void;
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
  dismissNotice: () => void;
  _applyBatch: (batch: ServerEvent[]) => void;
  _applySubBatch: (batch: ServerEvent[]) => void;
}

/* ---- The SSE connections and rAF batching. Kept outside the store, so none of it becomes React state. ----
 * Two channels: the main conversation, and the sub-conversation panel. They are independent
 * SSE streams — the server publishes each conversation's events to its own channel — and
 * each has its own queue and frame so a busy sub-conversation never stalls the main one. */

let closeMain: (() => void) | null = null;
let queueMain: ServerEvent[] = [];
let rafMain: number | null = null;

let closeSub: (() => void) | null = null;
let queueSub: ServerEvent[] = [];
let rafSub: number | null = null;

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

/**
 * The same idea for the side panel, which has four ways to change what it is showing —
 * the thread list, a thread from it, a passage picked in the transcript, a new thread being
 * opened — and every one of them awaits the network first.
 *
 * Without it each await wrote into whatever the panel had become. Click thread A then
 * thread B and, if A's fetch was the slower, A's messages rendered under B's stream while
 * the composer posted to B. Pick a second passage while the first is still opening and the
 * question you were typing was erased by the thread for the first one.
 */
let panelEpoch = 0;

/**
 * The thread currently being opened, if any — one passage means one thread.
 *
 * Nothing read `subStreaming` to disable the Ask button, and the question form stays up
 * until the call succeeds, so pressing Enter twice opened two threads, started two turns and
 * charged for both. The second stream closed the first, which then generated to completion
 * with nobody watching.
 */
let openingSub: Promise<unknown> | null = null;

function flushMain() {
  rafMain = null;
  const batch = queueMain;
  queueMain = [];
  if (batch.length) useChat.getState()._applyBatch(batch);
}

function flushSub() {
  rafSub = null;
  const batch = queueSub;
  queueSub = [];
  if (batch.length) useChat.getState()._applySubBatch(batch);
}

function enqueueMain(e: ServerEvent) {
  queueMain.push(e);
  if (rafMain === null) rafMain = requestAnimationFrame(flushMain);
}

function enqueueSub(e: ServerEvent) {
  queueSub.push(e);
  if (rafSub === null) rafSub = requestAnimationFrame(flushSub);
}

/**
 * Everything the panel is showing, dropped along with its stream.
 *
 * `closeStreams` is what every reset path calls, and it used to leave the panel's state
 * standing: switching conversation, signing out or pressing "New chat" left a thread on
 * screen with a dead stream behind it, and anything typed into it went to a conversation
 * nobody was listening to. `subStreaming` latches on send and is cleared by an event that
 * would never arrive, so the composer stayed disabled and the answer never appeared.
 */
function forgetPanel() {
  panelEpoch++;
  useChat.setState({
    subOpen: false,
    subQuote: null,
    subConversationId: null,
    subMessages: [],
    subStreaming: false,
    threads: [],
    // Drafts belong to threads, and the threads belong to the conversation being left
    subQuestion: '',
    subDrafts: {},
  });
}

function closeStreams() {
  forgetPanel();
  closeMain?.();
  closeMain = null;
  queueMain = [];
  if (rafMain !== null) {
    cancelAnimationFrame(rafMain);
    rafMain = null;
  }
  closeSubStream();
}

function openStream(conversationId: string) {
  closeMain?.();
  closeMain = openEventStream({
    conversationId,
    onEvent: enqueueMain,
    onStatus: (connected) => useChat.setState({ connected }),
  });
}

/** Just the panel's stream: closing it must not disconnect the conversation behind it */
function closeSubStream() {
  closeSub?.();
  closeSub = null;
  queueSub = [];
  if (rafSub !== null) {
    cancelAnimationFrame(rafSub);
    rafSub = null;
  }
}

function openSubStream(conversationId: string) {
  closeSub?.();
  closeSub = openEventStream({
    conversationId,
    onEvent: enqueueSub,
    onStatus: () => {}, // the panel is not the connection status indicator
  });
}

/**
 * Fold a frame's worth of events into a transcript.
 *
 * Out here, and taking the transcript as an argument, because there are two of them: the
 * conversation and the sub-conversation opened on a selection. The event shapes are the same
 * and the folding is a hundred and fifty lines, so the alternative was two copies that would
 * drift the first time anybody touched one of them.
 *
 * The three fields only the main transcript has — the title, the list it appears in, the
 * queue position shown in the composer — are returned either way and ignored by the caller
 * that has no use for them.
 */
function applyEvents(
  batch: ServerEvent[],
  state: {
  messages: ChatMessage[];
  streaming: boolean;
  queuePosition: number;
  title: string;
  conversations: ConversationSummary[];
  },
): {
  messages: ChatMessage[];
  streaming: boolean;
  queuePosition: number;
  title: string;
  conversations: ConversationSummary[];
} {
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
          void useChat.getState().refreshList();
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
  notice: null,
  bootstrappedFor: null,
  subOpen: false,
  subConversationId: null,
  subMessages: [],
  subStreaming: false,
  threads: [],
  subQuote: null,
  subQuestion: '',
  subDrafts: {},
  carried: null,
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
  dismissNotice: () => set({ notice: null }),

  async bootstrap(agent) {
    closeStreams();
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
    closeStreams();
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
    closeStreams();
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
    // A thread belongs to the conversation it was opened in, so it does not follow this one
    closeSubStream();
    forgetPanel();
    /*
     * The conversation is not in the URL, so navigating to it is invisible to the route
     * effect that keeps the sidebar's quota bar current. The bar reads a figure that only a
     * `quota.updated` event moves, and those are published per conversation — so a turn that
     * ran in the one being opened, from the CLI or another tab, is spend the bar has never
     * heard of, next to a header that already shows it.
     */
    void useQuota.getState().refresh();
    set({ loading: true, activeId: id, messages: [], sidebarOpen: false, notice: null });
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
      /*
       * The optimistic message goes, but what it said comes back to the composer.
       *
       * The server treats "busy" as a question about the whole family, so sending here while
       * a thread is generating is a 409 — and dropping the row on a 409 took the typed text
       * off the screen and out of the box, which had already cleared on submit. It was gone
       * for a reason that had nothing to do with it.
       */
      set((s) => ({
        streaming: false,
        error: err instanceof Error ? err.message : String(err),
        carried: { text, nonce: (s.carried?.nonce ?? 0) + 1 },
        messages: s.messages.filter((m) => m.id !== optimistic.id),
      }));
    }
  },

  /*
   * Both of these cut the record and start a turn, so both drop the messages the server is
   * about to drop and let the stream fill in what replaces them. Optimism would be wrong
   * here: what an edit does depends on where the message was, and the server is the one that
   * knows — guessing and then correcting would flicker between two different conversations.
   */
  /**
   * Answers "did this land", so the editor can stay open over text somebody rewrote.
   *
   * Closing it either way threw the rewrite away on any failure — a refused quota, a
   * conversation that got busy — and re-opening resets the field to the original. Same
   * reasoning as `send`, which hands typed text back through `carried`.
   */
  async editMessage(messageId, text) {
    const id = get().activeId;
    if (!id || get().streaming) return false;
    try {
      const r = await api.editMessage(id, messageId, text);
      /*
       * Still the conversation this was typed in. Another one clicked while the POST was in
       * the air used to have its whole transcript replaced by this single question — `cutAt`
       * finds no such message there and returns nothing — and left it streaming against an
       * idle stream, so the composer stayed on "Generating…" with a Stop button that aborted
       * a conversation nobody was watching.
       */
      if (get().activeId !== id) return true;
      set((s) => ({
        messages: [...cutAt(s.messages, messageId), toChatMessage(r.userMessage)],
        streaming: true,
      }));
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) void useQuota.getState().refresh();
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  async retry(opts = {}) {
    const id = get().activeId;
    if (!id || get().streaming) return;
    const asked = [...get().messages].reverse().find((m) => m.role === 'user');
    try {
      const r = await api.retry(id, opts);
      if (get().activeId !== id) return;
      set((s) => ({
        messages: [...(asked ? cutAt(s.messages, asked.id) : s.messages), toChatMessage(r.userMessage)],
        streaming: true,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) void useQuota.getState().refresh();
      set({ error: err instanceof Error ? err.message : String(err) });
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
      closeStreams();
      const next = rest[0];
      if (next) await get().select(next.id);
      else await get().newConversation();
    }
  },

  /**
   * Open a thread on a selection.
   *
   * The selection is the question, verbatim — whatever somebody highlighted is what they
   * want to ask about, and rewording it here would put words in their mouth. The server
   * gives the child the parent's workspace and CLI session, so the thread can see the files
   * and remembers the conversation it was opened from; what it does not do is put its
   * answers in the main transcript, which is the whole point of asking off to one side.
   */
  /*
   * The panel with nothing open in it is the list, which is also the only way back to a
   * thread once it has been closed — threads are kept out of the sidebar, so without this
   * one sits on the server with its answer in it and nothing pointing at it.
   */
  async showThreads() {
    const id = get().activeId;
    if (!id) return;
    closeSubStream();
    const mine = ++panelEpoch;
    set({ subOpen: true, subQuote: null, subConversationId: null, subMessages: [], subStreaming: false });
    try {
      const threads = await api.threads(id);
      if (panelEpoch !== mine) return;
      set({ threads });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async openThread(id) {
    // Before anything else. It is the only thing that closes the stream the panel is on, and
    // leaving it open means its deltas land in the panel under the new thread's name while
    // the composer posts to the new one
    closeSubStream();
    const mine = ++panelEpoch;
    set({ subOpen: true, subQuote: null, subConversationId: id, subMessages: [], subStreaming: false });
    try {
      const conv = await api.getConversation(id);
      if (panelEpoch !== mine) return;
      set({ subMessages: conv.messages.map(toChatMessage) });
      openSubStream(id);
    } catch (err) {
      if (panelEpoch !== mine) return;
      /*
       * Back to the list. Leaving the id set left the panel showing an empty thread with a
       * live composer: a question typed into it posted fine, latched `subStreaming`, and
       * with no stream subscribed nothing ever cleared it. The answer was generated and
       * stored, the composer stayed disabled, and nothing on screen said either.
       */
      set({ subConversationId: null, error: err instanceof Error ? err.message : String(err) });
    }
  },

  carryIntoChat(text) {
    set((s) => ({ carried: { text, nonce: (s.carried?.nonce ?? 0) + 1 } }));
  },

  clearCarried() {
    set({ carried: null });
  },

  setSubQuestion(text) {
    set({ subQuestion: text });
  },

  setSubDraft(conversationId, text) {
    set((s) => ({ subDrafts: { ...s.subDrafts, [conversationId]: text } }));
  },

  quoteForQuestion(quote) {
    closeSubStream();
    panelEpoch++;
    // Cleared, so the panel fills in the default for this passage rather than showing the
    // question written for the last one
    set({ subOpen: true, subQuote: quote, subConversationId: null, subMessages: [], subStreaming: false, subQuestion: '' });
  },

  /**
   * The passage goes as a quotation and the question goes after it.
   *
   * Sending the selection on its own was the first shape of this, and it was not a question:
   * the agent got a paragraph with no idea what was being asked about it, and answered from
   * a guess that only looked right because the thread inherits the conversation's context.
   */
  async openSub(quote, question) {
    const parent = get().activeId;
    if (!parent) return;
    // One passage, one thread. Two calls would be two threads, two turns and two bills.
    if (openingSub) return openingSub.then(() => undefined);
    const mine = ++panelEpoch;
    set({ subOpen: true, subMessages: [], subStreaming: true, notice: null });
    openingSub = (async () => {
      try {
        const r = await api.createSubConversation(parent, quotedPrompt(quote, question));
        /*
         * The panel moved while this was in the air — another passage was picked, a thread
         * was opened from the list, the conversation was switched. The thread exists and is
         * answering; it belongs in the list, not on top of whatever is there now.
         */
        if (panelEpoch !== mine) {
          if (get().activeId === parent) void api.threads(parent).then((threads) => set({ threads })).catch(() => {});
          return;
        }
        // Only now: a thread that failed to open should leave the passage and the question
        // where they were, not send somebody back to the transcript to find the paragraph again
        set({
          subQuote: null,
          subConversationId: r.conversationId,
          subMessages: r.conversation.messages.map(toChatMessage),
        });
        openSubStream(r.conversationId);
        void api.threads(parent).then((threads) => {
          if (get().activeId === parent) set({ threads });
        }).catch(() => {});
      } catch (err) {
        if (err instanceof ApiError && err.status === 402) void useQuota.getState().refresh();
        if (panelEpoch !== mine) return;
        set({ subStreaming: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        openingSub = null;
      }
    })();
    return openingSub.then(() => undefined);
  },

  async sendSub(text) {
    const id = get().subConversationId;
    if (!id || get().subStreaming) return;
    const optimistic: ChatMessage = {
      id: `local-sub-${Date.now()}`,
      role: 'user',
      blocks: [{ kind: 'text', blockId: 0, text, streaming: false }],
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ subMessages: [...s.subMessages, optimistic], subStreaming: true }));
    try {
      const { userMessage } = await api.sendMessage(id, text);
      set((s) => ({
        subMessages: s.subMessages.map((m) =>
          m.id === optimistic.id ? toChatMessage(userMessage) : m,
        ),
      }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) void useQuota.getState().refresh();
      set((s) => ({
        subStreaming: false,
        error: err instanceof Error ? err.message : String(err),
        subMessages: s.subMessages.filter((m) => m.id !== optimistic.id),
      }));
    }
  },

  /**
   * Shut the panel, keep the thread.
   *
   * The conversation stays on the server with its messages — throwing one away because a
   * panel was closed would lose an answer somebody may be halfway through reading — and it
   * is reached again from the list, which is what the panel shows with nothing open in it.
   * Asking about the same passage would not do: that opens a second thread.
   */
  /**
   * Stop a thread's turn.
   *
   * The main Stop button reads the main `streaming` and aborts `activeId`, so a thread that
   * hung left the panel disabled with nothing to press. The server's abort walks the family,
   * so it is the same call with the thread's id.
   */
  async abortSub() {
    const id = get().subConversationId;
    if (!id) return;
    await api.abort(id);
    set({ subStreaming: false });
  },

  closeSub() {
    closeSubStream();
    panelEpoch++;
    set({ subOpen: false, subQuote: null, subConversationId: null, subMessages: [], subStreaming: false });
  },

  _applyBatch(batch) {
    set((state) => applyEvents(batch, state));
  },

  /**
   * The same folding, against the panel's own transcript.
   *
   * Only the messages and whether it is streaming are kept: the sub-conversation is not in
   * the sidebar, its title is nobody's heading, and the queue position belongs to the
   * composer at the bottom of the main column.
   */
  _applySubBatch(batch) {
    set((state) => {
      const r = applyEvents(batch, {
        messages: state.subMessages,
        streaming: state.subStreaming,
        queuePosition: state.queuePosition,
        title: state.title,
        conversations: state.conversations,
      });
      return { subMessages: r.messages, subStreaming: r.streaming };
    });
  },
}));
