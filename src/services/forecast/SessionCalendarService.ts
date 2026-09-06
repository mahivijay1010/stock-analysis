/**
 * SessionCalendarService (Phase C, spec §5) — resolves IST calendar dates to
 * actual NSE trading sessions instead of the "30 days ≈ 21 sessions" heuristic.
 *
 * Honesty model (free data, nothing invented):
 *  - PAST dates: a date is a confirmed session iff observed bars exist for it
 *    in stock_history (any coverage-universe ticker traded ⇒ the exchange was
 *    open). A past weekday with zero bars across the whole universe is
 *    reconciled as closed ("no_data" — holiday or unexpected closure).
 *  - FUTURE dates: weekends are closed by rule; weekdays are PROJECTED
 *    sessions ("weekday_projection") — explicitly provisional, because no
 *    verified official holiday list is bundled. When the date passes, the
 *    reconcile pass flips the row to observed/no_data. Unexpected closures
 *    therefore surface as explicit states, never as silently wrong forecasts.
 */

import { AppDataSource } from "../../config/database";
import { TradingSession } from "../../entities";
import { addCalendarDays, calendarRange, isWeekend, istDateString } from "./dates";

export interface ResolvedDay {
  date: string; // YYYY-MM-DD (IST)
  state: "session" | "weekend" | "closed" | "projected_session";
  basis: TradingSession["basis"];
  label?: string | null;
}

export class SessionCalendarService {
  private repo() {
    return AppDataSource.getRepository(TradingSession);
  }

  /**
   * Reconcile the calendar against observed data and project the near future.
   * Idempotent; safe to run at boot and from the evening cron.
   *
   * - Upserts "observed" session rows for every distinct stock_history date
   *   in [today−lookbackDays, today].
   * - Marks past weekdays in that span with no bars as closed/"no_data"
   *   (only once the date is at least `graceDays` behind today, so a slow
   *   evening ingest is not misread as a holiday).
   * - Ensures every future date in [today+1, today+horizonDays] has a row:
   *   weekend → closed; weekday → projected session (provisional).
   */
  async reconcile(opts?: {
    lookbackDays?: number;
    horizonDays?: number;
    graceDays?: number;
  }): Promise<{ observed: number; closedNoData: number; projected: number }> {
    const lookbackDays = opts?.lookbackDays ?? 120;
    const horizonDays = opts?.horizonDays ?? 70;
    const graceDays = opts?.graceDays ?? 2;
    const today = istDateString(new Date());
    const from = addCalendarDays(today, -lookbackDays);

    // Distinct trade dates actually observed in the bar store.
    const rows: Array<{ d: string }> = await AppDataSource.query(
      `SELECT DISTINCT trading_date::text AS d FROM stock_history
        WHERE trading_date BETWEEN $1::date AND $2::date ORDER BY d`,
      [from, today]
    );
    const observedDates = new Set(rows.map((r) => r.d));

    let observed = 0;
    let closedNoData = 0;
    let projected = 0;
    const now = new Date();

    await AppDataSource.transaction(async (em) => {
      const repo = em.getRepository(TradingSession);
      const existing = new Map<string, TradingSession>();
      const span = await repo
        .createQueryBuilder("s")
        .where("s.session_date BETWEEN :a AND :b", {
          a: from,
          b: addCalendarDays(today, horizonDays),
        })
        .getMany();
      for (const s of span) existing.set(String(s.sessionDate), s);

      const put = async (
        date: string,
        status: TradingSession["status"],
        basis: TradingSession["basis"],
        confirmed: boolean
      ) => {
        const prior = existing.get(date);
        if (prior) {
          // Never downgrade a confirmed (observed/no_data) row; upgrade
          // projections once reality is known.
          const priorConfirmed = prior.basis === "observed" || prior.basis === "no_data";
          if (priorConfirmed) return false;
          if (prior.status === status && prior.basis === basis) return false;
          prior.status = status;
          prior.basis = basis;
          prior.confirmedAt = confirmed ? now : null;
          await repo.save(prior);
          return true;
        }
        const row = repo.create({
          sessionDate: date,
          status,
          basis,
          confirmedAt: confirmed ? now : null,
        });
        await repo.save(row);
        existing.set(date, row);
        return true;
      };

      // Past + today: observed sessions and reconciled closures.
      for (const date of calendarRange(from, today)) {
        if (observedDates.has(date)) {
          if (await put(date, "session", "observed", true)) observed++;
        } else if (isWeekend(date)) {
          await put(date, "closed", "weekend", true);
        } else if (date < addCalendarDays(today, -(graceDays - 1))) {
          // Past weekday, whole universe silent, grace elapsed ⇒ closed.
          if (await put(date, "closed", "no_data", true)) closedNoData++;
        }
        // Recent weekday with no data inside grace: leave unresolved.
      }

      // Future: weekends by rule, weekdays provisionally projected.
      for (const date of calendarRange(addCalendarDays(today, 1), addCalendarDays(today, horizonDays))) {
        if (isWeekend(date)) {
          await put(date, "closed", "weekend", true);
        } else {
          if (await put(date, "session", "weekday_projection", false)) projected++;
        }
      }
    });

    return { observed, closedNoData, projected };
  }

  /**
   * Resolve every calendar day in [start, end] (inclusive, IST dates).
   * Future weekdays without a confirmed row resolve as "projected_session";
   * unknown past dates resolve honestly as "closed" only when the calendar
   * says so, otherwise they surface as projected (caller decides display).
   */
  async resolveRange(start: string, end: string): Promise<ResolvedDay[]> {
    const rows = await this.repo()
      .createQueryBuilder("s")
      .where("s.session_date BETWEEN :a AND :b", { a: start, b: end })
      .getMany();
    const byDate = new Map(rows.map((s) => [String(s.sessionDate), s]));

    return calendarRange(start, end).map((date) => {
      const row = byDate.get(date);
      if (row) {
        if (row.status === "session") {
          return row.basis === "observed"
            ? { date, state: "session", basis: row.basis, label: row.label }
            : { date, state: "projected_session", basis: row.basis, label: row.label };
        }
        return {
          date,
          state: row.basis === "weekend" ? "weekend" : "closed",
          basis: row.basis,
          label: row.label,
        };
      }
      // No calendar row: fall back to the rule for weekends, provisional else.
      if (isWeekend(date)) return { date, state: "weekend", basis: "weekend" };
      return { date, state: "projected_session", basis: "weekday_projection" };
    });
  }

  /** Latest confirmed (observed) session on or before the given IST date. */
  async lastObservedSession(onOrBefore: string): Promise<string | null> {
    const row = await this.repo()
      .createQueryBuilder("s")
      .where("s.session_date <= :d", { d: onOrBefore })
      .andWhere("s.basis = 'observed'")
      .orderBy("s.session_date", "DESC")
      .getOne();
    return row ? String(row.sessionDate) : null;
  }
}

export const sessionCalendarService = new SessionCalendarService();
export default sessionCalendarService;
