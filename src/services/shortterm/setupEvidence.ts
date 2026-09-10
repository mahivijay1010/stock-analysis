/**
 * SetupEvidenceService (Parts 3/4/25) — the setup-specific evidence gate.
 *
 * Reads the persisted expectancy study (short_term_model_performance rows,
 * model_name 'st-setup-expectancy') keyed by setupType×horizon(×regime) and
 * returns the full realized-R evidence record plus a deterministic
 * `evidenceStrength` tier and `usableForEntry` flag. A setup may back an
 * ENTRY_CONFIRMED action ONLY when it demonstrates positive after-cost
 * expectancy whose bootstrap lower bound is > 0 on enough INDEPENDENT entry
 * dates AND survives Benjamini–Hochberg multiple-testing correction.
 *
 * No study row ⇒ the setup is UNVALIDATED ⇒ tier C at best (RESEARCH_WATCH).
 * Nothing is hardcoded per setup; a setup earns promotion when the study says
 * so. Verdicts are pre-registered in the study script before the final read.
 */

import { AppDataSource } from "../../config/database";
import { EvidenceTier } from "./actionStates";
import { ShortTermHorizon, SetupType } from "./types";

export const SETUP_EVIDENCE_MODEL = "st-setup-expectancy";

export interface SetupEvidence {
  setupType: string;
  horizon: string;
  regime: string | null;
  rawTrades: number;
  independentEntryDates: number;
  targetFirstRate: number;
  stopFirstRate: number;
  timeoutRate: number;
  averageR: number;
  medianR: number;
  averageWinR: number;
  averageLossR: number;
  expectancyR: number;
  expectancyAfterCosts: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  bootstrapExpectancyCI: [number, number];
  probabilityExpectancyPositive: number;
  bhSignificant: boolean;
  evidenceStrength: EvidenceTier;
  /** Maturity of the evidence — a backtest tier is NOT production-grade until
   *  survivorship (PIT universe) is accounted AND prospective shadow confirms. */
  evidenceStage: EvidenceStage;
  usableForEntry: boolean;
  note: string;
}

export type EvidenceStage = "BACKTEST_PROVISIONAL" | "PIT_VALIDATED" | "PROSPECTIVE_CONFIRMED";

/**
 * Point-in-time universe membership (delistings/mergers/suspensions) is NOT
 * yet reconstructed, so every backtest is survivorship-exposed. Until that
 * flag flips, a tier-A cell is BACKTEST_PROVISIONAL — real signal, not final
 * evidence — and is held below live ENTRY authority regardless (shadow gate).
 */
export const PIT_UNIVERSE_AVAILABLE = false;

/** Pre-registered promotion thresholds (Part 25) — fixed before the final study read. */
export const SETUP_PROMOTION = {
  minIndependentDates: 60,
  minExpectancyAfterCostsR: 0.1,
  ciLowerMustExceed: 0,
  minProbExpectancyPositive: 0.9,
} as const;

/** Derive the tier from a realized-R evidence row (deterministic, Part 19/25). */
export function tierFromEvidence(e: Omit<SetupEvidence, "evidenceStrength" | "usableForEntry" | "note" | "evidenceStage">): {
  tier: EvidenceTier;
  usable: boolean;
  stage: EvidenceStage;
  note: string;
} {
  const P = SETUP_PROMOTION;
  const strongExpectancy = e.expectancyAfterCosts >= P.minExpectancyAfterCostsR && e.bootstrapExpectancyCI[0] > P.ciLowerMustExceed;
  const enoughDates = e.independentEntryDates >= P.minIndependentDates;
  const confident = e.probabilityExpectancyPositive >= P.minProbExpectancyPositive;
  const stage: EvidenceStage = PIT_UNIVERSE_AVAILABLE ? "PIT_VALIDATED" : "BACKTEST_PROVISIONAL";

  if (strongExpectancy && enoughDates && confident && e.bhSignificant) {
    return {
      tier: "A",
      usable: true,
      stage,
      note: PIT_UNIVERSE_AVAILABLE
        ? "validated: positive after-cost expectancy, CI lower > 0, survives FDR"
        : "BACKTEST-PROVISIONAL tier A — positive after-cost expectancy, CI lower > 0, survives FDR, BUT survivorship (PIT universe) is not yet accounted; not production-grade until PIT-validated and shadow-confirmed",
    };
  }
  if (e.expectancyAfterCosts > 0 && enoughDates && e.probabilityExpectancyPositive >= 0.75) {
    return { tier: "B", usable: false, stage, note: "promising but not yet promotable — expectancy positive, evidence not decisive" };
  }
  if (e.rawTrades > 0) {
    return {
      tier: "C",
      usable: false,
      stage,
      note:
        e.expectancyAfterCosts <= 0
          ? `unvalidated — realized after-cost expectancy ${e.expectancyAfterCosts}R is not positive`
          : "unvalidated — insufficient independent evidence",
    };
  }
  return { tier: "D", usable: false, stage: "BACKTEST_PROVISIONAL", note: "no historical evidence for this setup" };
}

export class SetupEvidenceService {
  private cache: Map<string, SetupEvidence[]> | null = null;

  private key(setup: string, horizon: string, regime: string | null): string {
    return `${setup}|${horizon}|${regime ?? "ALL"}`;
  }

  private async load(): Promise<Map<string, SetupEvidence[]>> {
    if (this.cache) return this.cache;
    const map = new Map<string, SetupEvidence[]>();
    try {
      const rows: Array<{ metrics: Record<string, unknown> }> = await AppDataSource.query(
        `SELECT metrics FROM short_term_model_performance
          WHERE model_name = $1 ORDER BY created_at DESC LIMIT 1`,
        [SETUP_EVIDENCE_MODEL]
      );
      const cells = (rows[0]?.metrics?.cells ?? []) as SetupEvidence[];
      for (const c of cells) {
        const k = this.key(c.setupType, c.horizon, c.regime);
        const list = map.get(k) ?? [];
        list.push(c);
        map.set(k, list);
      }
    } catch {
      /* no study yet — every lookup returns the unvalidated default */
    }
    this.cache = map;
    return map;
  }

  /** Best available evidence for a setup×horizon, preferring the regime-specific cell. */
  async lookup(setup: SetupType, horizon: ShortTermHorizon, regime: string | null): Promise<SetupEvidence> {
    const map = await this.load();
    const specific = regime ? map.get(this.key(setup, horizon, regime))?.[0] : undefined;
    const pooled = map.get(this.key(setup, horizon, null))?.[0];
    const found = specific ?? pooled;
    if (found) return found;
    return {
      setupType: setup,
      horizon,
      regime,
      rawTrades: 0,
      independentEntryDates: 0,
      targetFirstRate: 0,
      stopFirstRate: 0,
      timeoutRate: 0,
      averageR: 0,
      medianR: 0,
      averageWinR: 0,
      averageLossR: 0,
      expectancyR: 0,
      expectancyAfterCosts: 0,
      profitFactor: null,
      maxDrawdownR: 0,
      bootstrapExpectancyCI: [0, 0],
      probabilityExpectancyPositive: 0,
      bhSignificant: false,
      evidenceStrength: "D",
      evidenceStage: "BACKTEST_PROVISIONAL",
      usableForEntry: false,
      note: "no expectancy study has been run for this setup×horizon yet — treated as unvalidated",
    };
  }

  invalidateCache(): void {
    this.cache = null;
  }
}

export const setupEvidenceService = new SetupEvidenceService();
