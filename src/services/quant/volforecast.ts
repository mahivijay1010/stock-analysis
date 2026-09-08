/**
 * V8 R2 + V10 B2 — VolatilityForecaster: HAR-RV on DAILY data, optionally
 * extended with an exogenous India-VIX regressor (HAR-X). PURE (no DB/HTTP).
 *
 * HONEST CAVEAT (stated in every response note): true HAR-RV (Corsi 2009) uses
 * INTRADAY realized volatility; here RV_t = r_t² (squared daily close-to-close
 * return) is a much noisier proxy, so R² is expected to be well below the
 * intraday-RV literature. We report the measured in-sample AND walk-forward
 * out-of-sample R² — never a promised number.
 *
 * Plain HAR:  RV_{t+1} = β0 + β1·RV_t + β2·mean(RV_{t-4..t}) + β3·mean(RV_{t-21..t})
 * HAR-X (V10): the same three lags PLUS the PREVIOUS-DAY ^INDIAVIX level,
 * z-scored over the fit window. Both models are fit per ticker, both
 * walk-forward out-of-sample R²s are measured ON THE SAME DAYS, and the
 * forecast uses whichever wins out-of-sample (`method` says which,
 * `vixDeltaR2` = HAR-X OOS R² − plain HAR OOS R²).
 *
 * OLS via normal equations, Gaussian elimination with partial pivoting,
 * singularity guarded, on the last ~250 observations.
 */

import { Bar } from './types';
import { dailyReturns } from './indicators';

export const TRADING_DAYS_PER_YEAR = 252;
const FIT_WINDOW = 250; // ~1 trading year of RV observations
const OOS_DAYS = 60; // walk-forward out-of-sample window
const MIN_FIT_OBS = 60; // fewer than this → no fit (honest null)
const LAG_22 = 22;
const LAG_5 = 5;
const PIVOT_EPS = 1e-300; // singularity guard for tiny RV magnitudes (~1e-8)

export interface HarFit {
  beta: [number, number, number, number]; // [β0, β1_daily, β2_weekly, β3_monthly]
  r2InSample: number;
  nObs: number;
}

/** V10 B2 — HAR-X fit: HAR lags + z-scored previous-day India VIX level. */
export interface HarXFit {
  beta: [number, number, number, number, number]; // [β0, β1_d, β2_w, β3_m, β4_vixZ]
  r2InSample: number;
  nObs: number;
  /** z-scoring parameters measured over the fit window (applied at predict time). */
  exogMean: number;
  exogSd: number;
}

/** One exogenous-series point (e.g. an ^INDIAVIX daily close). */
export interface VixPoint {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface VolForecastResult {
  /** Annualized vol %, from the 1-step-ahead RV forecast. Null when unfittable. */
  forecast1dVolPct: number | null;
  /** Annualized vol %, from the mean of the 5 iterated RV forecasts. */
  forecast5dVolPct: number | null;
  /** 22d realized vol, annualized % (sqrt(mean RV over last 22 obs × 252)). */
  historicalAvgVolPct: number | null;
  /** Median of the trailing 1y rolling 22d realized vol series, annualized %. */
  medianVol1yPct: number | null;
  regime: 'elevated' | 'normal' | 'calm' | null;
  /** Present only when regime is 'elevated'. */
  sizingHint: string | null;
  r2InSample: number | null;
  /** Walk-forward OOS R² of the CHOSEN model (fit strictly before each day). */
  r2OutOfSample: number | null;
  oosSamples: number;
  /** Chosen model's coefficients (4 for HAR, 5 for HAR-X). */
  betas: number[] | null;
  /** V10 B2 — the model the forecast USES: 'HAR-X' | 'HAR' (OOS winner). */
  method: string;
  /** The full formula/measurement description (was `method` before V10). */
  methodology: string;
  /** V10 B2 — plain-HAR walk-forward OOS R² (same days as HAR-X when both fit). */
  r2OutOfSampleHar: number | null;
  /** V10 B2 — HAR-X walk-forward OOS R² (null when VIX missing/unfittable). */
  r2OutOfSampleHarX: number | null;
  /** V10 B2 — HAR-X OOS R² − plain HAR OOS R² (what the VIX regressor added). */
  vixDeltaR2: number | null;
  note: string;
}

/** Squared daily returns — the daily RV proxy series. */
export function dailyRvSeries(closes: number[]): number[] {
  return dailyReturns(closes).map((r) => r * r);
}

/**
 * OLS via normal equations: solve (XᵀX)β = Xᵀy with Gaussian elimination and
 * partial pivoting. Returns null when the system is singular (e.g. a flat
 * series where every RV is 0 makes all columns collinear with the intercept).
 */
export function olsFit(X: number[][], y: number[]): number[] | null {
  const n = X.length;
  if (n === 0 || n < X[0].length) return null;
  const k = X[0].length;

  // XtX (k×k) and Xty (k)
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let i = 0; i < n; i++) {
    const row = X[i];
    for (let a = 0; a < k; a++) {
      for (let b = a; b < k; b++) A[a][b] += row[a] * row[b];
      A[a][k] += row[a] * y[i];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];

  // Gaussian elimination with partial pivoting on the augmented matrix.
  for (let col = 0; col < k; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivotRow][col])) pivotRow = r;
    }
    if (!Number.isFinite(A[pivotRow][col]) || Math.abs(A[pivotRow][col]) < PIVOT_EPS) {
      return null; // singular / degenerate — caller degrades honestly
    }
    if (pivotRow !== col) {
      const tmp = A[col];
      A[col] = A[pivotRow];
      A[pivotRow] = tmp;
    }
    for (let r = col + 1; r < k; r++) {
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
    }
  }
  const beta = new Array<number>(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = A[r][k];
    for (let c = r + 1; c < k; c++) s -= A[r][c] * beta[c];
    beta[r] = s / A[r][r];
  }
  return beta.every((b) => Number.isFinite(b)) ? beta : null;
}

