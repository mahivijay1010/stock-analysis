/**
 * ForecastModel interface + TypeScript baseline/statistical models
 * (completion directive, Phase 2) — PURE, no I/O.
 *
 * Every model implements fit/predict/metadata/version and emits the common
 * output contract. Baselines are deliberately dumb — they are the bar every
 * challenger must beat out of sample (Rule 4). Direction probabilities here
 * are RAW (uncalibrated) model outputs; calibration is a separate layer
 * (Phase 7) and display honesty never changes: nothing is a probability to
 * the user until a calibrator has earned it.
 *
 * Model-family decisions (documented per spec):
 *  - EWMA vol (λ=.94) is the volatility model; GARCH was evaluated and
 *    REJECTED for this data size: MLE over ~400 obs is fragile and EWMA is
 *    the RiskMetrics-standard robust special case. HAR-RV already exists as
 *    a separately-validated vol diagnostic (volforecast.ts).
 *  - Ridge (closed form) and L2 logistic (gradient descent) are the
 *    regularized linear models; AR(1) covers the classical time-series slot
 *    (full ARIMA adds order-selection fragility with no evidence of benefit
 *    at these sample sizes — revisit in the registry if ridge shows signal).
 */

export interface TrainRow {
  ticker: string;
  date: string; // prediction session (YYYY-MM-DD)
  features: Record<string, number | null>;
  /** Forward h-day return (fraction), from the ADJUSTED series. */
  targetReturn: number;
}

export interface PredictRow {
  ticker: string;
  date: string;
  features: Record<string, number | null>;
}

export interface ModelOutput {
  modelName: string;
  modelVersion: string;
  horizonDays: number;
  expectedReturn: number | null; // fraction
  medianReturn: number | null; // fraction
  quantiles: { p10: number; p50: number; p90: number } | null; // fractions
  rawDirectionProbability: number | null; // 0..1, UNCALIBRATED
  featureTimestamp: string;
  trainingEndDate: string;
}

export interface ForecastModel {
  readonly name: string;
  version(): string;
  metadata(): Record<string, unknown>;
  fit(train: TrainRow[]): void;
  predict(row: PredictRow, horizonDays: number): ModelOutput;
}

const PHI = (z: number): number => {
  // Abramowitz–Stegun normal CDF approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return Math.min(1 - 1e-6, Math.max(1e-6, p));
};

const Z90 = 1.2816;

function base(
  name: string,
  ver: string,
  horizonDays: number,
  row: PredictRow,
  trainingEndDate: string
): Omit<ModelOutput, "expectedReturn" | "medianReturn" | "quantiles" | "rawDirectionProbability"> {
  return {
    modelName: name,
    modelVersion: ver,
    horizonDays,
    featureTimestamp: row.date,
    trainingEndDate,
  };
}

// ── baselines ────────────────────────────────────────────────────────────────

/** Always 50% direction, no return opinion — the Brier floor definition. */
export class Constant50Model implements ForecastModel {
  readonly name = "baseline-constant50";
  private trainEnd = "";
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "baseline" };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
  }
  predict(row: PredictRow, h: number): ModelOutput {
    return { ...base(this.name, "v1", h, row, this.trainEnd), expectedReturn: null, medianReturn: null, quantiles: null, rawDirectionProbability: 0.5 };
  }
}

/** Random walk / zero-return forecast with EWMA-σ intervals. */
export class ZeroReturnModel implements ForecastModel {
  readonly name = "baseline-zero-return";
  private sigmaDaily = 0.015;
  private trainEnd = "";
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "baseline", intervals: "EWMA(0.94) sigma" };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    // EWMA variance over the train targets scaled back to daily.
    let v: number | null = null;
    for (const r of train) {
      const daily = r.targetReturn; // horizon returns; we scale at predict time
      v = v == null ? daily * daily : 0.94 * v + 0.06 * daily * daily;
    }
    if (v != null && v > 0) this.sigmaDaily = Math.sqrt(v); // per-horizon sigma actually
  }
  predict(row: PredictRow, h: number): ModelOutput {
    const s = this.sigmaDaily; // fitted on h-day targets, already horizon-scaled
    return {
      ...base(this.name, "v1", h, row, this.trainEnd),
      expectedReturn: 0,
      medianReturn: 0,
      quantiles: { p10: -Z90 * s, p50: 0, p90: Z90 * s },
      rawDirectionProbability: 0.5,
    };
  }
}

