/**
 * ReasoningService (risk-spec Rule 13) — orchestrates the AI Investment
 * Committee: builds the structured context from STORED deterministic outputs
 * (the latest decision snapshot — never fresh computation, never raw prices
 * for the model to "forecast" from), calls the provider, and records the
 * append-only ai_reviews audit row.
 *
 * The committee is ADVISORY and CAP-ONLY: its output never overrides the
 * TradeGate (clamped in reasoning/types.ts) and is stored/displayed alongside
 * the deterministic decision, clearly attributed.
 */

import { AppDataSource } from "../../config/database";
import { AiReview, DecisionSnapshot, Instrument } from "../../entities";
import { HttpError } from "../../types";
import { claudeProvider } from "./ClaudeProvider";
import { CommitteeContext, CommitteeResult, InvestmentReasoningProvider } from "./types";

export class ReasoningService {
  constructor(private readonly provider: InvestmentReasoningProvider = claudeProvider) {}

  available(): boolean {
    return this.provider.isAvailable();
  }

  /** Latest stored review for a ticker, or null. */
  async latestReview(ticker: string): Promise<AiReview | null> {
    const t = this.normalize(ticker);
    return AppDataSource.getRepository(AiReview).findOne({
      where: { ticker: t },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Run the committee against the LATEST PUBLISHED decision snapshot.
   * Requires a snapshot (the committee reasons about deterministic outputs,
   * it does not replace them). userContext is only what the caller supplied.
   */
  async review(
    ticker: string,
    userContext?: {
      holdsPosition?: boolean;
      purchasePrice?: number | null;
      investmentHorizon?: string | null;
      riskTolerance?: string | null;
    } | null
  ): Promise<{ review: AiReview; result: CommitteeResult }> {
    if (!this.provider.isAvailable()) {
      throw new HttpError(
        503,
        "AI committee unavailable: no reasoning provider is configured (set ANTHROPIC_API_KEY). " +
          "The deterministic evidence-gated decision remains fully functional without it."
      );
    }
    const t = this.normalize(ticker);
    const instrument = await AppDataSource.getRepository(Instrument)
      .createQueryBuilder("i")
      .where("i.yahoo_ticker IN (:...c)", { c: [t, t.endsWith(".NS") ? t : `${t}.NS`] })
      .getOne();
    if (!instrument) throw new HttpError(404, `${ticker} is not in the supported instrument universe.`);

    const snapshot = await AppDataSource.getRepository(DecisionSnapshot).findOne({
      where: { instrumentId: instrument.id },
      order: { asOf: "DESC" },
    });
    if (!snapshot) {
      throw new HttpError(
        409,
        `No published decision snapshot exists for ${instrument.yahooTicker} — publish one first ` +
          `(POST /api/decision/:ticker/publish). The committee reviews deterministic outputs; it never replaces them.`
      );
    }

    const context = this.buildContext(
      snapshot,
      userContext ? { ...userContext, holdsPosition: userContext.holdsPosition === true } : null
    );
    const result =
      userContext?.holdsPosition === true
        ? await this.provider.evaluateExistingPosition(context)
        : await this.provider.evaluateStock(context);

    const repo = AppDataSource.getRepository(AiReview);
    const review = await repo.save(
      repo.create({
        ticker: instrument.yahooTicker,
        promptVersion: result.promptVersion,
        modelName: result.modelName,
        provider: result.provider,
        inputHash: result.inputHash,
        requestContext: context as unknown as Record<string, unknown>,
        response: result.review as unknown as Record<string, unknown>,
        clamped: result.clamped,
        clampNotes: result.clampNotes,
        latencyMs: result.latencyMs,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      })
    );
    return { review, result };
  }

  /** Build the Rule-13 input contract from a stored snapshot's fields only. */
  private buildContext(
    s: DecisionSnapshot,
    userContext: CommitteeContext["userContext"]
  ): CommitteeContext {
    const sc = (s.scoreCard ?? null) as CommitteeContext["technicals"] extends never ? never : Record<string, any> | null;
    const ev = (s.expectedValue ?? null) as Record<string, any> | null;
    const inputs = (s.inputs ?? {}) as Record<string, any>;
    const measured = (inputs.measured ?? null) as Record<string, any> | null;
    const issuance = (inputs.issuance ?? null) as Record<string, any> | null;
    const fc = sc?.forecastConfidence ?? null;

    return {
      ticker: s.ticker,
      timestamp: s.asOf.toISOString(),
      price: null, // the committee reasons about evidence, not price levels it might "forecast" from
      userContext,
      fundamentals: null, // full fundamentals ride the snapshot in a later slice; absence is stated
      valuation: sc?.valuationScore != null ? { valuationScore: sc.valuationScore, notes: [] } : null,
      technicals: sc
        ? {
            setupScore: sc.setupScore ?? null,
            entryQualityScore: sc.entryTimingScore ?? null,
            details: {},
          }
        : null,
      regime: null,
      events: null,
      forecast: issuance
        ? {
            horizonDays: 30,
            medianReturnPct: issuance.medianReturnPct30 ?? null,
            p10Pct: ev?.expectedDownsidePct ?? null,
            p90Pct: ev?.expectedUpsidePct ?? null,
            scenarioFrequencyUp: ev?.scenarioFrequencyUp ?? null,
            method: "seeded bootstrap issuance (historical scenario frequencies — uncalibrated)",
          }
        : null,
      calibration: {
        brier: measured?.brierScore ?? null,
        brierSkill: fc?.brierSkill ?? (measured?.brierScore != null ? 0.25 - measured.brierScore : null),
        bandCoveragePct: measured?.withinBandPct ?? null,
        calibrated: false, // no calibrator has passed out-of-sample validation (Rule 9)
      },
      walkForwardPerformance: {
        directionHitRatePct: measured?.directionHitRatePct ?? null,
        rawSamples: measured?.samples ?? null,
      },
      effectiveSampleSize: fc?.effectiveSamples ?? null,
      risk: sc?.risk
        ? { score: sc.risk.score ?? null, band: sc.risk.band ?? "unknown", reasons: sc.risk.reasons ?? [] }
        : null,
      expectedValue: ev
        ? {
            expectedReturnPct: ev.expectedReturnPct ?? null,
            evAfterCostsPct: ev.evAfterCostsPct ?? null,
            rewardRiskRatio: ev.rewardRiskRatio ?? null,
            expectedShortfallPct: ev.expectedShortfallPct ?? null,
          }
        : null,
      dataQuality: sc?.dataQuality
        ? { score: sc.dataQuality.score ?? null, penalties: sc.dataQuality.penalties ?? [] }
        : null,
      gate: {
        newEntryAction: s.decisionStatus,
        existingHolderAction: s.existingHolderAction ?? null,
        unmetGates: s.unmetGates ?? [],
        decisionPolicyVersion: s.decisionPolicyVersion,
      },
    };
  }

  private normalize(ticker: string): string {
    const t = ticker.trim().toUpperCase();
    return t.endsWith(".NS") || t.endsWith(".BO") ? t : `${t}.NS`;
  }
}

export const reasoningService = new ReasoningService();
export default reasoningService;
