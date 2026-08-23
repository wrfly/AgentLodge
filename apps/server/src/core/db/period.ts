/**
 * rolling = a window of N hours starting from the user's own anchor.
 *
 * This is what "here is 10 units, use them within 3 hours" needs; a calendar-aligned
 * period cannot express "from the moment I was topped up".
 */
export type QuotaPeriod = 'rolling' | 'daily' | 'weekly' | 'monthly' | 'total';

/**
 * The period anchor: which day of the month, which day of the week, and at what hour an
 * administrator wants the reset.
 *
 * A billing period need not start at 00:00 on the 1st — plenty of teams align to a
 * payday, a contract date, or a maintenance window.
 */
export interface PeriodAnchor {
  /** 1–31. A month without that day (the 31st in February) falls back to its last. */
  dayOfMonth: number;
  /** 1 = Monday … 7 = Sunday */
  dayOfWeek: number;
  /** 0–23, local time */
  hour: number;
}

export const DEFAULT_ANCHOR: PeriodAnchor = { dayOfMonth: 1, dayOfWeek: 1, hour: 0 };

export function normalizeAnchor(a: Partial<PeriodAnchor> | undefined): PeriodAnchor {
  const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
  };
  return {
    dayOfMonth: clamp(a?.dayOfMonth, 1, 31, DEFAULT_ANCHOR.dayOfMonth),
    dayOfWeek: clamp(a?.dayOfWeek, 1, 7, DEFAULT_ANCHOR.dayOfWeek),
    hour: clamp(a?.hour, 0, 23, DEFAULT_ANCHOR.hour),
  };
}

const daysInMonth = (year: number, monthIdx: number): number =>
  new Date(year, monthIdx + 1, 0).getDate();

/** The anchor moment in a given month; a day beyond the month's length clamps to its last */
function monthAnchor(year: number, monthIdx: number, a: PeriodAnchor): Date {
  const day = Math.min(a.dayOfMonth, daysInMonth(year, monthIdx));
  return new Date(year, monthIdx, day, a.hour, 0, 0, 0);
}

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** 1 = Monday … 7 = Sunday */
const isoDayOfWeek = (d: Date): number => ((d.getDay() + 6) % 7) + 1;

/**
 * Where the current period starts.
 *
 * Always in local time. The point that matters: if today is the anchor day but the anchor
 * hour has not arrived, the current period actually began at the *previous* anchor.
 * Without that, a user watches their quota reset early on reset day.
 */
/** What a rolling period needs beyond the anchor: the window length and the user's start point */
export interface RollingSpec {
  hours: number;
  /** Usually the moment of the top-up or grant */
  cycleStart: string;
  /** false makes it a one-off: once the window passes it does not renew */
  autoRenew: boolean;
}

/**
 * Where a rolling window starts.
 *
 * Auto-renewal needs no scheduled job: the current window is computed from how many whole
 * windows have elapsed, so the answer is still right after the service has been down for
 * a week.
 */
export function rollingStartAt(now: Date, spec: RollingSpec): Date {
  const anchor = new Date(spec.cycleStart);
  const lenMs = Math.max(spec.hours, 0.01) * 3600_000;
  if (now <= anchor) return anchor;
  if (!spec.autoRenew) return anchor; // one-off: always the first window
  const elapsed = now.getTime() - anchor.getTime();
  return new Date(anchor.getTime() + Math.floor(elapsed / lenMs) * lenMs);
}

export function rollingEndAt(now: Date, spec: RollingSpec): Date {
  const lenMs = Math.max(spec.hours, 0.01) * 3600_000;
  return new Date(rollingStartAt(now, spec).getTime() + lenMs);
}

/** Whether a one-off allowance has expired — past that nothing is admitted until an administrator tops it up */
export function rollingExpired(now: Date, spec: RollingSpec): boolean {
  if (spec.autoRenew) return false;
  return now >= rollingEndAt(now, spec);
}

/* ---------------- The platform's rolling 5-hour window ---------------- */

/** What the upstream calls a 5-hour window, and what we mirror it with */
export const WINDOW_MS = 5 * 60 * 60_000;

export interface WindowBounds {
  start: Date;
  end: Date;
}

/**
 * The 5-hour window everybody shares.
 *
 * One subscription has one 5-hour window, and the upstream states when it resets on every
 * response. Mirroring that instant is the whole point: a window measured from each user's
 * own first message would tell somebody who started at four that they have until nine,
 * when the pool empties at seven and they are refused with their quota barely touched.
 *
 * @param upstreamReset the last reset the upstream reported, ISO 8601. It may be in the
 * past — nothing has gone through the gateway for a while — so the cadence is carried
 * forward from it in 5-hour steps rather than discarded: the phase is what matters, and the
 * phase does not drift.
 *
 * With no observation at all, the window falls back to the clock, cut from the same anchor
 * hour the other periods use. Still identical for everybody, which is the requirement;
 * simply not aligned to the upstream's own reset until one has been seen.
 */
