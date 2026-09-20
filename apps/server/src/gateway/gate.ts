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
  /**
   * The console's value for the above, asked for rather than passed in.
   *
   * The gate runs in the gateway container and the setting is written from the app one, so
   * a value captured at construction is a restart behind whatever the page says. Returning
   * undefined — no row, no environment variable, a database that will not answer — falls
   * back to `perUserInflightMax`, which is what every test and the bare-process path use.
   */
  readPerUserInflightMax?: () => number | undefined;
  /**
   * The console's value for `maxConcurrency`, asked for the same way and for a second
   * reason: it is what makes a limit typed into the page survive a restart.
   *
   * `setMaxConcurrency` on its own only ever moved a number inside this process. The
   * gateway container came back on `MAX_UPSTREAM_CONCURRENCY`, so an administrator who had
   * raised the gate to twelve was silently at three again after the next deploy — with
   * nothing in the console to say so, because the console reads the same process.
   *
   * Undefined falls back to `maxConcurrency`, which is what every test and the bare-process
   * path use.
   */
  readMaxConcurrency?: () => number | undefined;
  /**
   * Whether the upstream is allowed to narrow the gate below that ceiling.
   *
   * Undefined means yes: adapting is what the gate has always done, and a switch that
   * cannot be read must not be the reason it stops backing off from an upstream that is
   * rate-limiting it. False pins the gate — see `limits`.
   */
  readAdaptiveConcurrency?: () => boolean | undefined;
}

/**
 * The administrator's ceiling: what the console says now, or the configured fallback.
 *
 * Same order as `perUserMax` below and for the same reason — the setting is written in the
 * app container and read here — with the same floor, because the fallback comes from an
 * environment variable and nothing validates one.
 */
function ceilingOf(cfg: GateConfig): number {
  const live = cfg.readMaxConcurrency?.();
  if (live !== undefined && live >= 1) return live;
  return cfg.maxConcurrency >= 1 ? cfg.maxConcurrency : 1;
}

/** Whether the upstream may narrow us. Nothing to say means yes. */
function adaptiveIn(cfg: GateConfig): boolean {
  return cfg.readAdaptiveConcurrency?.() ?? true;
}

/**
 * The per-user cap: what the console says now, or the configured value when it says nothing.
 *
 * Alongside `ceilingOf` rather than inside the gate because the console has to be able to
 * draw it before any upstream has seen traffic — the two limits are configured together, and
 * a page that can only show one of them until somebody sends a request is the page that made
 * "the limit says twelve and the pools say two" hard to read in the first place.
 */
function perUserOf(cfg: GateConfig): number {
  const live = cfg.readPerUserInflightMax?.();
  if (live !== undefined && live > 0) return live;
  /*
   * A floor on the fallback, because it comes from an environment variable and nothing
   * validates one. `PER_USER_INFLIGHT_MAX=0` — a reasonable-looking way to ask for "no
   * per-user limit" — made `inflight < 0` false for everyone, so every request on every
   * upstream queued and failed two minutes later. `unlimited` gave NaN and the same
   * outage. Zero is not a limit anybody can mean here; one is the smallest that is.
   */
  return cfg.perUserInflightMax >= 1 ? cfg.perUserInflightMax : 1;
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
  /** True while the upstream is not allowed to narrow this gate: effectiveMax stays at max */
  pinned: boolean;
  cooldownUntil: number;
  totalGranted: number;
  totalThrottled: number;
  waitMsP50: number;
  waitMsP95: number;
}

export class UpstreamGate {
  private readonly active = new Set<symbol>();
  /** userId to that user's queued requests */
  private readonly queues = new Map<string, Waiter[]>();
  private readonly hiPri: Waiter[] = [];
  private readonly userInflight = new Map<string, number>();
  private cursor = 0;
  private queuedCount = 0;

  private consecutiveOk = 0;
  private cooldownUntil = 0;
  /**
   * The limit the *upstream* has imposed through AIMD, or null when no backoff
   * is in effect. Held separately from the configured ceiling, which is the
   * *administrator's* limit, because the two answer different questions and an
   * admin can move theirs underneath ours at any moment.
   *
   * Neither "effectiveMax vs the ceiling" nor a boolean flag survives that.
   * Lower the ceiling onto a backed-off value and the gate reads as recovered;
   * lower it below and the AIMD climb — guarded on effectiveMax < ceiling —
   * can never run again, so the backoff never lifts. Keeping the throttle as
   * its own number makes ceiling changes pure: they clamp what is served
   * without editing what the upstream told us.
   */
  private throttleLimit: number | null = null;
  private totalGranted = 0;
  private totalThrottled = 0;
  /** The last 200 wait times, for percentiles */
  private readonly waits: number[] = [];