/** Train-only historical mean return; prob = Φ(mean/σ). */
export class HistoricalMeanModel implements ForecastModel {
  readonly name = "baseline-historical-mean";
  private mean = 0;
  private sigma = 0.05;
  private trainEnd = "";
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "baseline" };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    if (train.length === 0) return;
    this.mean = train.reduce((a, r) => a + r.targetReturn, 0) / train.length;
    const v = train.reduce((a, r) => a + (r.targetReturn - this.mean) ** 2, 0) / Math.max(1, train.length - 1);
    this.sigma = Math.max(1e-6, Math.sqrt(v));
  }
  predict(row: PredictRow, h: number): ModelOutput {
    return {
      ...base(this.name, "v1", h, row, this.trainEnd),
      expectedReturn: this.mean,
      medianReturn: this.mean,
      quantiles: { p10: this.mean - Z90 * this.sigma, p50: this.mean, p90: this.mean + Z90 * this.sigma },
      rawDirectionProbability: PHI(this.mean / this.sigma),
    };
  }
}

/** Train-only direction base rate; no return opinion. */
export class BaseRateModel implements ForecastModel {
  readonly name = "baseline-base-rate";
  private p = 0.5;
  private trainEnd = "";
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "baseline" };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    if (train.length === 0) return;
    this.p = train.filter((r) => r.targetReturn > 0).length / train.length;
  }
  predict(row: PredictRow, h: number): ModelOutput {
    return { ...base(this.name, "v1", h, row, this.trainEnd), expectedReturn: null, medianReturn: null, quantiles: null, rawDirectionProbability: this.p };
  }
}

/** Simple momentum: direction prob = train base rate CONDITIONED on sign(ret_20d). */
export class MomentumModel implements ForecastModel {
  readonly name = "baseline-momentum";
  private pUpGivenUp = 0.5;
  private pUpGivenDown = 0.5;
  private meanGivenUp = 0;
  private meanGivenDown = 0;
  private trainEnd = "";
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "baseline", conditioning: "sign(ret_20d)" };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    const up = train.filter((r) => (r.features["ret_20d"] ?? 0) > 0);
    const down = train.filter((r) => (r.features["ret_20d"] ?? 0) <= 0);
    if (up.length >= 20) {
      this.pUpGivenUp = up.filter((r) => r.targetReturn > 0).length / up.length;
      this.meanGivenUp = up.reduce((a, r) => a + r.targetReturn, 0) / up.length;
    }
    if (down.length >= 20) {
      this.pUpGivenDown = down.filter((r) => r.targetReturn > 0).length / down.length;
      this.meanGivenDown = down.reduce((a, r) => a + r.targetReturn, 0) / down.length;
    }
  }
  predict(row: PredictRow, h: number): ModelOutput {
    const upMomentum = (row.features["ret_20d"] ?? 0) > 0;
    return {
      ...base(this.name, "v1", h, row, this.trainEnd),
      expectedReturn: upMomentum ? this.meanGivenUp : this.meanGivenDown,
      medianReturn: null,
      quantiles: null,
      rawDirectionProbability: upMomentum ? this.pUpGivenUp : this.pUpGivenDown,
    };
  }
}

// ── statistical challengers ──────────────────────────────────────────────────