/** mean of xs[i-w+1..i] inclusive (caller guarantees i ≥ w-1). */
function trailingMean(xs: number[], i: number, w: number): number {
  let s = 0;
  for (let j = i - w + 1; j <= i; j++) s += xs[j];
  return s / w;
}

/**
 * Build HAR design rows for targets t in [start, end): predict rv[t] from
 * rv[t-1], mean(rv[t-5..t-1]), mean(rv[t-22..t-1]). Requires t ≥ 22.
 */
function harRows(
  rv: number[],
  start: number,
  end: number
): { X: number[][]; y: number[] } {
  const X: number[][] = [];
  const y: number[] = [];
  for (let t = Math.max(start, LAG_22); t < end; t++) {
    X.push([
      1,
      rv[t - 1],
      trailingMean(rv, t - 1, LAG_5),
      trailingMean(rv, t - 1, LAG_22),
    ]);
    y.push(rv[t]);
  }
  return { X, y };
}

function rSquared(actual: number[], predicted: number[]): number | null {
  if (actual.length < 2 || actual.length !== predicted.length) return null;
  const mean = actual.reduce((a, b) => a + b, 0) / actual.length;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < actual.length; i++) {
    ssTot += (actual[i] - mean) ** 2;
    ssRes += (actual[i] - predicted[i]) ** 2;
  }
  if (!(ssTot > 0)) return null; // zero-variance target — R² undefined
  return 1 - ssRes / ssTot;
}

/** Fit HAR-RV on the LAST `window` usable observations of the rv series. */
export function fitHar(rv: number[], window = FIT_WINDOW): HarFit | null {
  const end = rv.length;
  const start = Math.max(LAG_22, end - window);
  const { X, y } = harRows(rv, start, end);
  if (y.length < MIN_FIT_OBS) return null;
  const beta = olsFit(X, y);
  if (!beta) return null;
  const predicted = X.map(
    (row) => beta[0] + beta[1] * row[1] + beta[2] * row[2] + beta[3] * row[3]
  );
  const r2 = rSquared(y, predicted);
  if (r2 === null) return null;
  return {
    beta: [beta[0], beta[1], beta[2], beta[3]],
    r2InSample: r2,
    nObs: y.length,
  };
}

/** One-step HAR prediction from the tail of an rv series (never negative). */
function predictNext(rv: number[], beta: HarFit['beta']): number {
  const i = rv.length - 1;
  const pred =
    beta[0] +
    beta[1] * rv[i] +
    beta[2] * trailingMean(rv, i, LAG_5) +
    beta[3] * trailingMean(rv, i, LAG_22);
  return Math.max(0, pred); // RV is a variance — clamp tiny negative OLS output
}

