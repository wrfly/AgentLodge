/**
 * Prices that depend on the time of day.
 *
 * DeepSeek charges double during working hours and half the rest of the week, and says so
 * plainly: "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
 * 06:00 - 10:00 UTC, Monday through Friday" (all other hours are off-peak). Both models and
 * all three billed components — cache hit, cache miss, output — scale by the same 2:1.
 *
 * A price row holds one number, so until now the table held the off-peak one and a note
 * saying it doubles. A deployment serving European mornings was billing half of what it was
 * charged, and quota, which is denominated in what a turn cost, let everyone through at
 * twice the intended rate for four hours a day.
 *
 * **Everything here is UTC**, and that is the one thing about this file that must not be
 * softened. The vendor states the window in UTC; the rest of this system cuts its own
 * boundaries in the server's local zone (DESIGN.md §16), and a deployment running TZ=
 * Asia/Shanghai that evaluated these hours locally would apply the surcharge eight hours
 * late — at the right-looking hours, on the right-looking days, with nothing to show for it
 * but a bill that quietly disagrees with the invoice. Hence getUTC* throughout, and hence
 * the tests that pin a non-UTC TZ and assert the answer does not move.
 */

export interface PeakWindows {
  /** Days of the week the surcharge applies on, in UTC. 0 is Sunday, per Date#getUTCDay. */
  days: number[];
  /**
   * Hour ranges within those days, in UTC, half-open: `[1, 4]` is 01:00 up to but not
   * including 04:00. Half-open so that adjacent ranges cannot both claim the boundary.
   */
  hours: Array<[number, number]>;
}

/** Monday through Friday, which is every real-world peak schedule seen so far */
export const WEEKDAYS = [1, 2, 3, 4, 5];

/**
 * Why a value is not usable, or undefined when it is.
 *
 * Returned rather than thrown: the caller is a write path that wants to refuse with a
 * message, and a read path that wants to carry on without one.
 */
export function validatePeak(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return 'peak windows must be an object';
  const w = value as Partial<PeakWindows>;

  if (!Array.isArray(w.days) || w.days.length === 0) return 'peak windows need at least one day';
  for (const d of w.days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) return `${String(d)} is not a day of the week (0–6, 0 is Sunday)`;
  }

  if (!Array.isArray(w.hours) || w.hours.length === 0) return 'peak windows need at least one hour range';
  for (const h of w.hours) {
    if (!Array.isArray(h) || h.length !== 2) return 'each hour range is a pair, [from, to]';
    const [from, to] = h;
    if (typeof from !== 'number' || typeof to !== 'number' || Number.isNaN(from) || Number.isNaN(to)) {
      return 'hour ranges have to be numbers';
    }
    if (from < 0 || to > 24) return 'hours run from 0 to 24';
    // An empty or inverted range would read as "no surcharge" while looking like one
    if (from >= to) return `${from}–${to} is not a range: the start has to come before the end`;
  }
  return undefined;
}

/**
 * Read what is stored on the row.
 *
 * Anything unusable reads as "no peak schedule" rather than throwing, because this runs on
 * the path that prices every request. That is a deliberate asymmetry with the write path,
 * which refuses: a value can only be unusable here if it bypassed that refusal — by being
 * hand-edited into the database — and refusing to serve is a worse answer than billing the
 * base rate. `parsePeakError` exists so a caller can say so out loud.
 */
export function parsePeak(stored: string | null | undefined): PeakWindows | null {
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  return validatePeak(parsed) ? null : (parsed as PeakWindows);
}

/** The same read, but saying why it came back empty — for a caller that can log it */
export function parsePeakError(stored: string | null | undefined): string | undefined {
  if (!stored) return undefined;
  try {
    return validatePeak(JSON.parse(stored));
  } catch {
    return 'peak windows are not valid JSON';
  }
}

/**
 * Is `at` inside one of these windows?
 *
 * UTC throughout — see the note at the top of this file. The comparison carries minutes so
 * that a range can be written in halves if a vendor ever states one that way; DeepSeek's
 * are whole hours.
 */
export function isPeakAt(windows: PeakWindows | null, at: Date): boolean {
  if (!windows) return false;
  if (!windows.days.includes(at.getUTCDay())) return false;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return windows.hours.some(([from, to]) => hour >= from && hour < to);
}

/** `Mon–Fri 01:00–04:00, 06:00–10:00 UTC` — for a console that has to show what is stored */
export function describePeak(windows: PeakWindows | null): string {
  if (!windows) return '';
  const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const sorted = [...windows.days].sort((a, b) => a - b);
  // A contiguous run reads as a range; anything else is listed, because "Mon–Sat" for
  // Mon,Tue,Thu,Fri,Sat would be a lie that looks tidy
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  const days = sorted.length > 2 && contiguous
    ? `${NAMES[sorted[0]!]}–${NAMES[sorted[sorted.length - 1]!]}`
    : sorted.map((d) => NAMES[d]).join(', ');

  // `01–04` rather than `01:00–04:00`: this goes in a table cell beside four money columns,
  // and the minutes are zero in every schedule anyone has published. A range that does carry
  // minutes prints them.
  const pad = (n: number) => {
    const h = Math.floor(n);
    const m = Math.round((n - h) * 60);
    const hh = String(h).padStart(2, '0');
    return m === 0 ? hh : `${hh}:${String(m).padStart(2, '0')}`;
  };
  const hours = windows.hours.map(([from, to]) => `${pad(from)}–${pad(to)}`).join(', ');
  return `${days} ${hours} UTC`;
}
