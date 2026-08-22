import * as usersRepo from './db/users.js';
import * as usageRepo from './db/usage.js';
import * as pricing from './db/pricing.js';
import {
  describeAnchor,
  rollingExpired,
  type QuotaPeriod,
  type RollingSpec,
} from './db/period.js';
import { quotaAnchor } from './db/settings.js';

export type { QuotaStatus, LimitKind } from './protocol.js';
import type { QuotaStatus } from './protocol.js';

const PERIOD_LABEL: Record<QuotaPeriod, string> = {
  rolling: 'window',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  total: 'billing period',
};

export function periodLabel(p: QuotaPeriod): string {
  return PERIOD_LABEL[p] ?? 'period';
}

function rollingSpecOf(q: usersRepo.Quota): RollingSpec | undefined {
  if (q.period !== 'rolling') return undefined;
  return {
    hours: q.periodHours ?? 24,
    // With no start point set, fall back to when the quota was last changed
    cycleStart: q.cycleStart ?? q.updatedAt,
    autoRenew: q.autoRenew,
  };
}

/**
 * Counting starts at max(the period's natural start, the administrator's manual reset).
 *
 * A manual reset only affects the current period: once the period rolls over, the
 * natural start overtakes it and the normal rhythm resumes by itself.
 */
export function status(userId: string): QuotaStatus {
  const q = usersRepo.getQuota(userId);
  const rolling = rollingSpecOf(q);
  const anchor = quotaAnchor();
  const now = new Date();

  const natural = usageRepo.periodStart(q.period, now, rolling);
  const since = q.resetAt && q.resetAt > natural ? q.resetAt : natural;
  const end = usageRepo.periodEnd(q.period, now, rolling);

  const totals = usageRepo.totalsForUser(userId, { from: since });
  const used = totals.billableTokens;
  const usedMicro = totals.costMicro;

  const expired = rolling ? rollingExpired(now, rolling) : false;

  const exceededByToken = q.tokenLimit !== null && used >= q.tokenLimit;
  const exceededByCost = q.costLimitMicro !== null && usedMicro >= q.costLimitMicro;
  const exceeded =
    expired || (q.limitKind === 'cost' ? exceededByCost : exceededByToken);

  const ratio =
    q.limitKind === 'cost'
      ? q.costLimitMicro && q.costLimitMicro > 0
        ? Math.min(usedMicro / q.costLimitMicro, 1)
        : 0
      : q.tokenLimit && q.tokenLimit > 0
        ? Math.min(used / q.tokenLimit, 1)
        : 0;

  return {
    limitKind: q.limitKind,
    limit: q.tokenLimit,
    costLimitMicro: q.costLimitMicro,
    currency: q.currency,
    used,
    usedMicro,
    remaining: q.tokenLimit === null ? null : Math.max(q.tokenLimit - used, 0),
    remainingMicro:
      q.costLimitMicro === null ? null : Math.max(q.costLimitMicro - usedMicro, 0),
    ratio,
    period: q.period,
    periodStart: since,
    periodEnd: end,
    resetsInMs: end ? Math.max(new Date(end).getTime() - Date.now(), 0) : null,
    resetAt: q.resetAt,
    anchorLabel: describeAnchor(q.period, anchor, rolling),
    expired,
    hardStop: q.hardStop,
    exceeded,
    warning: ratio >= 0.9,
  };
}

export interface Verdict {
  allow: boolean;
  reason?: string;
  status: QuotaStatus;
}

/**
 * The quota check. Called in two places, and both are needed:
 *   1. before sending a message — an exhausted quota starts no turn, and the user is
 *      told immediately
 *   2. before every upstream call in the gateway — the only place that can stop a turn
 *      **while it is running**
 */
export function check(userId: string): Verdict {
  const s = status(userId);
  if (!s.hardStop) return { allow: true, status: s };

  if (s.expired) {
    return {
      allow: false,
      reason: `This allowance has expired (${s.anchorLabel}); ask an administrator to top it up`,
      status: s,
    };
  }

  if (s.exceeded) {
    const spent =
      s.limitKind === 'cost'
        ? `${pricing.formatMoney(s.usedMicro, s.currency)} / ${pricing.formatMoney(s.costLimitMicro ?? 0, s.currency)}`
        : `${s.used.toLocaleString()} / ${(s.limit ?? 0).toLocaleString()} tokens`;
    const resetHint =
      s.resetsInMs === null ? '' : `, resets in ${formatDuration(s.resetsInMs)}`;
    return {
      allow: false,
      reason: `Quota used up (${spent} this ${periodLabel(s.period)}${resetHint})`,
      status: s,
    };
  }

  return { allow: true, status: s };
}

export function formatDuration(ms: number): string {
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.ceil(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.ceil(hours / 24)} d`;
}
