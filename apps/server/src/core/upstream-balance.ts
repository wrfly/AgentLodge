/**
 * Remaining on a configured subscription, as the vendor reports it.
 *
 * This has to run in the gateway process. The credential manager's socket is mounted
 * there and nowhere else — app asking here gets "No credential manager is configured"
 * and the overview card is only "spent this window $0".
 */
import * as providers from './db/providers.js';
import * as usageRepo from './db/usage.js';
import { fetchCursorBalance } from './cursor-balance.js';

export interface BalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
  /** Dollars already drawn, when the upstream (or this platform) can say so */
  used?: string;
  /** The prepaid / plan ceiling this remaining is held to */
  limit?: string;
  source?: 'deepseek' | 'cursor';
  label?: string;
  planName?: string;
  resetsAt?: string;
  /** True when `used` was counted from our usage table, not the upstream's own meter */
  billedHere?: boolean;
  /**
   * Where the billing cycle this remaining covers begins.
   *
   * Cursor's plan is a monthly dollar pot, not a rolling window: it reports a
   * `subscriptionCycleStart` and refills on it. Sent so the console can report spend over
   * the interval the vendor actually bills on, rather than over the 5-hour quota window,
   * which for a Cursor subscription is a boundary that exists only here.
   */
  cycleStart?: string;
  /**
   * Who decided that interval. `upstream` is the vendor's own cycle; `anchor` is this
   * platform's monthly anchor, used when the vendor reported no cycle — the console says
   * which, because a figure cut on a guessed month must not read as the vendor's invoice.
   */
  cycleSource?: 'upstream' | 'anchor';
  /**
   * What this platform billed through this upstream inside that cycle.
   *
   * The whole `Totals`, currencies kept apart, exactly as the platform cards report it —
   * `used` above is the vendor's single dollar figure and stays as it was.
   */
  spend?: usageRepo.Totals;
}

export interface BalanceResult {
  available: boolean;
  balances: BalanceInfo[];
  fetchedAt: string;
  error?: string;
}

function dollars(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return n.toFixed(2);
}

/**
 * What this platform billed through one upstream, over the cycle that remaining covers.
 *
 * The vendor's cycle first: Cursor reports a `subscriptionCycleStart` and refills the pot on
 * it, so that is the interval its own invoice is cut at. Reported nothing, and this falls
 * back to the administrator's monthly anchor — a month is the right shape for a monthly pot,
 * and `source` says the boundary is ours so the console can too. Counting from 1970 instead
 * would put lifetime spend beside a monthly ceiling.
 */
export function cycleOf(providerId: string, reported: string | null): {
  from: string;
  source: 'upstream' | 'anchor';
  totals: usageRepo.Totals;
} {
  const from = reported ?? usageRepo.periodStart('monthly');
  return {
    from,
    source: reported ? 'upstream' : 'anchor',
    totals: usageRepo.totalsAllInRange({ from, to: new Date().toISOString() }, providerId),
  };
}

function isDeepSeek(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

async function fetchDeepSeekBalance(p: providers.Provider, key: string): Promise<BalanceResult> {
  const fetchedAt = new Date().toISOString();
  const root = p.baseUrl.replace(/\/anthropic\/?$/, '').replace(/\/+$/, '');
  try {
    const res = await fetch(`${root}/user/balance`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { available: false, balances: [], fetchedAt, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }>;
    };
    return {
      available: Boolean(body.is_available),
      balances: (body.balance_infos ?? []).map((b) => ({
        currency: b.currency ?? '',
        totalBalance: b.total_balance ?? '0',
        grantedBalance: b.granted_balance ?? '0',
        toppedUpBalance: b.topped_up_balance ?? '0',
        source: 'deepseek' as const,
        label: p.name,
      })),
      fetchedAt,
    };
  } catch (err) {
    return {
      available: false,
      balances: [],
      fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchOneCursor(p: providers.Provider, key: string): Promise<BalanceInfo> {
  const raw = await fetchCursorBalance(key, p.baseUrl);
  const cycle = cycleOf(p.id, raw.cycleStart);
  /*
   * Only the vendor's own cycle is subtracted from the vendor's remaining.
   *
   * Cursor's Enterprise dashboard often answers a hard limit and nothing spent. The pot is
   * still being drawn — by us — so the remaining below subtracts what we priced in USD. On
   * our own monthly anchor that subtraction would be guesswork against somebody else's
   * ledger, so it is left at zero and only the spend figure uses the fallback interval. A
   * deployment that priced in another currency has no USD figure to subtract either.
   */
  const ours = cycle.source === 'upstream' ? (cycle.totals.cost.USD ?? 0) / 1_000_000 : 0;
  const billedHere = raw.used === null && ours > 0;
  const used = raw.used ?? (ours > 0 ? ours : null);
  const remaining =
    raw.remaining !== null && !billedHere
      ? raw.remaining
      : raw.limit !== null && used !== null
        ? Math.max(0, raw.limit - used)
        : raw.remaining;
  return {
    currency: 'USD',
    totalBalance: dollars(remaining),
    grantedBalance: dollars(raw.included),
    toppedUpBalance: dollars(raw.prepaid),
    used: used !== null ? dollars(used) : raw.limit !== null ? '0.00' : undefined,
    limit: dollars(raw.limit) || undefined,
    source: 'cursor',
    label: p.name,
    planName: raw.planName ?? undefined,
    resetsAt: raw.resetsAt ?? undefined,
    billedHere: billedHere || undefined,
    cycleStart: cycle.from,
    cycleSource: cycle.source,
    spend: cycle.totals,
  };
}

/**
 * The address and credential a balance query uses, taken from **the active provider**
 * rather than a separate piece of configuration.
 *
 * DeepSeek answers `/user/balance`. Cursor answers a prepaid pot — hard limit, grant
 * credit, included spend — from DashboardService. Anything else has no such endpoint
 * and is skipped; the card then disappears if nobody answered.
 *
 * Several Cursor providers are several accounts, so each is asked. DeepSeek still
 * answers once: the card is about an account's remaining, and two DeepSeek keys are
 * two accounts, which this card does not currently ask about.
 *
 * Held for a minute: the dashboard is several RPCs, and the landing page used to wait
 * for all of them on every open. The card still asks this function; the cache is what
 * keeps a tab-switch from paying the same round trip again.
 */
const BALANCE_TTL_MS = 60_000;
let balanceCache: { at: number; value: BalanceResult | null } | undefined;

export async function fetchBalance(): Promise<BalanceResult | null> {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value;
  const fetchedAt = new Date().toISOString();
  const balances: BalanceInfo[] = [];
  const errors: string[] = [];
  let asked = false;

  for (const p of providers.list()) {
    if (p.kind !== 'cursor') continue;
    const key = await providers.secretOf(p.id);
    if (!key) {
      if (p.hasKey) errors.push(`${p.name}: no credential`);
      continue;
    }
    asked = true;
    try {
      balances.push(await fetchOneCursor(p, key));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  for (const p of providers.list()) {
    if (!isDeepSeek(p.baseUrl)) continue;
    const key = await providers.secretOf(p.id);
    if (!key) {
      if (p.hasKey) errors.push(`${p.name}: no credential`);
      continue;
    }
    asked = true;
    const ds = await fetchDeepSeekBalance(p, key);
    balances.push(...ds.balances);
    if (ds.error) errors.push(ds.error);
    break;
  }

  const value = !asked && !errors.length
    ? null
    : {
        available: balances.length > 0,
        balances,
        fetchedAt,
        error: balances.length ? undefined : errors[0],
      };
  balanceCache = { at: Date.now(), value };
  return value;
}
