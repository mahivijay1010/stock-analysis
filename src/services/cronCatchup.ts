/**
 * Missed-run catch-up for the scheduler.
 *
 * Why. This backend runs on a laptop. On 2026-09-21, 09-22 and 09-23 the
 * machine was asleep (clamshell / deep idle) at 08:45 and 00:00, and the
 * scheduled jobs simply did not happen: node-cron fires only if the process
 * is awake at the instant, keeps no record of what it intended, and has no
 * catch-up. The misses were invisible until someone looked at the database,
 * and were misdiagnosed twice before the power log was checked
 * (docs/intraday-microstructure-notes.md §7). Two days of morning scans were
 * recovered by hand.
 *
 * What. A pure detector compares each job's expected run today (IST) against
 * `cron_execution_logs`, and a driver runs whatever is missing — once, logged
 * as "<job> (auto catch-up)" so the record shows it was late, not on time.
 * The driver is invoked on startup and then every few minutes, so a wake from
 * sleep is followed within minutes by whatever the sleep swallowed.
 *
 * Rules that keep this from being dangerous:
 *  - A job counts as done today if ANY row exists for it today under any
 *    label — scheduled, "(manual catch-up)", or "(auto catch-up)". Catch-up
 *    never double-runs.
 *  - Weekday-only and single-weekday jobs are honoured; a Saturday job is
 *    never caught up on a Sunday.
 *  - A grace window after the scheduled instant lets the real scheduler fire
 *    first; catch-up only claims a run that is clearly overdue.
 *  - Jobs run sequentially, in scheduled order, through the same guarded
 *    runner as scheduled runs, so a catch-up failure is logged as a failure.
 */

export interface CatchupJobSpec {
  name: string;
  /** IST wall-clock time of the daily instant. */
  hourIst: number;
  minuteIst: number;
  /** Mon–Fri only (the trading-day jobs). */
  weekdaysOnly?: boolean;
  /** Runs on exactly this IST weekday (0 = Sunday … 6 = Saturday). */
  onlyWeekday?: number;
  run: () => Promise<void>;
}

export interface LoggedRunToday {
  job_name: string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Grace after the instant before catch-up may claim it. */
export const CATCHUP_GRACE_MS = 3 * 60_000;

export function istParts(nowMs: number): { weekday: number; msSinceMidnightIst: number; dateIst: string } {
  const shifted = new Date(nowMs + IST_OFFSET_MS);
  const weekday = shifted.getUTCDay();
  const msSinceMidnightIst = shifted.getUTCHours() * 3_600_000 + shifted.getUTCMinutes() * 60_000 + shifted.getUTCSeconds() * 1000 + shifted.getUTCMilliseconds();
  return { weekday, msSinceMidnightIst, dateIst: shifted.toISOString().slice(0, 10) };
}

/** Does this job apply on the given IST weekday? */
export function appliesOn(spec: Pick<CatchupJobSpec, "weekdaysOnly" | "onlyWeekday">, weekday: number): boolean {
  if (spec.onlyWeekday != null) return weekday === spec.onlyWeekday;
  if (spec.weekdaysOnly) return weekday >= 1 && weekday <= 5;
  return true;
}

/**
 * Which jobs should have run by now today and have no record of running? PURE.
 * Returns them in scheduled order.
 */
export function missedRuns<T extends CatchupJobSpec>(specs: T[], nowMs: number, loggedToday: LoggedRunToday[]): T[] {
  const { weekday, msSinceMidnightIst } = istParts(nowMs);
  const doneNames = new Set(loggedToday.map((r) => baseJobName(r.job_name)));
  return specs
    .filter((s) => appliesOn(s, weekday))
    .filter((s) => {
      const instant = s.hourIst * 3_600_000 + s.minuteIst * 60_000;
      return msSinceMidnightIst > instant + CATCHUP_GRACE_MS;
    })
    .filter((s) => !doneNames.has(s.name))
    .sort((a, b) => a.hourIst * 60 + a.minuteIst - (b.hourIst * 60 + b.minuteIst));
}

/** "morning-refresh-and-scan (manual catch-up)" → "morning-refresh-and-scan". */
export function baseJobName(logged: string): string {
  return logged.replace(/\s*\((manual|auto) catch-up\)\s*$/, "").trim();
}

export const CATCHUP_LABEL = "(auto catch-up)";

/** Parse "45 8 * * *" → { hourIst: 8, minuteIst: 45 }. Only daily expressions are supported — by design (see CronService NOTE ON SCHEDULING). */
export function dailyExpressionToIst(expression: string): { hourIst: number; minuteIst: number } | null {
  const m = expression.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { hourIst: hour, minuteIst: minute };
}
