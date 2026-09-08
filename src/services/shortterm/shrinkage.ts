/**
 * Empirical-Bayes / hierarchical shrinkage (Part 7) + multiple-testing (Part 8).
 *
 * Short-term setup cells are sparse: a stock with 5 examples must NOT show an
 * extreme rate. We shrink a cell's estimate toward its parent (sector→global)
 * by a weight that grows with the cell's own sample size, so tiny cells inherit
 * the pooled prior and large cells keep their own signal. Only the SHRUNK
 * estimate may enter the decision system.
 */

export interface ShrinkageResult {
  rawEstimate: number;
  priorEstimate: number;
  shrunkEstimate: number;
  effectiveSample: number;
  shrinkageWeight: number; // weight ON the raw estimate (0 = all prior, 1 = all raw)
}

/**
 * James–Stein-style shrinkage toward a prior. `k` is the prior strength in
 * pseudo-observations (a cell needs ~k of its own samples to earn half weight).
 */
export function shrinkToward(rawEstimate: number, sampleSize: number, priorEstimate: number, k = 25): ShrinkageResult {
  const n = Math.max(0, sampleSize);
  const w = n / (n + k);
  return {
    rawEstimate: Number.isFinite(rawEstimate) ? rawEstimate : priorEstimate,
    priorEstimate,
    shrunkEstimate: Number.isFinite(rawEstimate) ? w * rawEstimate + (1 - w) * priorEstimate : priorEstimate,
    effectiveSample: n,
    shrinkageWeight: Math.round(w * 1000) / 1000,
  };
}

/**
 * Hierarchical shrinkage across stock → sector → global with which level
 * actually supplied the usable estimate recorded.
 */
export function hierarchicalShrink(opts: {
  stock: { estimate: number; n: number } | null;
  sector: { estimate: number; n: number } | null;
  global: { estimate: number; n: number };
  minCellN: number; // below this a level cannot be a standalone source
  k?: number;
}): ShrinkageResult & { level: "stock" | "sector" | "global" } {
  const k = opts.k ?? 25;
  const globalEst = opts.global.estimate;
  const sectorPrior = opts.sector && opts.sector.n >= opts.minCellN ? shrinkToward(opts.sector.estimate, opts.sector.n, globalEst, k).shrunkEstimate : globalEst;
  if (opts.stock && opts.stock.n >= opts.minCellN) {
    const r = shrinkToward(opts.stock.estimate, opts.stock.n, sectorPrior, k);
    return { ...r, level: "stock" };
  }
  if (opts.sector && opts.sector.n >= opts.minCellN) {
    const r = shrinkToward(opts.sector.estimate, opts.sector.n, globalEst, k);
    return { ...r, level: "sector" };
  }
  return {
    rawEstimate: globalEst,
    priorEstimate: globalEst,
    shrunkEstimate: globalEst,
    effectiveSample: opts.global.n,
    shrinkageWeight: 1,
    level: "global",
  };
}

// ── Multiple testing (Part 8) ────────────────────────────────────────────────

/**
 * Benjamini–Hochberg FDR. Returns, per input p-value, whether it is
 * significant at the given FDR q AND the adjusted (BH) p-value. We test MANY
 * setup×horizon×regime cells, so an uncorrected p-value is not evidence.
 */
export function benjaminiHochberg(pValues: number[], q = 0.1): Array<{ pValue: number; adjusted: number; significant: boolean }> {
  const m = pValues.length;
  if (m === 0) return [];
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  // adjusted p from largest rank down (monotone)
  const adj = new Array(m).fill(1);
  let prev = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p } = indexed[rank - 1];
    const a = Math.min(prev, (p * m) / rank);
    adj[rank - 1] = a;
    prev = a;
  }
  // largest rank with p <= (rank/m)*q is the threshold
  let maxSig = 0;
  for (let rank = 1; rank <= m; rank++) if (indexed[rank - 1].p <= (rank / m) * q) maxSig = rank;
  const out = new Array(m).fill(null).map(() => ({ pValue: 0, adjusted: 1, significant: false }));
  for (let rank = 1; rank <= m; rank++) {
    const { p, i } = indexed[rank - 1];
    out[i] = { pValue: p, adjusted: Math.round(adj[rank - 1] * 10000) / 10000, significant: rank <= maxSig };
  }
  return out;
}

/** One-sided bootstrap p-value that a mean is ≤ 0 (evidence it is > 0). */
export function bootstrapPValueMeanPositive(samples: number[], iterations = 2000, seedFn: () => number): number {
  if (samples.length < 5) return 1;
  const n = samples.length;
  let ge0 = 0;
  const observedMean = samples.reduce((a, b) => a + b, 0) / n;
  if (observedMean <= 0) return 1;
  // Center the samples (H0: mean = 0) and count resample-means ≥ observed.
  const centered = samples.map((x) => x - observedMean);
  for (let b = 0; b < iterations; b++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += centered[Math.floor(seedFn() * n)];
    if (s / n >= observedMean) ge0++;
  }
  return (ge0 + 1) / (iterations + 1);
}
