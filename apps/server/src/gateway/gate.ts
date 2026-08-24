/**
 * The upstream concurrency gate.
 *
 * The goal: never more than maxConcurrency requests in flight upstream at once (3 by
 * default), while stopping one user's agent loop from starving everyone else.
 *
 * Three concurrent is not three users. An agentic conversation alternates between calling
 * the API and running tools, and a slot is free while a tool runs — so three slots
 * comfortably carry six to ten active users.
 */

export interface GateConfig {
  maxConcurrency: number;
  maxQueueDepth: number;
  queueTimeoutMs: number;
  leaseMaxMs: number;
  perUserInflightMax: number;
}

export interface Lease {
  release(): void;
  readonly waitedMs: number;
}

export class OverloadedError extends Error {
  constructor() {
    super('The gateway queue is full');
  }
}
export class QueueTimeoutError extends Error {
  constructor() {
    super('Timed out waiting in the queue');
  }
}
export class AbortedError extends Error {
  constructor() {
    super('The request was cancelled');
  }
}

export interface AcquireRequest {
  userId: string;
  turnId: string;
  /** 0 for an interactive conversation, 1 for background work such as title generation. 0 goes first. */
  priority: 0 | 1;
  signal?: AbortSignal;
  /** Called while queued, so the frontend can be told how many are ahead */
  onQueued?: (position: number) => void;
}

interface Waiter extends AcquireRequest {
  enqueuedAt: number;
  resolve: (lease: Lease) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  settled: boolean;
}

export interface GateStats {
  active: number;
  queued: number;
  effectiveMax: number;
  max: number;
  cooldownUntil: number;
  totalGranted: number;
  totalThrottled: number;
  waitMsP50: number;
  waitMsP95: number;
}

export class UpstreamGate {
  private effectiveMax: number;
  private readonly active = new Set<symbol>();
  /** userId to that user's queued requests */
  private readonly queues = new Map<string, Waiter[]>();
  private readonly hiPri: Waiter[] = [];
  private readonly userInflight = new Map<string, number>();
  private cursor = 0;
  private queuedCount = 0;

  private consecutiveOk = 0;
  private cooldownUntil = 0;
  private totalGranted = 0;
  private totalThrottled = 0;
  /** The last 200 wait times, for percentiles */
  private readonly waits: number[] = [];

  constructor(private readonly cfg: GateConfig) {
    this.effectiveMax = cfg.maxConcurrency;
  }

  acquire(req: AcquireRequest): Promise<Lease> {
    return new Promise<Lease>((resolve, reject) => {
      if (req.signal?.aborted) return reject(new AbortedError());
      if (this.queuedCount >= this.cfg.maxQueueDepth) return reject(new OverloadedError());

      const w: Waiter = { ...req, enqueuedAt: Date.now(), resolve, reject, settled: false };

      if (this.canGrantNow(req.userId)) return this.grant(w);

      (req.priority === 0 ? this.hiPri : this.queueFor(req.userId)).push(w);
      this.queuedCount += 1;
      req.onQueued?.(this.queuedCount);

      w.timer = setTimeout(() => this.drop(w, new QueueTimeoutError()), this.cfg.queueTimeoutMs);
      if (req.signal) {
        w.onAbort = () => this.drop(w, new AbortedError());
        req.signal.addEventListener('abort', w.onAbort, { once: true });
      }
    });
  }

  private queueFor(userId: string): Waiter[] {
    let q = this.queues.get(userId);
    if (!q) {
      q = [];
      this.queues.set(userId, q);
    }
    return q;
  }

  private canGrantNow(userId: string): boolean {
    if (Date.now() < this.cooldownUntil) return false;
    return (
      this.active.size < this.effectiveMax &&
      (this.userInflight.get(userId) ?? 0) < this.cfg.perUserInflightMax
    );
  }

  private grant(w: Waiter): void {
    if (w.settled) return;
    w.settled = true;
    if (w.timer) clearTimeout(w.timer);
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);

    const key = Symbol(w.turnId);
    this.active.add(key);
    this.userInflight.set(w.userId, (this.userInflight.get(w.userId) ?? 0) + 1);
    this.totalGranted += 1;

    const waitedMs = Date.now() - w.enqueuedAt;
    this.waits.push(waitedMs);
    if (this.waits.length > 200) this.waits.shift();