export function windowBoundsAt(
  now: Date,
  upstreamReset?: string | null,
  anchorIn?: Partial<PeriodAnchor>,
): WindowBounds {
  const observed = upstreamReset ? new Date(upstreamReset).getTime() : NaN;
  const phase = Number.isFinite(observed)
    ? observed
    : // The anchor hour on the epoch's own day, so every deployment cuts the same instants
      new Date(1970, 0, 1, normalizeAnchor(anchorIn).hour).getTime();

  // How many whole windows separate now from that phase, rounded towards -∞ so a phase in
  // the future works out the same way as one in the past
  const steps = Math.floor((now.getTime() - phase) / WINDOW_MS);
  const start = new Date(phase + steps * WINDOW_MS);
  return { start, end: new Date(start.getTime() + WINDOW_MS) };
}

export function periodStartAt(
  period: QuotaPeriod,
  now: Date,
  anchorIn?: Partial<PeriodAnchor>,
  rolling?: RollingSpec,
): Date {
  const a = normalizeAnchor(anchorIn);

  switch (period) {
    case 'rolling':
      return rolling ? rollingStartAt(now, rolling) : new Date(0);
    case 'total':
      return new Date(0);

    case 'daily': {
      const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), a.hour);
      if (now < candidate) candidate.setDate(candidate.getDate() - 1);
      return candidate;
    }

    case 'weekly': {
      const delta = (isoDayOfWeek(now) - a.dayOfWeek + 7) % 7;
      const base = startOfDay(now);
      base.setDate(base.getDate() - delta);
      base.setHours(a.hour);
      if (now < base) base.setDate(base.getDate() - 7);
      return base;
    }

    case 'monthly':
    default: {
      const thisMonth = monthAnchor(now.getFullYear(), now.getMonth(), a);
      if (now >= thisMonth) return thisMonth;
      // This month's anchor has not arrived, so the period began at last month's
      return monthAnchor(now.getFullYear(), now.getMonth() - 1, a);
    }
  }
}

/** Where the current period ends, which is where the next begins. `total` has no end. */
export function periodEndAt(
  period: QuotaPeriod,
  now: Date,
  anchorIn?: Partial<PeriodAnchor>,
  rolling?: RollingSpec,
): Date | null {
  if (period === 'total') return null;
  if (period === 'rolling') return rolling ? rollingEndAt(now, rolling) : null;
  const a = normalizeAnchor(anchorIn);
  const start = periodStartAt(period, now, a);

  switch (period) {
    case 'daily': {
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return end;
    }
    case 'weekly': {
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return end;
    }
    case 'monthly':
    default:
      // Recompute the anchor from the start's month + 1, so the 31st clamps correctly
      // across months of different lengths
      return monthAnchor(start.getFullYear(), start.getMonth() + 1, a);
  }
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * A description for the interface, in words.
 *
 * ⚠️ Composed on the server, which makes it the one piece of display text the client
 * cannot translate. Doing it properly means sending the structured fields and composing
 * on the client instead.
 */
export function describeAnchor(
  period: QuotaPeriod,
  anchorIn?: Partial<PeriodAnchor>,
  rolling?: RollingSpec,
): string {
  const a = normalizeAnchor(anchorIn);
  const hh = `${String(a.hour).padStart(2, '0')}:00`;
  switch (period) {
    case 'rolling': {
      if (!rolling) return 'Billed by window (no start point set)';
      const h = rolling.hours % 1 === 0 ? `${rolling.hours}` : rolling.hours.toFixed(1);
      const from = new Date(rolling.cycleStart).toLocaleString('en-GB', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      return rolling.autoRenew
        ? `A window every ${h} h, from ${from}`
        : `One-off allowance, valid ${h} h from ${from}`;
    }
    case 'total':
      return 'Never resets';
    case 'daily':
      return `Resets daily at ${hh}`;
    case 'weekly':
      return `Resets every ${WEEKDAYS[a.dayOfWeek - 1]} at ${hh}`;
    case 'monthly':
    default:
      return (
        `Resets on day ${a.dayOfMonth} of each month at ${hh}`
        + (a.dayOfMonth > 28 ? ' (or the last day, in a shorter month)' : '')
      );
  }
}
