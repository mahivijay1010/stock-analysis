/**
 * Portfolio context (autonomous directive, Part O) — a good stock can be a bad
 * portfolio ADDITION. PURE: given a candidate's return series and the open
 * positions' series, compute beta, pairwise correlation, sector concentration
 * after adding, marginal volatility contribution and a deterministic ranking
 * penalty. Used by the short-term scan whenever open positions exist.
 */

export interface PortfolioContextResult {
  betaVsNifty: number | null;
  maxPairwiseCorrelation: number | null;
  mostCorrelatedTicker: string | null;
  sectorCountAfterAdd: number;
  sectorConcentrationPct: number; // capital share of the candidate's sector after adding
  marginalVolContributionPct: number | null; // Δ portfolio σ (equal-weight proxy), %
  rankingPenalty: number; // 0..15 subtracted from rankingScore
  notes: string[];
}

function corr(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 30) return null;
  const xa = a.slice(-n);
  const xb = b.slice(-n);
  const ma = xa.reduce((s, x) => s + x, 0) / n;
  const mb = xb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (xa[i] - ma) * (xb[i] - mb);
    da += (xa[i] - ma) ** 2;
    db += (xb[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

function vol(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

export function assessPortfolioContext(opts: {
  candidateTicker: string;
  candidateSector: string;
  candidateReturns: number[]; // recent daily returns (≤120)
  candidateBeta60: number | null;
  openPositions: Array<{ ticker: string; sector: string; capitalInr: number; returns: number[] }>;
  candidateCapitalInr: number;
}): PortfolioContextResult {
  const notes: string[] = [];
  let maxCorr: number | null = null;
  let maxTicker: string | null = null;
  for (const p of opts.openPositions) {
    const c = corr(opts.candidateReturns, p.returns);
    if (c != null && (maxCorr == null || c > maxCorr)) {
      maxCorr = c;
      maxTicker = p.ticker;
    }
  }

  const totalCapital = opts.openPositions.reduce((a, p) => a + p.capitalInr, 0) + opts.candidateCapitalInr;
  const sectorCapital =
    opts.openPositions.filter((p) => p.sector === opts.candidateSector).reduce((a, p) => a + p.capitalInr, 0) +
    opts.candidateCapitalInr;
  const sectorConcentrationPct = totalCapital > 0 ? (sectorCapital / totalCapital) * 100 : 0;
  const sectorCountAfterAdd = opts.openPositions.filter((p) => p.sector === opts.candidateSector).length + 1;

  // Marginal vol contribution: equal-weight portfolio σ with vs without the candidate.
  let marginal: number | null = null;
  if (opts.openPositions.length > 0 && opts.candidateReturns.length >= 30) {
    const n = Math.min(60, opts.candidateReturns.length, ...opts.openPositions.map((p) => p.returns.length));
    if (n >= 30) {
      const series = opts.openPositions.map((p) => p.returns.slice(-n));
      const port: number[] = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + s[i], 0) / series.length);
      const withCand: number[] = Array.from({ length: n }, (_, i) => (port[i] * series.length + opts.candidateReturns.slice(-n)[i]) / (series.length + 1));
      marginal = (vol(withCand) - vol(port)) * Math.sqrt(252) * 100;
    }
  }

  let penalty = 0;
  if (maxCorr != null && maxCorr > 0.75) {
    penalty += 8;
    notes.push(`highly correlated (ρ=${maxCorr.toFixed(2)}) with open position ${maxTicker} — adds little diversification`);
  } else if (maxCorr != null && maxCorr > 0.6) {
    penalty += 4;
    notes.push(`correlated (ρ=${maxCorr.toFixed(2)}) with ${maxTicker}`);
  }
  if (sectorConcentrationPct > 50) {
    penalty += 5;
    notes.push(`sector concentration would reach ${sectorConcentrationPct.toFixed(0)}% (${sectorCountAfterAdd} positions in ${opts.candidateSector})`);
  }
  if (marginal != null && marginal > 2) {
    penalty += 2;
    notes.push(`adds ${marginal.toFixed(1)}pp annualized portfolio volatility`);
  }
  if (notes.length === 0) notes.push("no adverse portfolio interaction detected");

  return {
    betaVsNifty: opts.candidateBeta60,
    maxPairwiseCorrelation: maxCorr != null ? Math.round(maxCorr * 100) / 100 : null,
    mostCorrelatedTicker: maxTicker,
    sectorCountAfterAdd,
    sectorConcentrationPct: Math.round(sectorConcentrationPct * 10) / 10,
    marginalVolContributionPct: marginal != null ? Math.round(marginal * 100) / 100 : null,
    rankingPenalty: Math.min(15, penalty),
    notes,
  };
}
