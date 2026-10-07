/**
 * Portfolio risk engine (portfolio-risk-v1) — PURE.
 *
 * Per-trade sizing answers "how much do I risk on THIS trade"; it says nothing
 * about the portfolio. For sub-₹100 small-caps that gap is dangerous: they are
 * highly correlated, so five "different" picks in a small-cap sell-off are one
 * bet that all gaps down together. This engine turns a set of positions into a
 * portfolio view: VaR/CVaR (historical + parametric), concentration (Herfindahl),
 * sector exposure, correlation CLUSTERS (positions that move as one), portfolio
 * beta, and hard limit checks — including whether a NEW position may be added.
 *
 * Everything is a FACT derived from the supplied return series and weights. No
 * forecast is made; risk is measured on observed co-movement, not predicted.
 */

export const PORTFOLIO_RISK_VERSION = "portfolio-risk-v1";

export interface PortfolioPosition {
  ticker: string;
  sector: string | null;
  valueInr: number; // capital deployed in this position
  beta: number | null; // vs the benchmark, optional
  /** Daily returns (fraction, e.g. 0.01 = +1%), aligned across positions. */
  returns: number[];
}

export interface RiskLimits {
  maxSingleStockPct: number; // 10
  maxSectorPct: number; // 30
  maxPortfolioCvar95Pct: number; // 8 (daily CVaR)
  correlationThreshold: number; // 0.7
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxSingleStockPct: 10,
  maxSectorPct: 30,
  maxPortfolioCvar95Pct: 8,
  correlationThreshold: 0.7,
};

export interface PortfolioRisk {
  version: string;
  capitalInr: number;
  deployedInr: number;
  cashPct: number;
  positions: number;
  /** Daily loss not exceeded (1−α) of days, % of capital. Positive numbers. */
  var95Pct: number | null;
  var99Pct: number | null;
  cvar95Pct: number | null; // expected shortfall beyond VaR95
  cvar99Pct: number | null;
  parametricVar95Pct: number | null;
  annualVolPct: number | null;
  /** Herfindahl concentration over deployed weights (1/HHI = effective names). */
  herfindahl: number | null;
  effectiveNames: number | null;
  top5WeightPct: number | null;
  sectorExposure: Array<{ sector: string; weightPct: number; breach: boolean }>;
  /** Groups of positions whose pairwise correlation exceeds the threshold —
   *  each cluster is effectively ONE bet. */
  correlationClusters: Array<{ tickers: string[]; weightPct: number }>;
  largestClusterWeightPct: number | null;
  portfolioBeta: number | null;
  breaches: string[];
  notes: string[];
}

