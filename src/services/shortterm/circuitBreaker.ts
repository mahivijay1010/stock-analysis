/**
 * Drawdown circuit breaker (circuit-breaker-v1) — PURE.
 *
 * Small-cap strategies die from one bad regime, not from one bad trade. This
 * halts NEW entries when the recent track record turns against you — a rolling
 * expectancy that has gone negative, or an equity drawdown past a limit — and
 * refuses to resume until BOTH the numbers recover AND the market regime is no
 * longer risk-off. It never forces a trade; the only thing it does is say "stop
 * opening new risk", which is the one instruction that saves accounts.
 *
 * Equity is measured in R (risk units): each closed trade contributes its
 * realized R, so a −6R drawdown is six full-risk losses deep. No forecast is
 * made; the breaker reacts to what already happened.
 */

export const CIRCUIT_BREAKER_VERSION = "circuit-breaker-v1";

export interface ClosedTrade {
  date: string; // YYYY-MM-DD, resolution date
  realizedR: number; // observed R multiple (net of costs)
}

export interface CircuitBreakerConfig {
  rollingWindow: number; // trades in the expectancy window
  maxDrawdownR: number; // equity drawdown (in R) that trips the breaker
  minTradesToAssess: number; // below this, the breaker abstains (INSUFFICIENT)
  recoveryDrawdownR: number; // drawdown must fall below this to re-arm
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  rollingWindow: 20,
  maxDrawdownR: 6,
  minTradesToAssess: 20,
  recoveryDrawdownR: 3,
};

export type BreakerState = "ACTIVE" | "TRIPPED" | "COOLDOWN" | "INSUFFICIENT";

export interface CircuitBreakerResult {
  version: string;
  state: BreakerState;
  /** The bottom line: may the system open a NEW position right now? */
  canEnter: boolean;
  tradesAssessed: number;
  rollingExpectancyR: number | null;
  currentEquityR: number;
  peakEquityR: number;
  currentDrawdownR: number;
  maxDrawdownR: number;
  regimeRiskOff: boolean;
  reasons: string[];
  resumeConditions: string[];
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** `regime` is the current market regime label (from regime.ts); CRISIS and
 *  TREND_DOWN are treated as risk-off and block re-arming. */
export function assessCircuitBreaker(trades: ClosedTrade[], regime: string | null | undefined, cfgIn: Partial<CircuitBreakerConfig> = {}): CircuitBreakerResult {
  const cfg = { ...DEFAULT_CIRCUIT_CONFIG, ...cfgIn };
  const sorted = [...trades].filter((t) => Number.isFinite(t.realizedR)).sort((a, b) => a.date.localeCompare(b.date));
  const regimeRiskOff = regime === "CRISIS" || regime === "TREND_DOWN";

  const base: CircuitBreakerResult = {
    version: CIRCUIT_BREAKER_VERSION,
    state: "INSUFFICIENT",
    canEnter: true,
    tradesAssessed: sorted.length,
    rollingExpectancyR: null,
    currentEquityR: 0,
    peakEquityR: 0,
    currentDrawdownR: 0,
    maxDrawdownR: 0,
    regimeRiskOff,
    reasons: [],
    resumeConditions: [],
  };

  if (sorted.length < cfg.minTradesToAssess) {
    base.reasons.push(`Only ${sorted.length} resolved trades (< ${cfg.minTradesToAssess}) — the breaker abstains; sizing/gates still apply.`);
    // Even when abstaining, a risk-off regime still caps entries elsewhere; the
    // breaker itself does not block on too little data.
    return base;
  }

  // Equity curve in R + drawdowns.
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.realizedR;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const currentDd = peak - equity;
  const window = sorted.slice(-cfg.rollingWindow);
  const rollExp = window.reduce((a, t) => a + t.realizedR, 0) / window.length;

  base.currentEquityR = r3(equity);
  base.peakEquityR = r3(peak);
  base.currentDrawdownR = r3(currentDd);
  base.maxDrawdownR = r3(maxDd);
  base.rollingExpectancyR = r3(rollExp);

  const expNegative = rollExp < 0;
  const ddBreached = currentDd > cfg.maxDrawdownR;
  const tripped = expNegative || ddBreached;

  if (tripped) {
    if (expNegative) base.reasons.push(`Rolling ${window.length}-trade expectancy is ${r3(rollExp)}R (< 0) — the recent edge is negative.`);
    if (ddBreached) base.reasons.push(`Equity drawdown ${r3(currentDd)}R exceeds the ${cfg.maxDrawdownR}R limit.`);
    base.state = "TRIPPED";
    base.canEnter = false;
    base.resumeConditions.push(`rolling expectancy back above 0 (now ${r3(rollExp)}R)`);
    base.resumeConditions.push(`drawdown below ${cfg.recoveryDrawdownR}R (now ${r3(currentDd)}R)`);
    base.resumeConditions.push("market regime no longer risk-off (not CRISIS/TREND_DOWN)");
    return base;
  }

  // Metrics are healthy. If the regime is still risk-off, hold in COOLDOWN —
  // wait for regime confirmation before re-opening risk.
  if (regimeRiskOff) {
    base.state = "COOLDOWN";
    base.canEnter = false;
    base.reasons.push(`Numbers have recovered (expectancy ${r3(rollExp)}R, drawdown ${r3(currentDd)}R) but the regime is ${regime} — holding new entries until it confirms.`);
    base.resumeConditions.push("market regime no longer risk-off");
    return base;
  }

  base.state = "ACTIVE";
  base.canEnter = true;
  base.reasons.push(`Healthy: rolling expectancy ${r3(rollExp)}R, drawdown ${r3(currentDd)}R of a ${cfg.maxDrawdownR}R limit.`);
  return base;
}
