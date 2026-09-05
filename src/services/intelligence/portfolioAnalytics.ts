import { Bar } from "../market/types";

export interface PortfolioAnalyticsPosition {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  sector?: string | null;
  marketCapCategory?: "LARGE" | "MID" | "SMALL" | "UNKNOWN";
}

export interface ExposureResult {
  totalMarketValue: number;
  positions: Array<{ ticker: string; marketValue: number; stockWeightPct: number }>;
  sectorWeightsPct: Record<string, number>;
  marketCapWeightsPct: Record<string, number>;
  top5WeightPct: number;
  largestPosition: { ticker: string; weightPct: number } | null;
  hhi: number;
}

const round = (v: number, digits = 4): number => Number(v.toFixed(digits));

export function calculatePortfolioExposure(
  positions: PortfolioAnalyticsPosition[]
): ExposureResult {
  const valued = positions
    .filter((p) => Number.isFinite(p.quantity) && Number.isFinite(p.currentPrice) && p.quantity >= 0 && p.currentPrice >= 0)
    .map((p) => ({ ...p, marketValue: p.quantity * p.currentPrice }));
  const totalMarketValue = valued.reduce((sum, p) => sum + p.marketValue, 0);
  const resultPositions = valued.map((p) => ({
    ticker: p.ticker,
    marketValue: round(p.marketValue, 2),
    stockWeightPct: totalMarketValue > 0 ? round((p.marketValue / totalMarketValue) * 100) : 0,
  })).sort((a, b) => b.stockWeightPct - a.stockWeightPct);
  const sectorWeightsPct: Record<string, number> = {};
  const marketCapWeightsPct: Record<string, number> = {};
  for (const p of valued) {
    const weight = totalMarketValue > 0 ? (p.marketValue / totalMarketValue) * 100 : 0;
    const sector = p.sector?.trim() || "UNKNOWN";
    const cap = p.marketCapCategory ?? "UNKNOWN";
    sectorWeightsPct[sector] = round((sectorWeightsPct[sector] ?? 0) + weight);
    marketCapWeightsPct[cap] = round((marketCapWeightsPct[cap] ?? 0) + weight);
  }
  const hhi = resultPositions.reduce((sum, p) => sum + Math.pow(p.stockWeightPct / 100, 2), 0);
  return {
    totalMarketValue: round(totalMarketValue, 2),
    positions: resultPositions,
    sectorWeightsPct,
    marketCapWeightsPct,
    top5WeightPct: round(resultPositions.slice(0, 5).reduce((sum, p) => sum + p.stockWeightPct, 0)),
    largestPosition: resultPositions[0]
      ? { ticker: resultPositions[0].ticker, weightPct: resultPositions[0].stockWeightPct }
      : null,
    hhi: round(hhi, 6),
  };
}

export type CorrelationWindow = "30D" | "90D" | "1Y" | "3Y" | "5Y";
const WINDOW_DAYS: Record<CorrelationWindow, number> = {
  "30D": 30,
  "90D": 90,
  "1Y": 252,
  "3Y": 756,
  "5Y": 1260,
};

function returnsByDate(bars: Bar[]): Map<string, number> {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const map = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1].close;
    if (previous > 0 && Number.isFinite(previous) && Number.isFinite(sorted[i].close)) {
      map.set(sorted[i].date, sorted[i].close / previous - 1);
    }
  }
  return map;
}

function pearson(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const meanA = a.reduce((s, x) => s + x, 0) / a.length;
  const meanB = b.reduce((s, x) => s + x, 0) / b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator === 0 ? null : round(covariance / denominator, 6);
}

/** Correlation of aligned daily returns, never raw price levels. */
export function calculateCorrelationMatrix(
  series: Record<string, Bar[]>,
  window: CorrelationWindow
): { tickers: string[]; observations: Record<string, number>; matrix: Array<Array<number | null>> } {
  const tickers = Object.keys(series);
  const limit = WINDOW_DAYS[window];
  const maps = new Map(tickers.map((ticker) => [ticker, returnsByDate(series[ticker])]));
  const observations: Record<string, number> = {};
  const matrix = tickers.map((left) => tickers.map((right) => {
    if (left === right) {
      observations[`${left}:${right}`] = Math.min(limit, maps.get(left)?.size ?? 0);
      return 1;
    }
    const leftMap = maps.get(left)!;
    const rightMap = maps.get(right)!;
    const dates = [...leftMap.keys()].filter((date) => rightMap.has(date)).sort().slice(-limit);
    observations[`${left}:${right}`] = dates.length;
    if (dates.length < Math.min(20, limit)) return null;
    return pearson(dates.map((date) => leftMap.get(date)!), dates.map((date) => rightMap.get(date)!));
  }));
  return { tickers, observations, matrix };
}