    let released = false;
    // A watchdog: reclaim a slot held past the limit, so one wedged request cannot own
    // it forever
    const watchdog = setTimeout(() => release(), this.cfg.leaseMaxMs);

    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(watchdog);
      this.active.delete(key);
      const n = (this.userInflight.get(w.userId) ?? 1) - 1;
      if (n <= 0) this.userInflight.delete(w.userId);
      else this.userInflight.set(w.userId, n);
      this.schedule();
    };

    w.resolve({ release, waitedMs });
  }

  private drop(w: Waiter, err: Error): void {
    if (w.settled) return;
    w.settled = true;
    if (w.timer) clearTimeout(w.timer);
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
    this.removeFromQueues(w);
    w.reject(err);
  }

  private removeFromQueues(w: Waiter): void {
    const from = w.priority === 0 ? this.hiPri : this.queues.get(w.userId);
    if (!from) return;
    const i = from.indexOf(w);
    if (i >= 0) {
      from.splice(i, 1);
      this.queuedCount -= 1;
    }
    if (w.priority !== 0 && from.length === 0) this.queues.delete(w.userId);
  }

  /** Priority 0 takes the fast lane; the rest go round-robin by user */
  private schedule(): void {
    while (this.active.size < this.effectiveMax && Date.now() >= this.cooldownUntil) {
      const w = this.takeHiPri() ?? this.takeRoundRobin();
      if (!w) break;
      this.queuedCount -= 1;
      this.grant(w);
    }
  }

  private takeHiPri(): Waiter | undefined {
    while (this.hiPri.length) {
      const w = this.hiPri.shift()!;
      if (w.settled) continue;
      if ((this.userInflight.get(w.userId) ?? 0) >= this.cfg.perUserInflightMax) {
        // This user is at their limit; put it back and let somebody else go
        this.hiPri.push(w);
        return undefined;
      }
      return w;
    }
    return undefined;
  }

  /**
   * Round-robin by user rather than global FIFO.
   *
   * An agent loop fires several calls in quick succession, and under FIFO one user on a
   * long task would sit at the head of the queue indefinitely while nobody else got in.
   */
  private takeRoundRobin(): Waiter | undefined {
    const users = [...this.queues.keys()];
    if (!users.length) return undefined;
    for (let i = 0; i < users.length; i++) {
      const u = users[(this.cursor + i) % users.length]!;
      if ((this.userInflight.get(u) ?? 0) >= this.cfg.perUserInflightMax) continue;
      const q = this.queues.get(u);
      if (!q?.length) continue;
      const w = q.shift()!;
      if (q.length === 0) this.queues.delete(u);
      this.cursor = (this.cursor + i + 1) % Math.max(users.length, 1);
      if (w.settled) {
        this.queuedCount -= 1;
        continue;
      }
      return w;
    }
    return undefined;
  }

  /**
   * AIMD driven by what the upstream says: halve on a rate limit, climb back slowly on a
   * run of successes. Three is a conservative guess; it finds the real threshold itself.
   */
  reportUpstream(status: number, retryAfterMs?: number): void {
    if (status === 429 || status === 503 || status === 529) {
      this.effectiveMax = Math.max(1, Math.floor(this.effectiveMax / 2));
      this.consecutiveOk = 0;
      this.totalThrottled += 1;
      this.cooldownUntil = Date.now() + (retryAfterMs ?? 5000);
      setTimeout(() => this.schedule(), (retryAfterMs ?? 5000) + 50).unref();
    } else if (status < 400) {
      this.consecutiveOk += 1;
      if (this.consecutiveOk >= 20 && this.effectiveMax < this.cfg.maxConcurrency) {
        this.effectiveMax += 1;
        this.consecutiveOk = 0;
        this.schedule();
      }
    }
  }

  setMaxConcurrency(n: number): void {
    this.cfg.maxConcurrency = Math.max(1, n);
    this.effectiveMax = Math.min(this.effectiveMax, this.cfg.maxConcurrency);
    if (this.effectiveMax < this.cfg.maxConcurrency) this.effectiveMax = this.cfg.maxConcurrency;
    this.schedule();
  }

  stats(): GateStats {
    const sorted = [...this.waits].sort((a, b) => a - b);
    const at = (p: number) => (sorted.length ? (sorted[Math.floor(sorted.length * p)] ?? 0) : 0);
    return {
      active: this.active.size,
      queued: this.queuedCount,
      effectiveMax: this.effectiveMax,
      max: this.cfg.maxConcurrency,
      cooldownUntil: this.cooldownUntil,
      totalGranted: this.totalGranted,
      totalThrottled: this.totalThrottled,
      waitMsP50: at(0.5),
      waitMsP95: at(0.95),
    };
  }
}

/**
 * One gate per upstream.
 *
 * The limits belong to the upstream, not to us: a subscription's rate limit and a paid
 * API's are unrelated numbers, and a shared pool would make one of them queue behind the
 * other for no reason. Each pool keeps its own in-flight count and its own AIMD state, so
 * an upstream answering 429 narrows itself and leaves the rest alone.
 *
 * The configured ceiling is shared — it is the answer to "how many at once do we allow",
 * which is a deployment-wide decision — and each pool adapts downward from it on its own.
 */
export class GatePool {
  private readonly gates = new Map<string, UpstreamGate>();

  constructor(private readonly cfg: GateConfig) {}

  /** The gate for one upstream, created the first time a request goes there */
  for(providerId: string): UpstreamGate {
    let gate = this.gates.get(providerId);
    if (!gate) {
      gate = new UpstreamGate({ ...this.cfg });
      this.gates.set(providerId, gate);
    }
    return gate;
  }

  /** Applies to every pool, including the ones that do not exist yet */
  setMaxConcurrency(n: number): void {
    this.cfg.maxConcurrency = Math.max(1, n);
    for (const gate of this.gates.values()) gate.setMaxConcurrency(this.cfg.maxConcurrency);
  }

  /** What the console draws: one row per upstream that has seen traffic */
  stats(): Array<GateStats & { providerId: string }> {
    return [...this.gates.entries()].map(([providerId, gate]) => ({ providerId, ...gate.stats() }));
  }

  /** The ceiling every pool starts from */
  max(): number {
    return this.cfg.maxConcurrency;
  }
}
