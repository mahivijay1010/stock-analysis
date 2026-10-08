/**
 * Money Desk / capital-allocation layer — shared types.
 *
 * This layer sits ON TOP of the short-term engine. It never detects setups,
 * never computes entry/stop/target, never produces a probability. It consumes
 * the persisted ShortTermCandidateView payloads (gates, tier, EV lower bound,
 * reward:risk, plan geometry, freshness, model health, AI cap) and decides only
 * HOW MUCH capital each already-qualified setup may receive, how much cash to
 * keep, and whether existing holdings should be reduced — then records every
 * decision immutably so its own track record can be measured.
 */

export const CAPITAL_DESK_VERSION = "capital-desk-v1";
export const CAPITAL_POLICY_VERSION = "capital-policy-v1";

export type RiskProfileName = "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
export type CapitalHorizon = "3-5d" | "5-10d" | "10-21d";

export type AllocationAction = "ALLOCATE" | "WATCH" | "HOLD" | "REDUCE" | "EXIT" | "TRAIL" | "CASH";

/** Machine-readable "why / why not" codes. Every code maps to a plain sentence in REASON_TEXT. */
export type ReasonCode =
  | "QUALIFIED_SETUP"
  | "ENTRY_NOT_CONFIRMED"
  | "EV_LOWER_BOUND_NEGATIVE"
  | "EV_UNAVAILABLE"
  | "REWARD_RISK_BELOW_MIN"
  | "EVIDENCE_TIER_INSUFFICIENT"
  | "MODEL_HEALTH_INSUFFICIENT"
  | "LIQUIDITY_INSUFFICIENT"
  | "NOT_TRADEABLE"
  | "REGIME_CONFLICT"
  | "REGIME_ENTRIES_OFF"
  | "CIRCUIT_BREAKER"
  | "STALE_DATA"
  | "DELAYED_DATA"
  | "INVALID_GEOMETRY"
  | "HORIZON_MISMATCH"
  | "AI_CAP_NO_TRADE"
  | "AI_CAP_WATCH"
  | "MAX_POSITIONS_REACHED"
  | "ALREADY_HELD"
  | "CASH_RESERVE_BINDING"
  | "RISK_BUDGET_EXHAUSTED"
  | "POSITION_CAP_BINDING"
  | "SECTOR_CAP_BINDING"
  | "CAPITAL_TOO_SMALL_FOR_ONE_SHARE"
  | "PRICE_UNAVAILABLE"
  | "NO_EVALUATION_ON_FILE"
  | "INVALIDATION_HIT"
  | "STOP_HIT"
  | "TARGET1_REACHED"
  | "TARGET2_REACHED"
  | "REWARD_RISK_COMPRESSED"
  | "SETUP_DETERIORATED"
  | "CONCENTRATION_ABOVE_CAP"
  | "HOLDING_PERIOD_EXCEEDED"
  | "REGIME_RISK_OFF"
  | "PLAN_HEALTHY";