/** AR(1) on horizon returns: target_t = c + φ·ret_h_lag; OLS fit. */
export class Ar1Model implements ForecastModel {
  readonly name = "stat-ar1";
  private c = 0;
  private phi = 0;
  private sigma = 0.05;
  private trainEnd = "";
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "statistical", note: "OLS AR(1) on h-day returns vs the trailing h-day return feature" };
  }
  private lagFeature(h: number): string {
    return h <= 1 ? "ret_1d" : h <= 3 ? "ret_3d" : h <= 7 ? "ret_5d" : h <= 15 ? "ret_10d" : "ret_20d";
  }
  private lag = "ret_20d";
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    const pairs = train
      .map((r) => ({ x: r.features[this.lag], y: r.targetReturn }))
      .filter((p): p is { x: number; y: number } => p.x != null && Number.isFinite(p.x));
    if (pairs.length < 30) return;
    const mx = pairs.reduce((a, p) => a + p.x, 0) / pairs.length;
    const my = pairs.reduce((a, p) => a + p.y, 0) / pairs.length;
    let sxy = 0;
    let sxx = 0;
    for (const p of pairs) {
      sxy += (p.x - mx) * (p.y - my);
      sxx += (p.x - mx) ** 2;
    }
    this.phi = sxx > 0 ? sxy / sxx : 0;
    this.c = my - this.phi * mx;
    const resid = pairs.map((p) => p.y - (this.c + this.phi * p.x));
    const v = resid.reduce((a, e) => a + e * e, 0) / Math.max(1, resid.length - 1);
    this.sigma = Math.max(1e-6, Math.sqrt(v));
  }
  predict(row: PredictRow, h: number): ModelOutput {
    this.lag = this.lagFeature(h);
    const x = row.features[this.lag];
    const mu = x != null ? this.c + this.phi * x : this.c;
    return {
      ...base(this.name, "v1", h, row, this.trainEnd),
      expectedReturn: mu,
      medianReturn: mu,
      quantiles: { p10: mu - Z90 * this.sigma, p50: mu, p90: mu + Z90 * this.sigma },
      rawDirectionProbability: PHI(mu / this.sigma),
    };
  }
}