/**
 * Walk-forward out-of-sample R² over the last ≤`oosDays` observations: for
 * each target t the model is fit ONLY on observations before t (no
 * lookahead), then predicts rv[t]. Out-of-sample R² follows the standard
 * (Campbell–Thompson style) convention:
 *
 *   R²_oos = 1 − Σ(rv_t − harPred_t)² / Σ(rv_t − trainMean_t)²
 *
 * where trainMean_t is the mean RV of the SAME training window the HAR was
 * fit on — i.e. the honest null forecast ("tomorrow's variance = the recent
 * average") available at forecast time. Benchmarking against the mean of the
 * future OOS window itself would leak the future into the benchmark.
 * Null when fewer than 20 pairs could be formed or the benchmark SSE is 0.
 */
export function walkForwardOosR2(
  rv: number[],
  oosDays = OOS_DAYS,
  window = FIT_WINDOW
): { r2: number | null; samples: number } {
  const n = rv.length;
  const firstTarget = Math.max(LAG_22 + MIN_FIT_OBS, n - oosDays);
  let sseModel = 0;
  let sseBench = 0;
  let samples = 0;
  for (let t = firstTarget; t < n; t++) {
    const history = rv.slice(0, t);
    const fit = fitHar(history, window);
    if (!fit) continue;
    const pred = predictNext(history, fit.beta);
    const trainStart = Math.max(0, t - window);
    const train = history.slice(trainStart);
    const trainMean = train.reduce((a, b) => a + b, 0) / train.length;
    sseModel += (rv[t] - pred) ** 2;
    sseBench += (rv[t] - trainMean) ** 2;
    samples++;
  }
  if (samples < 20 || !(sseBench > 0)) return { r2: null, samples };
  return { r2: 1 - sseModel / sseBench, samples };
}

// ── V10 B2: HAR-X (exogenous previous-day India VIX) ─────────────────────────

/** Max calendar-day gap tolerated when aligning a VIX close to a bar date. */
const VIX_MAX_STALE_DAYS = 7;

/** Calendar days between two YYYY-MM-DD strings (b − a). */
function calendarDaysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * Align a VIX close series to bar dates. Returns one value PER BAR:
 * out[i] = the latest VIX close on-or-before barDates[i] (null when none
 * exists within `maxStaleDays`).
 *
 * Index convention (no lookahead): rv[t] is realized on barDates[t+1], so the
 * PREVIOUS-DAY VIX for target rv[t] is out[t] — the VIX close of the last bar
 * BEFORE the target day. The final 1-step-ahead forecast (predicting rv[n])
 * uses out[n], the VIX aligned to the newest bar.
 */
