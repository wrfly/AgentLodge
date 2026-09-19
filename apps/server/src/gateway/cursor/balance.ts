import { accessToken } from './auth.js';
import { BUNDLE_VERSION } from './schema.generated.js';

/**
 * What Cursor will still honour on this credential.
 *
 * Cursor does not send Anthropic's 5-hour / 7-day headers. Enterprise token-based
 * seats have a monthly dollar ceiling (`monthlyLimitDollars` / `effectivePerUserLimitDollars`)
 * and a spend figure in cents. Those live on this seat's row of GetTeamSpend.
 *
 * GetHardLimit's `hardLimitPerUser` is a different knob — the on-demand default, often
 * $500 — and must not be shown as the account pot. The org-wide `hardLimit` is the
 * pooled ceiling, not this seat.
 *
 * GetTeamSpend answers with the whole roster. Only this credential's userId is kept,
 * and only the dollar fields; the rest is dropped without logging.
 */

const DEFAULT_API = 'https://api2.cursor.sh';

export interface CursorBalance {
  /** Dollars still in the pot, if we can say so */
  remaining: number | null;
  /** Dollars already drawn this cycle, from Cursor itself */
  used: number | null;
  /** The ceiling this credential is held to */
  limit: number | null;
  /** Included plan spend still unused */
  included: number | null;
  /** Topped-up / grant credit still unused */
  prepaid: number | null;
  /** When the cycle we counted against started; null means we have no cycle */
  cycleStart: string | null;
  resetsAt: string | null;
  planName: string | null;
}