/** Standardization + closed-form ridge regression on returns. */
export class RidgeModel implements ForecastModel {
  readonly name = "stat-ridge";
  private lambda: number;
  private featureNames: string[] = [];
  private means: number[] = [];
  private stds: number[] = [];
  private weights: number[] = [];
  private intercept = 0;
  private sigma = 0.05;
  private trainEnd = "";
  constructor(lambda = 10) {
    this.lambda = lambda;
  }
  version(): string {
    return `v1-l${this.lambda}`;
  }
  metadata(): Record<string, unknown> {
    return { kind: "statistical", lambda: this.lambda, solver: "closed-form (X'X+λI)⁻¹X'y via Gaussian elimination" };
  }
  private matrix(train: TrainRow[]): { X: number[][]; y: number[] } {
    // Feature set = numeric features present in ≥90% of rows.
    const counts = new Map<string, number>();
    for (const r of train) {
      for (const [k, v] of Object.entries(r.features)) if (v != null && Number.isFinite(v)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    this.featureNames = [...counts.entries()].filter(([, c]) => c >= train.length * 0.9).map(([k]) => k).sort();
    const X: number[][] = [];
    const y: number[] = [];
    for (const r of train) {
      const rowVals = this.featureNames.map((k) => r.features[k]);
      if (rowVals.some((v) => v == null || !Number.isFinite(v))) continue;
      X.push(rowVals as number[]);
      y.push(r.targetReturn);
    }
    return { X, y };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    const { X, y } = this.matrix(train);
    if (X.length < 50 || this.featureNames.length === 0) {
      this.weights = [];
      return;
    }
    const n = X.length;
    const d = this.featureNames.length;
    this.means = Array(d).fill(0);
    this.stds = Array(d).fill(1);
    for (let j = 0; j < d; j++) {
      let m = 0;
      for (let i = 0; i < n; i++) m += X[i][j];
      m /= n;
      let v = 0;
      for (let i = 0; i < n; i++) v += (X[i][j] - m) ** 2;
      this.means[j] = m;
      this.stds[j] = Math.max(1e-9, Math.sqrt(v / Math.max(1, n - 1)));
    }
    const Z = X.map((r) => r.map((v, j) => (v - this.means[j]) / this.stds[j]));
    const ymean = y.reduce((a, b) => a + b, 0) / n;
    const yc = y.map((v) => v - ymean);
    // A = Z'Z + λI ; b = Z'y
    const A: number[][] = Array.from({ length: d }, () => Array(d).fill(0));
    const b: number[] = Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < d; j++) {
        b[j] += Z[i][j] * yc[i];
        for (let k = j; k < d; k++) A[j][k] += Z[i][j] * Z[i][k];
      }
    }
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < j; k++) A[j][k] = A[k][j];
      A[j][j] += this.lambda;
    }
    // Gaussian elimination with partial pivoting.
    const w = this.solve(A, b);
    this.weights = w ?? [];
    this.intercept = ymean;
    if (this.weights.length) {
      const resid = Z.map((z, i) => yc[i] - z.reduce((a, v, j) => a + v * this.weights[j], 0));
      const v = resid.reduce((a, e) => a + e * e, 0) / Math.max(1, resid.length - 1);
      this.sigma = Math.max(1e-6, Math.sqrt(v));
    }
  }
  private solve(A: number[][], b: number[]): number[] | null {
    const d = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < d; col++) {
      let piv = col;
      for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < d; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        for (let c = col; c <= d; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[d] / row[i]);
  }
  predict(row: PredictRow, h: number): ModelOutput {
    if (!this.weights.length) {
      return { ...base(this.name, this.version(), h, row, this.trainEnd), expectedReturn: null, medianReturn: null, quantiles: null, rawDirectionProbability: null };
    }
    let mu = this.intercept;
    for (let j = 0; j < this.featureNames.length; j++) {
      const v = row.features[this.featureNames[j]];
      const z = v != null && Number.isFinite(v) ? (v - this.means[j]) / this.stds[j] : 0;
      mu += z * this.weights[j];
    }
    return {
      ...base(this.name, this.version(), h, row, this.trainEnd),
      expectedReturn: mu,
      medianReturn: mu,
      quantiles: { p10: mu - Z90 * this.sigma, p50: mu, p90: mu + Z90 * this.sigma },
      rawDirectionProbability: PHI(mu / this.sigma),
    };
  }
}