export function alignVixToRv(
  barDates: string[],
  vix: VixPoint[],
  maxStaleDays = VIX_MAX_STALE_DAYS
): Array<number | null> {
  const pts = vix
    .filter((p) => Number.isFinite(p.close) && p.close > 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: Array<number | null> = new Array(barDates.length).fill(null);
  let j = -1; // index of the latest VIX point with date ≤ current bar date
  for (let i = 0; i < barDates.length; i++) {
    while (j + 1 < pts.length && pts[j + 1].date <= barDates[i]) j++;
    if (j >= 0 && calendarDaysBetween(pts[j].date, barDates[i]) <= maxStaleDays) {
      out[i] = pts[j].close;
    }
  }
  return out;
}

/**
 * HAR-X design rows for targets t in [start, end): the three HAR lag features
 * plus the RAW previous-day VIX level exog[t]. Targets whose exog is missing
 * are skipped (the z-scoring is applied by fitHarX over the kept rows).
 */
function harXRows(
  rv: number[],
  exog: Array<number | null>,
  start: number,
  end: number
): { X: number[][]; y: number[] } {
  const X: number[][] = [];
  const y: number[] = [];
  for (let t = Math.max(start, LAG_22); t < end; t++) {
    const x = exog[t];
    if (x === null || !Number.isFinite(x)) continue;
    X.push([1, rv[t - 1], trailingMean(rv, t - 1, LAG_5), trailingMean(rv, t - 1, LAG_22), x]);
    y.push(rv[t]);
  }
  return { X, y };
}

/**
 * Fit HAR-X on the LAST `window` usable observations. The VIX column is
 * z-scored over the fit rows (mean/σ measured on the SAME window the OLS
 * sees — the z parameters travel with the fit for prediction, so walk-forward
 * use never leaks future VIX statistics). Null when the design is too small,
 * the VIX column is constant, or the system is singular.
 */
export function fitHarX(
  rv: number[],
  exog: Array<number | null>,
  window = FIT_WINDOW
): HarXFit | null {
  const end = rv.length;
  const start = Math.max(LAG_22, end - window);
  const { X, y } = harXRows(rv, exog, start, end);
  if (y.length < MIN_FIT_OBS) return null;

  const exogVals = X.map((r) => r[4]);
  const mean = exogVals.reduce((a, b) => a + b, 0) / exogVals.length;
  const variance =
    exogVals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / exogVals.length;
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null; // constant VIX over the window — nothing to fit
  for (const row of X) row[4] = (row[4] - mean) / sd;

  const beta = olsFit(X, y);
  if (!beta) return null;
  const predicted = X.map(
    (row) => beta[0] + beta[1] * row[1] + beta[2] * row[2] + beta[3] * row[3] + beta[4] * row[4]
  );
  const r2 = rSquared(y, predicted);
  if (r2 === null) return null;
  return {
    beta: [beta[0], beta[1], beta[2], beta[3], beta[4]],
    r2InSample: r2,
    nObs: y.length,
    exogMean: mean,
    exogSd: sd,
  };
}

/** One-step HAR-X prediction from the rv tail + a z-scored VIX (never negative). */
function predictNextX(rv: number[], vixZ: number, fit: HarXFit): number {
  const i = rv.length - 1;
  const pred =
    fit.beta[0] +
    fit.beta[1] * rv[i] +
    fit.beta[2] * trailingMean(rv, i, LAG_5) +
    fit.beta[3] * trailingMean(rv, i, LAG_22) +
    fit.beta[4] * vixZ;
  return Math.max(0, pred);
}

/**
 * Walk-forward OOS comparison of plain HAR vs HAR-X ON THE SAME DAYS: a day
 * contributes only when BOTH models could be fit strictly on data before it
 * AND the previous-day VIX for that target exists — otherwise the two R²s
 * would be measured on different samples and the comparison would be unfair.
 * Benchmark per day: the training-window mean RV (same as walkForwardOosR2).
 */
export function walkForwardOosR2Pair(
  rv: number[],
  exog: Array<number | null>,
  oosDays = OOS_DAYS,
  window = FIT_WINDOW
): { har: number | null; harx: number | null; samples: number } {
  const n = rv.length;
  const firstTarget = Math.max(LAG_22 + MIN_FIT_OBS, n - oosDays);
  let sseHar = 0;
  let sseHarX = 0;
  let sseBench = 0;
  let samples = 0;
  for (let t = firstTarget; t < n; t++) {
    const x = exog[t];
    if (x === null || !Number.isFinite(x)) continue;
    const history = rv.slice(0, t);
    const fitH = fitHar(history, window);
    if (!fitH) continue;
    const fitX = fitHarX(history, exog, window); // uses only exog[τ], τ < t
    if (!fitX) continue;
    const predH = predictNext(history, fitH.beta);
    const predX = predictNextX(history, (x - fitX.exogMean) / fitX.exogSd, fitX);
    const trainStart = Math.max(0, t - window);
    const train = history.slice(trainStart);
    const trainMean = train.reduce((a, b) => a + b, 0) / train.length;
    sseHar += (rv[t] - predH) ** 2;
    sseHarX += (rv[t] - predX) ** 2;
    sseBench += (rv[t] - trainMean) ** 2;
    samples++;
  }
  if (samples < 20 || !(sseBench > 0)) return { har: null, harx: null, samples };
  return { har: 1 - sseHar / sseBench, harx: 1 - sseHarX / sseBench, samples };
}

/** annualized vol % from a mean daily RV (variance). */
function annualizedVolPct(meanDailyRv: number): number {
  return Math.sqrt(Math.max(0, meanDailyRv) * TRADING_DAYS_PER_YEAR) * 100;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * Full HAR-RV forecast from daily bars (chronological). Pure. Degrades to
 * nulls (with the reason in `note`) instead of throwing or fabricating.
 *
 * V10 B2: pass `vix` (daily ^INDIAVIX closes) to ALSO fit HAR-X — plain HAR
 * plus the z-scored previous-day VIX level. Both walk-forward OOS R²s are
 * measured on the same days and the forecast uses whichever wins; `method`
 * names the winner and `vixDeltaR2` states exactly what the VIX added.
 */
export function forecastVolatility(bars: Bar[], vix?: VixPoint[]): VolForecastResult {
  const methodology =
    'HAR-RV (Corsi) on a DAILY proxy: RV_t = r_t²; OLS of RV_next on RV 1d / 5d-avg / 22d-avg, ' +
    `fit on the last ≤${FIT_WINDOW} observations; out-of-sample R² is walk-forward over the last ` +
    `≤${OOS_DAYS} days (fit strictly on data before each day). HAR-X adds one exogenous regressor: ` +
    'the previous-day ^INDIAVIX close, z-scored over the fit window; both models are fit and the ' +
    'forecast uses the walk-forward out-of-sample winner.';
  const caveat =
    'Caveat: true HAR-RV uses intraday realized volatility; this daily-return proxy is much noisier, ' +
    'so these R² values are expected to be modest — they are measured, not promised.';

  // Phase 1: realized vol from the adjusted series (CA-safe).
  const closes = bars.map((b) =>
    b.adjustedClose != null && Number.isFinite(b.adjustedClose) && b.adjustedClose > 0
      ? b.adjustedClose
      : b.close
  );
  const rv = dailyRvSeries(closes);

  const empty: VolForecastResult = {
    forecast1dVolPct: null,
    forecast5dVolPct: null,
    historicalAvgVolPct: null,
    medianVol1yPct: null,
    regime: null,
    sizingHint: null,
    r2InSample: null,
    r2OutOfSample: null,
    oosSamples: 0,
    betas: null,
    method: 'HAR',
    methodology,
    r2OutOfSampleHar: null,
    r2OutOfSampleHarX: null,
    vixDeltaR2: null,
    note: '',
  };

  if (rv.length < LAG_22 + MIN_FIT_OBS) {
    return {
      ...empty,
      note:
        `Not enough return history to fit HAR-RV (${rv.length} daily RV observations, ` +
        `need ≥ ${LAG_22 + MIN_FIT_OBS}). ${caveat}`,
    };
  }

  // 22d realized (annualized %) — reported even when the OLS cannot fit.
  const historicalAvgVolPct =
    rv.length >= LAG_22 ? round2(annualizedVolPct(trailingMean(rv, rv.length - 1, LAG_22))) : null;

  const fit = fitHar(rv);
  if (!fit) {
    return {
      ...empty,
      historicalAvgVolPct,
      note:
        'HAR-RV OLS could not be fit (singular/degenerate design — e.g. a flat or near-flat price series ' +
        `has zero return variance). No volatility forecast is fabricated. ${caveat}`,
    };
  }

  // ── V10 B2: HAR-X candidate (previous-day India VIX, z-scored) ────────────
  // exog[i] = VIX close on-or-before bar i's date; target rv[t] uses exog[t]
  // (the close BEFORE the target day) and the 1-step forecast uses the last.
  let vixStatus = 'HAR-X not fit: no India VIX series supplied.';
  let fitX: HarXFit | null = null;
  let pair: { har: number | null; harx: number | null; samples: number } | null = null;
  let exogNext: number | null = null;
  if (vix && vix.length > 0) {
    const exog = alignVixToRv(bars.map((b) => b.date), vix);
    exogNext = exog[exog.length - 1];
    fitX = fitHarX(rv, exog);
    if (!fitX) {
      vixStatus =
        'HAR-X could not be fit (too few VIX-aligned observations in the window, or a ' +
        'constant/degenerate VIX column) — plain HAR used.';
    } else if (exogNext === null) {
      vixStatus =
        'HAR-X fit, but no VIX close aligns with the latest bar — the forecast cannot use it; plain HAR used.';
      fitX = null;
    } else {
      pair = walkForwardOosR2Pair(rv, exog);
      vixStatus =
        pair.har === null
          ? `HAR-X fit, but fewer than 20 comparable walk-forward days (${pair.samples}) — ` +
            'no fair out-of-sample comparison possible; plain HAR used.'
          : '';
    }
  }

  // Chosen model: HAR-X only when it BEAT plain HAR out-of-sample.
  const bothMeasured = pair !== null && pair.har !== null && pair.harx !== null;
  const useHarX = bothMeasured && fitX !== null && (pair!.harx as number) > (pair!.har as number);
  const method = useHarX ? 'HAR-X' : 'HAR';

  // Iterated multi-step forecast: append each predicted RV and predict again.
  // HAR-X holds the last known VIX z constant across the 5 steps (VIX is
  // strongly persistent; the assumption is stated in the note).
  const path = rv.slice();
  const preds: number[] = [];
  const zNext =
    useHarX && fitX && exogNext !== null ? (exogNext - fitX.exogMean) / fitX.exogSd : null;
  for (let s = 0; s < 5; s++) {
    const p =
      useHarX && fitX && zNext !== null
        ? predictNextX(path, zNext, fitX)
        : predictNext(path, fit.beta);
    preds.push(p);
    path.push(p);
  }
  const forecast1dVolPct = round2(annualizedVolPct(preds[0]));
  const forecast5dVolPct = round2(annualizedVolPct(preds.reduce((a, b) => a + b, 0) / 5));

  // Regime: forecast vs the median of the trailing-1y rolling 22d realized vol.
  const rolling: number[] = [];
  const from = Math.max(LAG_22 - 1, rv.length - FIT_WINDOW);
  for (let i = from; i < rv.length; i++) {
    rolling.push(annualizedVolPct(trailingMean(rv, i, LAG_22)));
  }
  rolling.sort((a, b) => a - b);
  const mid = Math.floor(rolling.length / 2);
  const median =
    rolling.length % 2 === 1 ? rolling[mid] : (rolling[mid - 1] + rolling[mid]) / 2;
  const medianVol1yPct = round2(median);

  let regime: VolForecastResult['regime'] = 'normal';
  if (medianVol1yPct > 0) {
    const ratio = forecast1dVolPct / medianVol1yPct;
    regime = ratio > 1.25 ? 'elevated' : ratio < 0.8 ? 'calm' : 'normal';
  }
  let sizingHint: string | null = null;
  if (regime === 'elevated' && forecast1dVolPct > 0) {
    const cutPct = Math.round((1 - medianVol1yPct / forecast1dVolPct) * 100);
    sizingHint =
      `Forecast vol is ~${(forecast1dVolPct / medianVol1yPct).toFixed(2)}× the 1y median — ` +
      `reduce position ~${cutPct}% to keep rupee-risk equal to a median-vol day.`;
  }

  // OOS R²s: when both models were compared, report both (same days); the
  // chosen model's value is the headline r2OutOfSample. Otherwise keep the
  // V8 plain-HAR walk-forward measurement.
  let r2OutOfSample: number | null;
  let oosSamples: number;
  let r2Har: number | null = null;
  let r2HarX: number | null = null;
  if (bothMeasured) {
    r2Har = round4(pair!.har as number);
    r2HarX = round4(pair!.harx as number);
    r2OutOfSample = useHarX ? r2HarX : r2Har;
    oosSamples = pair!.samples;
  } else {
    const oos = walkForwardOosR2(rv);
    r2Har = oos.r2 === null ? null : round4(oos.r2);
    r2OutOfSample = r2Har;
    oosSamples = oos.samples;
  }
  const vixDeltaR2 = r2Har !== null && r2HarX !== null ? round4(r2HarX - r2Har) : null;

  const chosenLine = bothMeasured
    ? useHarX
      ? `HAR-X WON out-of-sample (R² ${r2HarX} vs ${r2Har} plain, Δ ${vixDeltaR2} on ${oosSamples} ` +
        'shared walk-forward days) — the forecast uses HAR-X, holding the last VIX z constant over the 5-day iteration.'
      : `Plain HAR won out-of-sample (R² ${r2Har} vs ${r2HarX} HAR-X, Δ ${vixDeltaR2} on ${oosSamples} ` +
        'shared walk-forward days) — the VIX regressor added nothing here, so the forecast uses plain HAR.'
    : vixStatus;

  return {
    forecast1dVolPct,
    forecast5dVolPct,
    historicalAvgVolPct,
    medianVol1yPct,
    regime,
    sizingHint,
    r2InSample: round4(useHarX && fitX ? fitX.r2InSample : fit.r2InSample),
    r2OutOfSample,
    oosSamples,
    betas: useHarX && fitX ? fitX.beta.slice() : fit.beta.slice(),
    method,
    methodology,
    r2OutOfSampleHar: r2Har,
    r2OutOfSampleHarX: r2HarX,
    vixDeltaR2,
    note:
      `Fit on ${useHarX && fitX ? fitX.nObs : fit.nObs} daily observations; out-of-sample R² measured on ` +
      `${oosSamples} walk-forward days. ${chosenLine} ${caveat}`.replace(/\s{2,}/g, ' '),
  };
}