const pct = (x: number): number => Math.round(x * 100) / 100;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
/** Lower-tail quantile (q in 0..1) by linear interpolation on sorted returns. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const x = a.slice(a.length - n);
  const y = b.slice(b.length - n);
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

export function computePortfolioRisk(input: { positions: PortfolioPosition[]; capitalInr: number; limits?: Partial<RiskLimits> }): PortfolioRisk {
  const limits = { ...DEFAULT_RISK_LIMITS, ...input.limits };
  const positions = input.positions.filter((p) => p.valueInr > 0);
  const capital = input.capitalInr > 0 ? input.capitalInr : positions.reduce((a, p) => a + p.valueInr, 0) || 1;
  const deployed = positions.reduce((a, p) => a + p.valueInr, 0);
  const notes: string[] = [];
  const breaches: string[] = [];

  const base: PortfolioRisk = {
    version: PORTFOLIO_RISK_VERSION,
    capitalInr: capital,
    deployedInr: deployed,
    cashPct: pct(((capital - deployed) / capital) * 100),
    positions: positions.length,
    var95Pct: null,
    var99Pct: null,
    cvar95Pct: null,
    cvar99Pct: null,
    parametricVar95Pct: null,
    annualVolPct: null,
    herfindahl: null,
    effectiveNames: null,
    top5WeightPct: null,
    sectorExposure: [],
    correlationClusters: [],
    largestClusterWeightPct: null,
    portfolioBeta: null,
    breaches,
    notes,
  };
  if (positions.length === 0) {
    notes.push("No open positions — portfolio risk is zero.");
    return base;
  }

  const weight = (p: PortfolioPosition): number => p.valueInr / capital; // of total capital

  // ── Concentration ────────────────────────────────────────────────────────
  const deployedWeights = positions.map((p) => p.valueInr / deployed); // of deployed capital
  const hhi = deployedWeights.reduce((a, w) => a + w * w, 0);
  base.herfindahl = pct(hhi);
  base.effectiveNames = hhi > 0 ? pct(1 / hhi) : null;
  base.top5WeightPct = pct(
    [...positions]
      .sort((a, b) => b.valueInr - a.valueInr)
      .slice(0, 5)
      .reduce((a, p) => a + weight(p) * 100, 0)
  );
  for (const p of positions) {
    if (weight(p) * 100 > limits.maxSingleStockPct) breaches.push(`${p.ticker} is ${pct(weight(p) * 100)}% of capital (cap ${limits.maxSingleStockPct}%)`);
  }

  // ── Sector exposure ───────────────────────────────────────────────────────
  const sectorMap = new Map<string, number>();
  for (const p of positions) {
    const s = p.sector ?? "Unclassified";
    sectorMap.set(s, (sectorMap.get(s) ?? 0) + weight(p) * 100);
  }
  base.sectorExposure = [...sectorMap.entries()]
    .map(([sector, weightPct]) => ({ sector, weightPct: pct(weightPct), breach: weightPct > limits.maxSectorPct }))
    .sort((a, b) => b.weightPct - a.weightPct);
  for (const s of base.sectorExposure) if (s.breach) breaches.push(`sector ${s.sector} is ${s.weightPct}% of capital (cap ${limits.maxSectorPct}%)`);

  // ── Portfolio return series (weighted by deployed weights) ────────────────
  const len = Math.min(...positions.map((p) => p.returns.length));
  if (len >= 20) {
    const port: number[] = [];
    for (let t = 0; t < len; t++) {
      let r = 0;
      for (let i = 0; i < positions.length; i++) r += deployedWeights[i] * positions[i].returns[positions[i].returns.length - len + t];
      port.push(r);
    }
    const sorted = [...port].sort((a, b) => a - b);
    // Historical VaR/CVaR as POSITIVE loss %, scaled to DEPLOYED fraction of capital.
    const deployedFrac = deployed / capital;
    const v95 = -quantile(sorted, 0.05);
    const v99 = -quantile(sorted, 0.01);
    const tail95 = sorted.filter((x) => x <= quantile(sorted, 0.05));
    const tail99 = sorted.filter((x) => x <= quantile(sorted, 0.01));
    base.var95Pct = pct(Math.max(0, v95) * 100 * deployedFrac);
    base.var99Pct = pct(Math.max(0, v99) * 100 * deployedFrac);
    base.cvar95Pct = pct(Math.max(0, -mean(tail95)) * 100 * deployedFrac);
    base.cvar99Pct = pct(Math.max(0, -mean(tail99)) * 100 * deployedFrac);
    const sd = std(port);
    base.annualVolPct = pct(sd * Math.sqrt(252) * 100 * deployedFrac);
    base.parametricVar95Pct = pct(Math.max(0, -(mean(port) - 1.645 * sd)) * 100 * deployedFrac);

    if (base.cvar95Pct != null && base.cvar95Pct > limits.maxPortfolioCvar95Pct)
      breaches.push(`portfolio CVaR95 ${base.cvar95Pct}% exceeds the ${limits.maxPortfolioCvar95Pct}% daily limit`);

    // ── Correlation clusters (union-find on corr > threshold) ──────────────
    const parent = positions.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (i: number, j: number): void => {
      parent[find(i)] = find(j);
    };
    for (let i = 0; i < positions.length; i++)
      for (let j = i + 1; j < positions.length; j++) {
        const c = correlation(positions[i].returns, positions[j].returns);
        if (c != null && c > limits.correlationThreshold) union(i, j);
      }
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < positions.length; i++) {
      const root = find(i);
      const g = clusters.get(root) ?? [];
      g.push(i);
      clusters.set(root, g);
    }
    base.correlationClusters = [...clusters.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({ tickers: g.map((i) => positions[i].ticker), weightPct: pct(g.reduce((a, i) => a + weight(positions[i]) * 100, 0)) }))
      .sort((a, b) => b.weightPct - a.weightPct);
    base.largestClusterWeightPct = base.correlationClusters.length ? base.correlationClusters[0].weightPct : null;
    for (const cl of base.correlationClusters)
      if (cl.weightPct > limits.maxSectorPct)
        breaches.push(`correlated cluster {${cl.tickers.join(", ")}} is ${cl.weightPct}% of capital — effectively one bet above the ${limits.maxSectorPct}% sector cap`);
  } else {
    notes.push(`Only ${len} aligned return observations — VaR/correlation withheld (need ≥ 20).`);
  }

  // ── Portfolio beta ────────────────────────────────────────────────────────
  const withBeta = positions.filter((p) => p.beta != null);
  if (withBeta.length) base.portfolioBeta = pct(withBeta.reduce((a, p) => a + weight(p) * (p.beta as number), 0));

  notes.push("Risk is measured on observed co-movement of the supplied return series — it is not a forecast.");
  return base;
}

/**
 * Would adding `candidate` to the current portfolio breach a hard limit? PURE.
 * Returns ok=false with the exact reasons so the gate can refuse a pick that is
 * fine on its own but dangerous for the book (concentration/sector/correlation).
 */
export function canAddPosition(opts: {
  current: PortfolioPosition[];
  candidate: PortfolioPosition;
  capitalInr: number;
  limits?: Partial<RiskLimits>;
}): { ok: boolean; reasons: string[]; projected: PortfolioRisk } {
  const limits = { ...DEFAULT_RISK_LIMITS, ...opts.limits };
  const projected = computePortfolioRisk({ positions: [...opts.current, opts.candidate], capitalInr: opts.capitalInr, limits });
  const reasons: string[] = [];
  const w = (opts.candidate.valueInr / Math.max(1, opts.capitalInr)) * 100;
  if (w > limits.maxSingleStockPct) reasons.push(`position would be ${pct(w)}% of capital (cap ${limits.maxSingleStockPct}%)`);
  const sector = opts.candidate.sector ?? "Unclassified";
  const sectorRow = projected.sectorExposure.find((s) => s.sector === sector);
  if (sectorRow?.breach) reasons.push(`sector ${sector} would reach ${sectorRow.weightPct}% (cap ${limits.maxSectorPct}%)`);
  if (projected.cvar95Pct != null && projected.cvar95Pct > limits.maxPortfolioCvar95Pct) reasons.push(`portfolio CVaR95 would be ${projected.cvar95Pct}% (cap ${limits.maxPortfolioCvar95Pct}%)`);
  const inCluster = projected.correlationClusters.find((c) => c.tickers.includes(opts.candidate.ticker) && c.weightPct > limits.maxSectorPct);
  if (inCluster) reasons.push(`joins a correlated cluster at ${inCluster.weightPct}% of capital — effectively one bet`);
  return { ok: reasons.length === 0, reasons, projected };
}
