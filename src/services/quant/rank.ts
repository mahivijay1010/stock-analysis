/**
 * V8 R1 + V10 B1 — RankEngine pure math. PURE (no DB, no HTTP).
 *
 * Cross-sectional composite over the universe:
 *   composite = z(momentum60d)·0.5 + z(quality)·0.3 + z(sentimentDecay)·0.2
 * Z-scores are computed cross-sectionally (mean/σ over the tickers that HAVE
 * the component, σ floored at 1e-9), clamped to ±3; a missing component
 * contributes z = 0 (sector/cross-section neutral) and is flagged 'no-data'.
 *
 * V10 B1 quality pillar: when a ticker has a STORED-intelligence quality
 * score (0-100 from NSE-filing metrics), it feeds the quality z; otherwise
 * the V8 quoteSummary fallback (ROE %, else operating margin %) applies.
 * Every row's componentStatus.quality states its source honestly:
 * 'intelligence (n inputs)' | 'quoteSummary fallback' | 'no-data'.
 */

export const RANK_WEIGHTS = { momentum: 0.5, quality: 0.3, sentiment: 0.2 } as const;
export const Z_CLAMP = 3;
export const SIGMA_FLOOR = 1e-9;

export type ComponentStatus = 'ok' | 'no-data';

export interface RankInputRow {
  ticker: string;
  /** 60-trading-day simple return, fraction (0.12 = +12%). Null = no data. */
  momentum60d: number | null;
  /** Fallback quality metric %, ROE preferred, operating margin second. */
  quality: number | null;
  /** Which fallback metric `quality` actually is (honest labeling). */
  qualitySource: 'roe' | 'operating-margin' | null;
  /**
   * V10 B1 — stored-intelligence quality score (0-100) + the sub-signals it
   * used. When present it REPLACES `quality` in the pillar.
   */
  intelligenceQuality?: { score: number; coverage: string[] } | null;
  /** Decay-weighted news sentiment score (−100..100) from a CACHED summary. */
  sentimentDecay: number | null;
}

export interface RankedRow {
  ticker: string;
  composite: number;
  percentile: number; // 0..100, higher composite ⇒ higher percentile
  components: { momentum: number; quality: number; sentiment: number }; // clamped z's
  componentStatus: {
    momentum: ComponentStatus;
    /** 'intelligence (n inputs)' | 'quoteSummary fallback' | 'no-data'. */
    quality: string;
    sentiment: ComponentStatus;
  };
  qualitySource: 'intelligence' | 'roe' | 'operating-margin' | null;
}

/**
 * Z-scores across the non-null values (mean/σ with σ floor), clamped ±3.
 * Null inputs → z = 0. When fewer than 2 real values exist, every z is 0
 * (a cross-section of one has no dispersion to standardize against).
 */
export function crossSectionZ(values: Array<number | null>): number[] {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length < 2) return values.map(() => 0);
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  const variance =
    present.reduce((a, b) => a + (b - mean) * (b - mean), 0) / present.length;
  const sigma = Math.max(Math.sqrt(variance), SIGMA_FLOOR);
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return 0;
    const z = (v - mean) / sigma;
    return Math.min(Z_CLAMP, Math.max(-Z_CLAMP, z));
  });
}

/** 60-trading-day simple return from a chronological close series. */
export function momentum60d(closes: number[]): number | null {
  if (closes.length < 61) return null;
  const past = closes[closes.length - 61];
  const last = closes[closes.length - 1];
  if (!(past > 0) || !Number.isFinite(last)) return null;
  return last / past - 1;
}

/**
 * Rank the universe. Percentile is assigned from the composite's ascending
 * order (0 = weakest, 100 = strongest); ties share the same percentile so
 * percentile is monotonic in composite.
 */