/** L2-regularized logistic regression on direction (gradient descent). */
export class LogisticModel implements ForecastModel {
  readonly name = "stat-logistic";
  private lambda: number;
  private featureNames: string[] = [];
  private means: number[] = [];
  private stds: number[] = [];
  private weights: number[] = [];
  private bias = 0;
  private trainEnd = "";
  constructor(lambda = 1) {
    this.lambda = lambda;
  }
  version(): string {
    return `v1-l${this.lambda}`;
  }
  metadata(): Record<string, unknown> {
    return { kind: "statistical", lambda: this.lambda, solver: "batch gradient descent, 400 iters" };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    const counts = new Map<string, number>();
    for (const r of train) for (const [k, v] of Object.entries(r.features)) if (v != null && Number.isFinite(v)) counts.set(k, (counts.get(k) ?? 0) + 1);
    this.featureNames = [...counts.entries()].filter(([, c]) => c >= train.length * 0.9).map(([k]) => k).sort();
    const rows: number[][] = [];
    const ys: number[] = [];
    for (const r of train) {
      const vals = this.featureNames.map((k) => r.features[k]);
      if (vals.some((v) => v == null || !Number.isFinite(v))) continue;
      rows.push(vals as number[]);
      ys.push(r.targetReturn > 0 ? 1 : 0);
    }
    if (rows.length < 50 || this.featureNames.length === 0) {
      this.weights = [];
      return;
    }
    const n = rows.length;
    const d = this.featureNames.length;
    this.means = Array(d).fill(0);
    this.stds = Array(d).fill(1);
    for (let j = 0; j < d; j++) {
      let m = 0;
      for (let i = 0; i < n; i++) m += rows[i][j];
      m /= n;
      let v = 0;
      for (let i = 0; i < n; i++) v += (rows[i][j] - m) ** 2;
      this.means[j] = m;
      this.stds[j] = Math.max(1e-9, Math.sqrt(v / Math.max(1, n - 1)));
    }
    const Z = rows.map((r) => r.map((v, j) => (v - this.means[j]) / this.stds[j]));
    this.weights = Array(d).fill(0);
    this.bias = 0;
    const lr = 0.1;
    for (let iter = 0; iter < 400; iter++) {
      const gw = Array(d).fill(0);
      let gb = 0;
      for (let i = 0; i < n; i++) {
        let z = this.bias;
        for (let j = 0; j < d; j++) z += Z[i][j] * this.weights[j];
        const p = 1 / (1 + Math.exp(-z));
        const err = p - ys[i];
        gb += err;
        for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      }
      this.bias -= (lr * gb) / n;
      for (let j = 0; j < d; j++) this.weights[j] -= lr * (gw[j] / n + (this.lambda / n) * this.weights[j]);
    }
  }
  predict(row: PredictRow, h: number): ModelOutput {
    if (!this.weights.length) {
      return { ...base(this.name, this.version(), h, row, this.trainEnd), expectedReturn: null, medianReturn: null, quantiles: null, rawDirectionProbability: null };
    }
    let z = this.bias;
    for (let j = 0; j < this.featureNames.length; j++) {
      const v = row.features[this.featureNames[j]];
      const s = v != null && Number.isFinite(v) ? (v - this.means[j]) / this.stds[j] : 0;
      z += s * this.weights[j];
    }
    const p = 1 / (1 + Math.exp(-z));
    return { ...base(this.name, this.version(), h, row, this.trainEnd), expectedReturn: null, medianReturn: null, quantiles: null, rawDirectionProbability: Math.min(1 - 1e-6, Math.max(1e-6, p)) };
  }
}


/**
 * EWMA baseline (Part F): exponentially-weighted mean of the momentum ladder
 * (λ chosen a priori ≈ RiskMetrics 0.94 ⇒ ~11-session half-life). No fitting
 * beyond the residual σ — a mandatory dumb-but-honest challenger.
 */
export class EwmaModel implements ForecastModel {
  readonly name = "stat-ewma";
  private sigma = 0.05;
  private trainEnd = "";
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "statistical", note: "EWMA(λ=0.94-equivalent) drift from the return ladder; σ from train residuals" };
  }
  private mu(row: { features: Record<string, number | null> }, h: number): number {
    // Exponential weights over per-day means of the trailing 1/3/5/10/20d returns.
    const ladder: Array<[string, number]> = [
      ["ret_1d", 1],
      ["ret_3d", 3],
      ["ret_5d", 5],
      ["ret_10d", 10],
      ["ret_20d", 20],
    ];
    let wSum = 0;
    let acc = 0;
    for (const [k, n] of ladder) {
      const v = row.features[k];
      if (v == null || !Number.isFinite(v)) continue;
      const w = Math.pow(0.94, n); // older windows weigh less
      acc += w * (v / n);
      wSum += w;
    }
    const dailyDrift = wSum > 0 ? acc / wSum : 0;
    return dailyDrift * h;
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    const resid = train
      .map((r) => r.targetReturn - this.mu(r, 1) /* h folded into target scale below */)
      .filter((x) => Number.isFinite(x));
    // σ straight from target dispersion (drift is tiny relative to noise).
    if (train.length >= 30) {
      const ys = train.map((r) => r.targetReturn);
      const m = ys.reduce((a, b) => a + b, 0) / ys.length;
      this.sigma = Math.max(1e-6, Math.sqrt(ys.reduce((a, y) => a + (y - m) ** 2, 0) / (ys.length - 1)));
    }
    void resid;
  }
  predict(row: PredictRow, h: number): ModelOutput {
    const mu = this.mu(row, hToTradingDays(h));
    return {
      ...base(this.name, "v1", h, row, this.trainEnd),
      expectedReturn: mu,
      medianReturn: mu,
      quantiles: { p10: mu - Z90 * this.sigma, p50: mu, p90: mu + Z90 * this.sigma },
      rawDirectionProbability: PHI(mu / this.sigma),
    };
  }
}

