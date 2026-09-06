/**
 * IST product-date helpers (Phase C, upgrade-spec §5).
 *
 * All product dates are Asia/Kolkata calendar dates as YYYY-MM-DD strings.
 * Extracted from AdminService's private helpers so the forecast stack and the
 * paper desk share one implementation (removal-with-extraction policy).
 */

/** YYYY-MM-DD in Asia/Kolkata for a JS Date instant. */
export function istDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** dateStr (YYYY-MM-DD) + n calendar days → YYYY-MM-DD. */
export function addCalendarDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole calendar days from a to b (b − a), both YYYY-MM-DD. */
export function calendarDaysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** ISO weekday for a YYYY-MM-DD calendar date: 1=Mon … 7=Sun. */
export function isoWeekday(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return wd === 0 ? 7 : wd;
}

export function isWeekend(dateStr: string): boolean {
  return isoWeekday(dateStr) >= 6;
}

/** "YYYY-MM" period key for a YYYY-MM-DD date. */
export function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/** First and last calendar date of a "YYYY-MM" period. */
export function monthBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const start = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
  return { start, end: `${period}-${String(lastDay).padStart(2, "0")}` };
}

/** Every calendar date from start to end inclusive (both YYYY-MM-DD). */
export function calendarRange(start: string, end: string): string[] {
  const days = calendarDaysBetween(start, end);
  if (days < 0) return [];
  return Array.from({ length: days + 1 }, (_, i) => addCalendarDays(start, i));
}