export function rankUniverse(rows: RankInputRow[]): RankedRow[] {
  // V10 B1 — effective quality: intelligence score when stored, else fallback.
  const qualityValues = rows.map((r) =>
    r.intelligenceQuality != null && Number.isFinite(r.intelligenceQuality.score)
      ? r.intelligenceQuality.score
      : r.quality
  );
  const zMom = crossSectionZ(rows.map((r) => r.momentum60d));
  const zQual = crossSectionZ(qualityValues);
  const zSent = crossSectionZ(rows.map((r) => r.sentimentDecay));

  const composites = rows.map(
    (_, i) =>
      zMom[i] * RANK_WEIGHTS.momentum +
      zQual[i] * RANK_WEIGHTS.quality +
      zSent[i] * RANK_WEIGHTS.sentiment
  );

  // Percentile: fraction of OTHER tickers with a strictly smaller composite
  // (ties share the value). n=1 degenerates to 50.
  const sorted = composites.slice().sort((a, b) => a - b);
  const n = rows.length;
  const pctOf = (c: number): number => {
    if (n <= 1) return 50;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < c) lo = mid + 1;
      else hi = mid;
    }
    return (lo / (n - 1)) * 100;
  };

  return rows.map((r, i) => {
    const usesIntelligence =
      r.intelligenceQuality != null && Number.isFinite(r.intelligenceQuality.score);
    const qualityStatus = usesIntelligence
      ? `intelligence (${r.intelligenceQuality!.coverage.length} inputs)`
      : qualityValues[i] !== null && Number.isFinite(qualityValues[i] as number)
        ? 'quoteSummary fallback'
        : 'no-data';
    return {
      ticker: r.ticker,
      composite: Number(composites[i].toFixed(4)),
      percentile: Number(pctOf(composites[i]).toFixed(1)),
      components: {
        momentum: Number(zMom[i].toFixed(3)),
        quality: Number(zQual[i].toFixed(3)),
        sentiment: Number(zSent[i].toFixed(3)),
      },
      componentStatus: {
        momentum:
          r.momentum60d !== null && Number.isFinite(r.momentum60d)
            ? ('ok' as const)
            : ('no-data' as const),
        quality: qualityStatus,
        sentiment:
          r.sentimentDecay !== null && Number.isFinite(r.sentimentDecay)
            ? ('ok' as const)
            : ('no-data' as const),
      },
      qualitySource: usesIntelligence ? ('intelligence' as const) : r.qualitySource,
    };
  });
}

// ── IC (information coefficient) ─────────────────────────────────────────────

/** Average ranks with ties sharing the mean rank (standard Spearman handling). */
function tiedRanks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation of two equal-length arrays; null on zero variance. */
function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3 || b.length !== n) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  if (va <= 0 || vb <= 0) return null;
  return cov / Math.sqrt(va * vb);
}

/** Spearman rank correlation (tie-aware); null when undefined. */
export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  return pearson(tiedRanks(a), tiedRanks(b));
}

export interface IcDaySample {
  date: string;
  /** Parallel arrays: composite at `date` and the realized forward return. */
  composites: number[];
  forwardReturns: number[];
}

export interface RankIc {
  /** Mean daily Spearman IC across the mature snapshot days. */
  value: number;
  /** Number of snapshot days that contributed. */
  samples: number;
}

/**
 * Measured rank IC: for each snapshot day, Spearman(composite, forward 30d
 * return) across the universe; the IC is the mean of those daily
 * correlations. Days with <10 tickers or undefined correlation are skipped.
 * Returns null when no day qualifies — the caller enforces the ≥20-day gate.
 */
export function computeRankIC(days: IcDaySample[]): RankIc | null {
  const dailyIcs: number[] = [];
  for (const d of days) {
    if (d.composites.length < 10 || d.composites.length !== d.forwardReturns.length) {
      continue;
    }
    const ic = spearman(d.composites, d.forwardReturns);
    if (ic !== null && Number.isFinite(ic)) dailyIcs.push(ic);
  }
  if (dailyIcs.length === 0) return null;
  const value = dailyIcs.reduce((a, b) => a + b, 0) / dailyIcs.length;
  return { value: Number(value.toFixed(4)), samples: dailyIcs.length };
}
