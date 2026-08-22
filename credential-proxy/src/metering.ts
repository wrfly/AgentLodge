import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { Usage } from './usage.js';

/* There was no usage accounting here at all, only a concurrency semaphore. Without this, calling it a metering gateway would be a stretch. */

export interface Record_ {
  ts: number;
  provider: string;
  model: string;
  path: string;
  status: number;
  durationMs: number;
  stream: boolean;
  /** Who called: a short hash of their token, or the x-gateway-client header */
  client: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface Bucket {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function emptyBucket(): Bucket {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class Metering {
  /** key: `${day}|${provider}|${model}|${client}` */
  private buckets = new Map<string, Bucket>();
  private stream: fs.WriteStream | null = null;
  private currentDay = '';

  private sink(ts: number): fs.WriteStream | null {
    if (!config.meteringEnabled) return null;
    const day = dayOf(ts);
    if (this.stream && day === this.currentDay) return this.stream;
    this.stream?.end();
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.currentDay = day;
    this.stream = fs.createWriteStream(path.join(config.dataDir, `usage-${day}.jsonl`), {
      flags: 'a',
    });
    return this.stream;
  }

  record(r: Record_): void {
    const key = `${dayOf(r.ts)}|${r.provider}|${r.model || 'unknown'}|${r.client}`;
    const b = this.buckets.get(key) ?? emptyBucket();
    b.requests += 1;
    if (r.status >= 400) b.errors += 1;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cacheReadTokens += r.cacheReadTokens;
    b.cacheWriteTokens += r.cacheWriteTokens;
    this.buckets.set(key, b);

    try {
      this.sink(r.ts)?.write(JSON.stringify(r) + '\n');
    } catch {
      /* A failed write must not affect the request being forwarded */
    }
  }

  summary(): Array<Record<string, unknown>> {
    return [...this.buckets.entries()]
      .map(([key, b]) => {
        const [day, provider, model, client] = key.split('|');
        return { day, provider, model, client, ...b };
      })
      .sort((a, b) => String(b.day).localeCompare(String(a.day)));
  }

  close(): void {
    this.stream?.end();
  }
}

export const metering = new Metering();

export function usageToRecord(
  base: Omit<Record_, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'model'> & {
    model?: string;
  },
  usage: Usage,
): Record_ {
  return {
    ...base,
    model: usage.model ?? base.model ?? 'unknown',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}