  constructor(private readonly cfg: GateConfig) {}

  /**
   * Both limits, resolved together and once per admission pass.
   *
   * `ceiling` is the administrator's number and `effective` is what the gate actually runs
   * at: the lower of the two, or the ceiling itself when the gate is pinned. Returned as a
   * pair rather than read from a getter per waiter because both are database reads now — a
   * drain over a deep queue would otherwise be two per person in it.
   */
  private limits(): { ceiling: number; effective: number; pinned: boolean } {
    const ceiling = ceilingOf(this.cfg);
    if (!adaptiveIn(this.cfg)) {
      /*
       * Pinned: the gate runs at exactly the number that was asked for.
       *
       * Any throttle is dropped rather than stepped over. What the upstream told us is only
       * meaningful while we are acting on it, and keeping a value we are ignoring would mean
       * un-pinning the gate a week later reinstates a halving from a 429 nobody remembers.
       */
      this.throttleLimit = null;
      return { ceiling, effective: ceiling, pinned: true };
    }
    return {
      ceiling,
      effective: this.throttleLimit === null ? ceiling : Math.min(ceiling, this.throttleLimit),
      pinned: false,
    };
  }

  acquire(req: AcquireRequest): Promise<Lease> {
    return new Promise<Lease>((resolve, reject) => {
      if (req.signal?.aborted) return reject(new AbortedError());

      /*
       * Anyone already waiting goes first, and before the depth check rather than after it.
       *
       * The fast path below used to be safe on its own: a free slot with an eligible waiter
       * in the queue could not happen, because a release drains before it returns. Making
       * the per-user cap changeable broke that — raising it makes waiters eligible with no
       * release to notice, and the next request from the same user would then be granted
       * straight past three of their own older ones, which went on waiting for a slot that
       * had already been given away.
       *
       * Before the depth check because a drain is what makes room in the queue: turning
       * somebody away as overloaded while the people ahead of them could have gone is the
       * same mistake one line down. It costs nothing when the queue is empty, which is the
       * ordinary case, and `schedule` returns at once when nothing can be granted.
       */
      if (this.queuedCount > 0) this.schedule();

      if (this.queuedCount >= this.cfg.maxQueueDepth) return reject(new OverloadedError());

      const w: Waiter = { ...req, enqueuedAt: Date.now(), resolve, reject, settled: false };

      if (this.canGrantNow(req.userId, this.perUserMax(), this.limits().effective))
        return this.grant(w);

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

  /**
   * `perUserOf` for this gate, resolved once per admission pass and handed down rather than
   * read per waiter: a drain over a deep queue would otherwise be one database read per
   * person in it. The fallback order itself is documented on `perUserOf`.
   */
  private perUserMax(): number {
    return perUserOf(this.cfg);
  }

  private canGrantNow(userId: string, perUserMax: number, effectiveMax: number): boolean {
    if (Date.now() < this.cooldownUntil) return false;
    return (
      this.active.size < effectiveMax &&
      (this.userInflight.get(userId) ?? 0) < perUserMax
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
    /*
     * Nothing queued, nothing to admit — every waiter this could grant is in one of the
     * queues, and both limits below are database reads. Without this line the ordinary case,
     * a lease released on a gate nobody is waiting at, pays for all of them.
     */
    if (this.queuedCount === 0) return;
    // Resolved on the first pass that could actually grant something. Above the loop it was
    // a database read on every lease release, including the ones that find the gate still
    // full.
    let perUserMax = -1;
    const { effective } = this.limits();
    while (this.active.size < effective && Date.now() >= this.cooldownUntil) {
      if (perUserMax < 0) perUserMax = this.perUserMax();
      const w = this.takeHiPri(perUserMax) ?? this.takeRoundRobin(perUserMax);
      if (!w) break;
      this.queuedCount -= 1;
      this.grant(w);
    }
  }

  /**
   * The first waiter whose user is under their cap, in arrival order.
   *
   * A user at the cap is stepped over, not moved: their requests keep their place for
   * when a slot of theirs frees up, and the people behind them are not held back. The
   * previous version put the capped request at the back and stopped looking, which left
   * a free slot idle while an under-cap user sat second in line — until one of the capped
   * user's own requests happened to finish. Nearly all traffic is priority 0 (see
   * isBackground in index.ts), so this lane, not the round robin below, is what decides
   * who waits.
   */
  private takeHiPri(perUserMax: number): Waiter | undefined {
    for (let i = 0; i < this.hiPri.length; i++) {
      const w = this.hiPri[i]!;
      if (w.settled) {
        this.hiPri.splice(i, 1);
        i -= 1;
        continue;
      }
      if ((this.userInflight.get(w.userId) ?? 0) >= perUserMax) continue;
      this.hiPri.splice(i, 1);
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
  private takeRoundRobin(perUserMax: number): Waiter | undefined {
    const users = [...this.queues.keys()];
    if (!users.length) return undefined;
    for (let i = 0; i < users.length; i++) {
      const u = users[(this.cursor + i) % users.length]!;
      if ((this.userInflight.get(u) ?? 0) >= perUserMax) continue;
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
      const { effective, pinned } = this.limits();
      this.consecutiveOk = 0;
      this.totalThrottled += 1;
      this.cooldownUntil = Date.now() + (retryAfterMs ?? 5000);
      /*
       * A pinned gate still waits out the cooldown. `retry-after` is the upstream saying
       * when to come back, which is a different claim from its opinion about how wide we
       * should run — and ignoring the first is how a 429 becomes a ban. What the pin
       * switches off is only the halving, so the gate returns to the number the
       * administrator set rather than to half of it.
       */
      if (!pinned) this.throttleLimit = Math.max(1, Math.floor(effective / 2));
      setTimeout(() => this.schedule(), (retryAfterMs ?? 5000) + 50).unref();
    } else if (status < 400) {
      this.consecutiveOk += 1;
      if (this.consecutiveOk >= 20 && this.throttleLimit !== null) {
        this.throttleLimit += 1;
        this.consecutiveOk = 0;
        // Recovery is complete once the throttle reaches the ceiling: nothing
        // is being held back any more. This is reached whether the throttle
        // climbed up to the ceiling or the ceiling came down to meet it — a
        // gate the admin made smaller is a smaller gate, not a throttled one.
        if (this.throttleLimit >= ceilingOf(this.cfg)) {
          this.throttleLimit = null;
        }
        this.schedule();
      }
    }
  }

  /** See `GatePool.reschedule` */
  reschedule(): void {
    this.schedule();
  }

  /**
   * The ceiling this process falls back on, for a deployment whose console has never set
   * one and for every test in here.
   *
   * The stored setting wins where there is one, and the console writes it before it calls
   * this — so the two agree, and the one that survives a restart is the row. The effective
   * limit is derived from the ceiling and the throttle, so every case falls out on its own:
   * a raise applies at once on a gate that is not backing off; a raise during a backoff
   * keeps serving the backoff until AIMD lifts it, rather than answering a 429 storm by
   * pushing harder; and a lower ceiling clamps either way without destroying what the
   * upstream told us, so raising it back restores the backoff instead of punching through it.
   */
  setMaxConcurrency(n: number): void {
    this.cfg.maxConcurrency = Math.max(1, n);
    this.schedule();
  }

  stats(): GateStats {
    const sorted = [...this.waits].sort((a, b) => a - b);
    const at = (p: number) => (sorted.length ? (sorted[Math.floor(sorted.length * p)] ?? 0) : 0);
    const { ceiling, effective, pinned } = this.limits();
    return {
      active: this.active.size,
      queued: this.queuedCount,
      effectiveMax: effective,
      max: ceiling,
      pinned,
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

  /**
   * Look at the queues again, for a change no release will announce.
   *
   * The per-user cap is a setting now, written in the app container. Raising it makes
   * queued requests eligible without freeing a slot, and nothing else in here runs on its
   * own — so on a gate that is full of long streaming turns the freed eligibility would sit
   * unused until the waiters timed out. The console calls this after writing it.
   */
  reschedule(): void {
    for (const gate of this.gates.values()) gate.reschedule();
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
    return ceilingOf(this.cfg);
  }

  /**
   * How many of that ceiling one user may hold, on each upstream.
   *
   * The gate's second limit, and usually the binding one: a pool of twenty with two in
   * flight and eight queued is not a contradiction, it is one user at their own cap of two.
   * Reported next to `max()` so the console can say so rather than leaving an operator to
   * work it out from the rows.
   */
  perUser(): number {
    return perUserOf(this.cfg);
  }

  /**
   * Whether the pools are held at that ceiling instead of adapting under it.
   *
   * Asked of the pool rather than of a gate because it is a deployment-wide switch and the
   * console has to be able to draw it before any upstream has seen traffic.
   */
  pinned(): boolean {
    return !adaptiveIn(this.cfg);
  }
}