/**
 * HAR-RV distribution baseline (Part F): μ = 0; σ̂ for the horizon regressed
 * (OLS) on the daily/weekly/monthly realized-vol components (Corsi 2009
 * shape). Tests whether better VOLATILITY forecasting alone improves CRPS /
 * coverage — it never claims direction (prob = 0.5).
 */
export class HarRvModel implements ForecastModel {
  readonly name = "stat-har-rv";
  private b0 = 0;
  private b1 = 0;
  private b5 = 0;
  private b22 = 0;
  private fallbackSigma = 0.05;
  private trainEnd = "";
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "statistical", note: "HAR-RV σ forecast (rv_1d/rv_5d/rv_22d, ann%) → h-day quantiles; μ=0, prob=0.5" };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    // Target: |h-day return| as the realized-vol proxy for the horizon.
    const rows = train
      .map((r) => ({
        y: Math.abs(r.targetReturn),
        x1: r.features["rv_1d_ann_pct"],
        x5: r.features["rv_5d_ann_pct"],
        x22: r.features["rv_22d_ann_pct"],
      }))
      .filter((r): r is { y: number; x1: number; x5: number; x22: number } =>
        r.x1 != null && r.x5 != null && r.x22 != null && Number.isFinite(r.y)
      );
    const ys = train.map((r) => r.targetReturn);
    if (ys.length >= 30) {
      const m = ys.reduce((a, b) => a + b, 0) / ys.length;
      this.fallbackSigma = Math.max(1e-6, Math.sqrt(ys.reduce((a, y) => a + (y - m) ** 2, 0) / (ys.length - 1)));
    }
    if (rows.length < 60) return;
    // OLS via normal equations on [1, x1, x5, x22].
    const X = rows.map((r) => [1, r.x1, r.x5, r.x22]);
    const Y = rows.map((r) => r.y);
    const XtX: number[][] = Array.from({ length: 4 }, () => new Array(4).fill(0));
    const XtY = new Array(4).fill(0);
    for (let i = 0; i < X.length; i++) {
      for (let a = 0; a < 4; a++) {
        XtY[a] += X[i][a] * Y[i];
        for (let b = 0; b < 4; b++) XtX[a][b] += X[i][a] * X[i][b];
      }
    }
    for (let a = 0; a < 4; a++) XtX[a][a] += 1e-6; // ridge jitter for stability
    const beta = solveLinear(XtX, XtY);
    if (beta) {
      this.b0 = beta[0];
      this.b1 = beta[1];
      this.b5 = beta[2];
      this.b22 = beta[3];
    }
  }
  predict(row: PredictRow, h: number): ModelOutput {
    const x1 = row.features["rv_1d_ann_pct"];
    const x5 = row.features["rv_5d_ann_pct"];
    const x22 = row.features["rv_22d_ann_pct"];
    let sigma = this.fallbackSigma;
    if (x1 != null && x5 != null && x22 != null && (this.b1 !== 0 || this.b5 !== 0 || this.b22 !== 0)) {
      // |ret| ≈ σ·sqrt(2/π) for a normal ⇒ σ = E|ret| / 0.7979.
      const absHat = this.b0 + this.b1 * x1 + this.b5 * x5 + this.b22 * x22;
      if (Number.isFinite(absHat) && absHat > 0) sigma = Math.max(1e-6, absHat / 0.7979);
    }
    return {
      ...base(this.name, "v1", h, row, this.trainEnd),
      expectedReturn: 0,
      medianReturn: 0,
      quantiles: { p10: -Z90 * sigma, p50: 0, p90: Z90 * sigma },
      rawDirectionProbability: 0.5,
    };
  }
}

