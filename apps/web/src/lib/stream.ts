import type { ServerEvent } from './protocol';
import { auth, getAccessToken } from './api';

interface StreamOptions {
  conversationId: string;
  onEvent: (e: ServerEvent) => void;
  onStatus: (connected: boolean) => void;
}

/**
 * A hand-rolled SSE client.
 *
 * The browser's own EventSource is not used, for two reasons:
 *  1. It cannot send an Authorization header. A one-shot ticket in the query string gets
 *     around that, but on its automatic reconnect it reuses the same already-spent
 *     ticket — a 401 loop with no way out.
 *  2. We need to refresh an expired access token *before* reconnecting, and EventSource
 *     offers no hook for that.
 *
 * fetch + ReadableStream makes both possible. The price is framing SSE and backing off
 * ourselves.
 */
export function openEventStream(opts: StreamOptions): () => void {
  const controller = new AbortController();
  let lastEventId: string | null = null;
  let closed = false;
  let attempt = 0;

  async function connect(): Promise<void> {
    while (!closed) {
      try {
        const headers: Record<string, string> = {};
        const token = getAccessToken();
        if (token) headers.authorization = `Bearer ${token}`;
        if (lastEventId) headers['last-event-id'] = lastEventId;

        const res = await fetch(`/api/conversations/${opts.conversationId}/stream`, {
          headers,
          credentials: 'include',
          signal: controller.signal,
        });

        if (res.status === 401) {
          // The token expired: get another and retry, and give up entirely if we cannot
          if (!(await auth.restore())) return;
          continue;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

        attempt = 0;
        opts.onStatus(true);
        await pump(res.body);
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        void err;
      }

      opts.onStatus(false);
      if (closed) return;
      // Exponential backoff, capped at 10s
      attempt += 1;
      const delay = Math.min(500 * 2 ** (attempt - 1), 10_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  async function pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let data: string | null = null;
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) lastEventId = line.slice(4).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
          // Lines like ": comment" are simply skipped
        }
        if (!data) continue;
        try {
          opts.onEvent(JSON.parse(data) as ServerEvent);
        } catch {
          /* A frame we cannot parse is dropped */
        }
      }
    }
  }

  void connect();

  return () => {
    closed = true;
    controller.abort();
  };
}