export const REASON_TEXT: Record<ReasonCode, string> = {
  QUALIFIED_SETUP: "every deterministic gate passed (tier A, entry confirmed, EV lower bound above costs, healthy model)",
  ENTRY_NOT_CONFIRMED: "entry confirmation missing — the setup exists but the engine has not confirmed the entry",
  EV_LOWER_BOUND_NEGATIVE: "EV lower bound (80%) does not survive costs",
  EV_UNAVAILABLE: "no EV evidence on the plan",
  REWARD_RISK_BELOW_MIN: "reward/risk to target 1 is below this risk profile's minimum",
  EVIDENCE_TIER_INSUFFICIENT: "setup evidence tier is below the profile's minimum",
  MODEL_HEALTH_INSUFFICIENT: "short-term model health is not HEALTHY for this setup",
  LIQUIDITY_INSUFFICIENT: "liquidity insufficient — the order would exceed the participation cap",
  NOT_TRADEABLE: "tradeability gate blocked this stock (surveillance / series / circuit band / thin value)",
  REGIME_CONFLICT: "setup type is not allowed in the current market regime",
  REGIME_ENTRIES_OFF: "market regime is CRISIS — new long entries are off",
  CIRCUIT_BREAKER: "the system circuit breaker is tripped — no new risk",
  STALE_DATA: "data is STALE — the decision cannot be trusted",
  DELAYED_DATA: "data is delayed intraday — allocation waits for a completed bar",
  INVALID_GEOMETRY: "entry / stop / target geometry is invalid (stop must be below entry, target above)",
  HORIZON_MISMATCH: "the plan's expected holding period does not match the chosen horizon",
  AI_CAP_NO_TRADE: "AI risk review capped this setup to NO TRADE (cap-only, never raises)",
  AI_CAP_WATCH: "AI risk review capped this setup to WATCH (cap-only, never raises)",
  MAX_POSITIONS_REACHED: "maximum simultaneous positions for this profile already reached",
  ALREADY_HELD: "already held — no new capital added to an existing position",
  CASH_RESERVE_BINDING: "the cash reserve for this profile leaves no deployable capital",
  RISK_BUDGET_EXHAUSTED: "the portfolio risk budget is used up by positions ranked above",
  POSITION_CAP_BINDING: "position capped at the profile's maximum share of capital",
  SECTOR_CAP_BINDING: "sector cap binding",
  CAPITAL_TOO_SMALL_FOR_ONE_SHARE: "risk-based size rounds to zero shares at this capital",
  PRICE_UNAVAILABLE: "no observed price — the holding cannot be evaluated",
  NO_EVALUATION_ON_FILE: "no short-term evaluation on file for this holding — exit rules not evaluated",
  INVALIDATION_HIT: "price is at or below the plan's invalidation level",
  STOP_HIT: "price is at or below the plan's initial stop",
  TARGET1_REACHED: "target 1 reached — plan says exit half and trail the rest",
  TARGET2_REACHED: "target 2 reached — plan says reduce further and trail",
  REWARD_RISK_COMPRESSED: "remaining reward/risk to target is compressed",
  SETUP_DETERIORATED: "setup evidence deteriorated (EV lower bound no longer positive)",
  CONCENTRATION_ABOVE_CAP: "position exceeds the profile's maximum share of capital",
  HOLDING_PERIOD_EXCEEDED: "holding period exceeded the plan's expected sessions — time exit",
  REGIME_RISK_OFF: "market regime is risk-off — reduce exposure per profile",
  PLAN_HEALTHY: "plan intact: above stop, below target, evidence unchanged",
};

export interface FreshnessContract {
  quoteTimestamp: string | null;
  quoteType: "EOD_FINAL" | "DELAYED_INTRADAY" | "LIVE" | "STALE" | "UNKNOWN";
  marketState: "OPEN" | "CLOSED" | "PRE_OPEN" | "UNKNOWN";
  latestCompletedBarDate: string | null;
  providerDelay: string;
  featureCutoffAt: string | null;
}

/** The slice of a persisted ShortTermCandidateView the desk consumes. */
export interface CapitalCandidateInput {
  ticker: string;
  name: string;
  sector: string | null;
  currentPrice: number | null;
  action: string;
  tier: "A" | "B" | "C" | "D" | string;
  qualified: boolean;
  modelHealth: string;
  freshnessV2: string;
  setupType: string;
  rank: number | null;
  rankingScore: number | null;
  gateFailures: Array<{ gate: string; current: string; required: string }>;
  ceilingReasons: string[];
  whyNotEntry: string[];
  plan: {
    entryType: string;
    entryZoneLow: number | null;
    entryZoneHigh: number | null;
    entryTriggerPrice: number | null;
    initialStop: number | null;
    target1: number | null;
    target2: number | null;
    target3: number | null;
    rewardRiskToTarget1: number | null;
    expectedHoldingDays: number;
    invalidationPrice: number | null;
    invalidationReason: string | null;
    atr14: number | null;
    advInr: number | null;
    transactionCostPct: number | null;
    estimatedSlippagePct: number | null;
  };
  ev: { ev80LowerPct: number | null; meanEvAfterCostsPct: number | null; expectedR: number | null } | null;
  setupEvidence: { evidenceStrength: string; usableForEntry: boolean } | null;
  probability: { status: string; targetBeforeStop: number | null };
  relVolume: number | null;
  tradeability: { tradeable: boolean; hardBlocks: string[] } | null;
  aiCapAction: "AFFIRM" | "CAP_TO_WATCH" | "CAP_TO_NO_TRADE" | null;
  /** Evidence score (0–100) if the conviction board scored it; else null. */
  evidenceScore: number | null;
  decisionSnapshotId: string | null;
}

export interface CapitalHoldingInput {
  ticker: string;
  name: string;
  qty: number;
  sector: string | null;
  investedInr: number;
  price: number | null;
  priceAsOf: string | null;
  markedValueInr: number | null;
  /** Latest short-term evaluation for this holding, if one exists. */
  evidence: CapitalCandidateInput | null;
  evidenceAsOf: string | null;
}

export type EnvLabel = "TAILWIND" | "NEUTRAL" | "HEADWIND" | "STRESS";