/** This seat's numbers, already stripped of the rest of the roster */
export interface CursorSeat {
  monthlyLimitDollars?: unknown;
  effectivePerUserLimitDollars?: unknown;
  overallSpendCents?: unknown;
  spendCents?: unknown;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Cursor's usage fields are cents; a missing field is not zero */
function dollarsFromCents(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n / 100;
}

function isoFromMs(v: unknown): string | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

interface Period {
  billingCycleStart?: unknown;
  billingCycleEnd?: unknown;
  planUsage?: {
    totalSpend?: unknown;
    includedSpend?: unknown;
    remaining?: unknown;
    limit?: unknown;
  };
  spendLimitUsage?: {
    pooledLimit?: unknown;
    pooledUsed?: unknown;
    pooledRemaining?: unknown;
    individualUsed?: unknown;
    individualLimit?: unknown;
    individualRemaining?: unknown;
  };
}

interface Plan {
  planName?: unknown;
  billingCycleEnd?: unknown;
  includedAmountCents?: unknown;
  planInfo?: { planName?: unknown; billingCycleEnd?: unknown; includedAmountCents?: unknown };
}

interface Grants {
  totalCents?: unknown;
  remainingCents?: unknown;
}

interface Hard {
  hardLimit?: unknown;
  hardLimitPerUser?: unknown;
}

interface Stripe {
  teamId?: unknown;
}

interface Me {
  userId?: unknown;
  teamId?: unknown;
}

interface TeamSpend {
  teamMemberSpend?: unknown;
  subscriptionCycleStart?: unknown;
  nextCycleStart?: unknown;
}

async function rpc<T>(base: string, token: string, method: string, body: unknown = {}): Promise<T | null> {
  const res = await fetch(`${base}/aiserver.v1.DashboardService/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'connect-protocol-version': '1',
      'content-type': 'application/json',
      'user-agent': 'connect-es/1.6.1',
      'x-cursor-client-type': 'cli',
      'x-cursor-client-version': `cli-${BUNDLE_VERSION}`,
      'x-ghost-mode': 'true',
      'x-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

async function stripeProfile(base: string, token: string): Promise<Stripe | null> {
  const res = await fetch(`${base}/auth/full_stripe_profile`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Stripe | null;
}

/**
 * Keep this seat's dollar fields from a GetTeamSpend payload, and nothing else.
 *
 * The roster also carries names and emails. They are not copied. The caller should
 * drop the payload after this returns.
 */
export function seatFromTeamSpend(spend: TeamSpend | null | undefined, userId: number): { seat: CursorSeat | null; cycleStart: string | null; cycleEnd: string | null } {
  const cycleStart = isoFromMs(spend?.subscriptionCycleStart);
  const cycleEnd = isoFromMs(spend?.nextCycleStart);
  const rows = spend?.teamMemberSpend;
  if (!Array.isArray(rows)) return { seat: null, cycleStart, cycleEnd };
  const row = rows.find((r) => r && typeof r === 'object' && num((r as { userId?: unknown }).userId) === userId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { seat: null, cycleStart, cycleEnd };
  return {
    seat: {
      monthlyLimitDollars: row.monthlyLimitDollars,
      effectivePerUserLimitDollars: row.effectivePerUserLimitDollars,
      overallSpendCents: row.overallSpendCents,
      spendCents: row.spendCents,
    },
    cycleStart,
    cycleEnd,
  };
}

/**
 * Fold the dashboard answers into one reading.
 *
 * Precedence for the ceiling: this seat's monthly / effective dollar limit, then
 * Cursor's own remaining/limit in cents, then a personal hardLimit. A team
 * `hardLimitPerUser` is the on-demand default and is not the account pot.
 */
export function readCursorBalance(input: {
  period?: Period | null;
  plan?: Plan | null;
  grants?: Grants | null;
  hard?: Hard | null;
  hadTeamId?: boolean;
  seat?: CursorSeat | null;
  seatCycleStart?: string | null;
  seatCycleEnd?: string | null;
}): CursorBalance {
  const planUsage = input.period?.planUsage;
  const spend = input.period?.spendLimitUsage;
  const info = input.plan?.planInfo ?? input.plan;
  const seatLimit =
    num(input.seat?.effectivePerUserLimitDollars)
    ?? num(input.seat?.monthlyLimitDollars);
  const seatUsed =
    dollarsFromCents(input.seat?.overallSpendCents)
    ?? dollarsFromCents(input.seat?.spendCents);
  const used =
    seatUsed
    ?? dollarsFromCents(planUsage?.totalSpend)
    ?? dollarsFromCents(spend?.individualUsed)
    ?? dollarsFromCents(spend?.pooledUsed);
  const included = dollarsFromCents(planUsage?.remaining);
  const prepaid =
    dollarsFromCents(input.grants?.remainingCents ?? input.grants?.totalCents)
    ?? dollarsFromCents(spend?.individualRemaining)
    ?? dollarsFromCents(spend?.pooledRemaining);
  const pool = num(input.hard?.hardLimit);
  const limit =
    seatLimit
    ?? dollarsFromCents(planUsage?.limit)
    ?? dollarsFromCents(spend?.individualLimit)
    ?? (input.hadTeamId ? null : pool)
    ?? dollarsFromCents(info?.includedAmountCents);
  const remaining =
    (limit !== null && used !== null ? Math.max(0, limit - used) : null)
    ?? dollarsFromCents(planUsage?.remaining)
    ?? prepaid
    ?? (limit !== null && used === null ? limit : null);

  const cycleEnd =
    input.seatCycleEnd
    ?? isoFromMs(input.period?.billingCycleEnd)
    ?? isoFromMs(info?.billingCycleEnd);
  const cycleStart =
    input.seatCycleStart
    ?? isoFromMs(input.period?.billingCycleStart);
  const sameInstant = Boolean(cycleEnd && cycleStart && cycleStart === cycleEnd);
  const farAway =
    cycleEnd !== null && new Date(cycleEnd).getTime() - Date.now() > 45 * 86_400_000;
  const resetsAt = sameInstant || farAway ? null : cycleEnd;

  const planName = typeof info?.planName === 'string' ? info.planName : null;
  return {
    remaining,
    used,
    limit,
    included,
    prepaid,
    cycleStart: sameInstant ? null : cycleStart,
    resetsAt,
    planName,
  };
}

export async function fetchCursorBalance(secret: string, baseUrl?: string): Promise<CursorBalance> {
  const base = (baseUrl || DEFAULT_API).replace(/\/+$/, '') || DEFAULT_API;
  const token = await accessToken(secret, base);
  const [period, plan, grants, stripe, me] = await Promise.all([
    rpc<Period>(base, token, 'GetCurrentPeriodUsage'),
    rpc<Plan>(base, token, 'GetPlanInfo'),
    rpc<Grants>(base, token, 'GetCreditGrantsBalance'),
    stripeProfile(base, token),
    rpc<Me>(base, token, 'GetMe'),
  ]);
  const teamId = num(stripe?.teamId) ?? num(me?.teamId);
  const userId = num(me?.userId);
  const [hard, spend] = await Promise.all([
    rpc<Hard>(base, token, 'GetHardLimit', teamId !== null ? { teamId } : {}),
    teamId !== null && userId !== null
      ? rpc<TeamSpend>(base, token, 'GetTeamSpend', { teamId })
      : Promise.resolve(null),
  ]);
  let seat: CursorSeat | null = null;
  let seatCycleStart: string | null = null;
  let seatCycleEnd: string | null = null;
  if (userId !== null) {
    const picked = seatFromTeamSpend(spend, userId);
    seat = picked.seat;
    seatCycleStart = picked.cycleStart;
    seatCycleEnd = picked.cycleEnd;
  }
  return readCursorBalance({
    period,
    plan,
    grants,
    hard,
    hadTeamId: teamId !== null,
    seat,
    seatCycleStart,
    seatCycleEnd,
  });
}