/**
 * ARX baseline (Part F "AR models / ARIMAX where justified"): OLS on the full
 * momentum ladder (a finite-lag AR approximation with exogenous windows).
 */
export class ArxModel implements ForecastModel {
  readonly name = "stat-arx";
  private beta: number[] | null = null;
  private sigma = 0.05;
  private trainEnd = "";
  private static LAGS = ["ret_1d", "ret_2d", "ret_3d", "ret_5d", "ret_10d", "ret_20d"];
  version(): string {
    return "v1";
  }
  metadata(): Record<string, unknown> {
    return { kind: "statistical", note: "OLS AR-with-exogenous-windows on the return ladder (ridge-jittered normal equations)" };
  }
  fit(train: TrainRow[]): void {
    this.trainEnd = train.length ? train[train.length - 1].date : "";
    const rows = train
      .map((r) => ({ y: r.targetReturn, x: ArxModel.LAGS.map((k) => r.features[k]) }))
      .filter((r): r is { y: number; x: number[] } => r.x.every((v) => v != null && Number.isFinite(v)));
    if (rows.length < 100) return;
    const d = ArxModel.LAGS.length + 1;
    const XtX: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
    const XtY = new Array(d).fill(0);
    for (const r of rows) {
      const xi = [1, ...r.x];
      for (let a = 0; a < d; a++) {
        XtY[a] += xi[a] * r.y;
        for (let b = 0; b < d; b++) XtX[a][b] += xi[a] * xi[b];
      }
    }
    for (let a = 0; a < d; a++) XtX[a][a] += 1e-4;
    this.beta = solveLinear(XtX, XtY);
    if (this.beta) {
      const resid = rows.map((r) => r.y - [1, ...r.x].reduce((acc, v, i) => acc + v * (this.beta as number[])[i], 0));
      this.sigma = Math.max(1e-6, Math.sqrt(resid.reduce((a, e) => a + e * e, 0) / Math.max(1, resid.length - 1)));
    }
  }
  predict(row: PredictRow, h: number): ModelOutput {
    let mu = 0;
    if (this.beta) {
      const x = ArxModel.LAGS.map((k) => row.features[k]);
      if (x.every((v) => v != null && Number.isFinite(v))) {
        mu = [1, ...(x as number[])].reduce((acc, v, i) => acc + v * (this.beta as number[])[i], 0);
      }
    }
    return {
      ...base(this.name, "v1", h, row, this.trainEnd),
      expectedReturn: mu,
      medianReturn: mu,
      quantiles: { p10: mu - Z90 * this.sigma, p50: mu, p90: mu + Z90 * this.sigma },
      rawDirectionProbability: PHI(mu / this.sigma),
    };
  }
}

/** Calendar horizon → trading days (matches the harness H_TD map). */
function hToTradingDays(h: number): number {
  return h <= 1 ? 1 : h <= 3 ? 2 : h <= 7 ? 5 : h <= 15 ? 10 : 21;
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

export function tsBaselineModels(): ForecastModel[] {
  return [new Constant50Model(), new ZeroReturnModel(), new HistoricalMeanModel(), new BaseRateModel(), new MomentumModel()];
}

export function tsStatisticalModels(): ForecastModel[] {
  return [new Ar1Model(), new RidgeModel(10), new LogisticModel(1), new EwmaModel(), new HarRvModel(), new ArxModel()];
}