/** Global context handed to the desk. It is CONTEXT and a risk input; it never vetoes a stock. */
export interface GlobalContextInput {
  regime: "RISK_ON" | "NEUTRAL" | "CAUTIOUS" | "RISK_OFF" | "STRESSED";
  regimeReasons: string[];
  transmission: EnvLabel;
  transmissionReasons: string[];
  /** Historical evidence for the regime: NIFTY 5-session median / win rate with n; null when withheld. */
  evidence: { n: number; niftyMedian5dPct: number | null; niftyWinRate5dPct: number | null; unconditionalMedian5dPct: number | null } | null;
  sectorLabels: Record<string, EnvLabel>; // by NSE industry or sector proxy key
  globalDataAsOf: string | null;
  indiaDataAsOf: string | null;
}

export interface MarketContextInput {
  regime: string; // TREND_UP | TREND_DOWN | CHOPPY | HIGH_VOL | CRISIS
  regimeReasons: string[];
  breakerCanEnter: boolean;
  breakerReason: string | null;
  freshness: FreshnessContract;
  global?: GlobalContextInput | null;
}

export interface PlannedAllocation {
  ticker: string;
  name: string;
  sector: string | null;
  action: "ALLOCATE" | "WATCH";
  recommendedAmountInr: number;
  recommendedQuantity: number;
  maxAmountInr: number;
  percentageOfCapital: number;
  entryPrice: number;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  entryType: string;
  stopPrice: number;
  target1: number;
  target2: number | null;
  target3: number | null;
  expectedHoldingSessions: number;
  riskAmountInr: number;
  rewardRisk: number;
  evAfterCostsPct: number | null;
  ev80LowerPct: number | null;
  evidenceTier: string;
  evidenceScore: number | null;
  setupType: string;
  probability: { status: string; targetBeforeStop: number | null };
  reasonCodes: ReasonCode[];
  riskReasons: string[];
  invalidationReasons: string[];
  sizingConstraints: string[];
  decisionSnapshotId: string | null;
  /** What would change this decision — derived from the plan's own levels. */
  changesIf: string[];
  /** Environment context — shown, never a veto. */
  environment: { global: EnvLabel; india: EnvLabel; sector: EnvLabel; setup: "PASS" | "FAIL"; label: string; macroRiskMultiplier: number };
}

export interface RejectedCandidate {
  ticker: string;
  name: string;
  setupType: string;
  tier: string;
  action: string;
  reasonCodes: ReasonCode[];
  whyNot: string[];
  /** The engine's own gate failures, verbatim. */
  gateFailures: Array<{ gate: string; current: string; required: string }>;
}

export interface WithdrawalDecision {
  ticker: string;
  name: string;
  action: "HOLD" | "TRAIL" | "REDUCE" | "EXIT";
  qty: number;
  currentValueInr: number | null;
  investedInr: number;
  pnlInr: number | null;
  pnlPct: number | null;
  recommendedRemainingInr: number | null;
  amountToWithdrawInr: number | null;
  qtyToSell: number | null;
  trailStopPrice: number | null;
  reasonCodes: ReasonCode[];
  reasons: string[];
  invalidation: string[];
  evidenceAsOf: string | null;
}

export interface CashSummary {
  capitalAvailableInr: number;
  capitalInvestedInr: number;
  totalEquityInr: number;
  cashReserveInr: number;
  cashReservePct: number;
  recommendedDeploymentInr: number;
  recommendedCashInr: number;
  maxDeployableInr: number;
  riskBudgetInr: number;
  riskUsedInr: number;
  unusedRiskBudgetInr: number;
  whyCash: string[];
}

export interface ScenarioSummary {
  label: "SCENARIO — not a prediction";
  maxPortfolioLossInr: number;
  maxPortfolioLossPct: number;
  maxUpsideAtTarget1Inr: number;
  maxUpsideAtTarget1Pct: number;
  riskPerPositionInr: number[];
  concentrationLargestPct: number;
  positions: number;
}

export interface CapitalPlanResult {
  version: string;
  policyVersion: string;
  asOf: string;
  riskProfile: RiskProfileName;
  horizon: CapitalHorizon;
  maxPositions: number;
  regime: { regime: string; reasons: string[]; sizeMultiplier: number };
  global: { regime: string | null; transmission: EnvLabel | null; macroRiskMultiplier: number; maxPositionsAfterMacro: number; policy: string; reasons: string[]; globalDataAsOf: string | null; indiaDataAsOf: string | null };
  circuitBreaker: { canEnter: boolean; reason: string | null };
  freshness: FreshnessContract;
  allocations: PlannedAllocation[];
  conditional: PlannedAllocation[];
  holds: WithdrawalDecision[];
  withdrawals: WithdrawalDecision[];
  rejected: RejectedCandidate[];
  cash: CashSummary;
  scenario: ScenarioSummary;
  summary: string;
  noNewAllocation: boolean;
  candidatesEvaluated: number;
}
