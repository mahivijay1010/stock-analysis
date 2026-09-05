import axios, { AxiosInstance } from 'axios';
import type {
  AccuracyResponse,
  AdminAccountResponse,
  AdminSettingsRequest,
  AnalyzeResponse,
  AssistantResponse,
  CalibrationResponse,
  ChartRange,
  ChartResponse,
  DailyPlanResponse,
  ExecutionSummaryResponse,
  ForecastLocksResponse,
  HoldingCalcRequest,
  HoldingCalcResponse,
  OptionsSkewResponse,
  PaperTrade,
  PortfolioStrategy,
  PortfolioStressResponse,
  PortfolioSuggestResponse,
  PositionSizeResponse,
  PredictionAuditResponse,
  RankUniverseResponse,
  RecordTradeRequest,
  ResearchBrief,
  SearchResult,
  TopPicksResponse,
  UniverseStockRow,
  VolForecastResponse,
} from './types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5101';

/** Backend envelope: every route returns { success, data } or { success, error }. */
type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error?: { message?: string } };

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const http: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

function unwrap<T>(body: ApiEnvelope<T> | undefined, status?: number): T {
  if (body && body.success === true) return body.data;
  const message =
    (body && body.success === false && body.error?.message) || 'Malformed response from the analysis server';
  throw new ApiError(message, status);
}

function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as ApiEnvelope<unknown> | undefined;
    const serverMessage =
      body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object'
        ? (body.error as { message?: string }).message
        : undefined;
    if (serverMessage) return new ApiError(serverMessage, err.response?.status);
    if (err.code === 'ECONNABORTED') return new ApiError('The request timed out. Please try again.');
    if (!err.response) return new ApiError('Cannot reach the analysis server. Is the backend running?');
    return new ApiError(`Request failed with status ${err.response.status}`, err.response.status);
  }
  return new ApiError(err instanceof Error ? err.message : 'Unexpected error');
}

async function get<T>(url: string, params?: Record<string, string | number>): Promise<T> {
  try {
    const res = await http.get<ApiEnvelope<T>>(url, { params });
    return unwrap(res.data, res.status);
  } catch (err) {
    throw normalizeError(err);
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  try {
    const res = await http.post<ApiEnvelope<T>>(url, body);
    return unwrap(res.data, res.status);
  } catch (err) {
    throw normalizeError(err);
  }
}

/** GET /api/search?q= */
export function searchStocks(q: string): Promise<SearchResult[]> {
  return get<SearchResult[]>('/api/search', { q });
}

/** POST /api/analyze — accepts a ticker or a free-text name; optional ₹ amount for an investment plan. */
export function analyzeStock(ticker: string, amount?: number | null): Promise<AnalyzeResponse> {
  const body: { ticker: string; amount?: number } = { ticker };
  if (amount != null && Number.isFinite(amount) && amount > 0) body.amount = amount;
  return post<AnalyzeResponse>('/api/analyze', body);
}

/** GET /api/top-picks?count=&maxPrice= — maxPrice filters to shares priced at or under your per-share budget. */
export function getTopPicks(count = 5, maxPrice?: number | null): Promise<TopPicksResponse> {
  const params: Record<string, string | number> = { count };
  if (maxPrice != null && Number.isFinite(maxPrice) && maxPrice > 0) params.maxPrice = maxPrice;
  return get<TopPicksResponse>('/api/top-picks', params);
}

/** GET /api/accuracy */
export function getAccuracy(): Promise<AccuracyResponse> {
  return get<AccuracyResponse>('/api/accuracy');
}

/** GET /api/calibration — V6 Brier calibration (backtest + live). 404s on an older backend — callers hide the section. */
export function getCalibration(): Promise<CalibrationResponse> {
  return get<CalibrationResponse>('/api/calibration');
}

/** GET /api/research/:ticker — V6 deterministic investment brief. 404s on an older backend. */
export function getResearchBrief(ticker: string): Promise<ResearchBrief> {
  return get<ResearchBrief>(`/api/research/${encodeURIComponent(ticker)}`);
}

/** GET /api/stocks/:ticker/chart?range= */
export function getStockChart(ticker: string, range: ChartRange): Promise<ChartResponse> {
  return get<ChartResponse>(`/api/stocks/${encodeURIComponent(ticker)}/chart`, { range });
}

/** GET /api/stocks */
export function getStocks(): Promise<UniverseStockRow[]> {
  return get<UniverseStockRow[]>('/api/stocks');
}

/** POST /api/holdings/calculate — stateless "what profit can I book" calculator. */
export function calculateHolding(req: HoldingCalcRequest): Promise<HoldingCalcResponse> {
  return post<HoldingCalcResponse>('/api/holdings/calculate', req);
}

/** POST /api/portfolio/suggest — multi-stock allocation for any ₹ amount + strategy. */
export function suggestPortfolio(amount: number, strategy: PortfolioStrategy): Promise<PortfolioSuggestResponse> {
  return post<PortfolioSuggestResponse>('/api/portfolio/suggest', { amount, strategy });
}

/**
 * GET /api/portfolio/stress — V7 historical-window + block-bootstrap stress test.
 * Omit tickers/weights to let the backend fall back to the admin open positions.
 * 404s on an older backend — callers hide the card.
 */
export function getPortfolioStress(tickers?: string[], weights?: number[]): Promise<PortfolioStressResponse> {
  const params: Record<string, string> = {};
  if (tickers && tickers.length > 0) params.tickers = tickers.join(',');
  if (weights && weights.length > 0) params.weights = weights.map((w) => String(w)).join(',');
  return get<PortfolioStressResponse>('/api/portfolio/stress', params);
}

/* ------------------------------------------------------------------ */
/* V8 — SPEC_V8.md endpoints (rank / vol forecast / options / Kelly).  */
/* All four 404 on an older backend — every caller hides gracefully.   */
/* ------------------------------------------------------------------ */

/** GET /api/rank/universe — cross-sectional composite ranks + measured-or-null IC. */
export function getRankUniverse(): Promise<RankUniverseResponse> {
  return get<RankUniverseResponse>('/api/rank/universe');
}

/** GET /api/volatility/forecast/:ticker — HAR-RV (daily-proxy) vol forecast with both R²s. */
export function getVolForecast(ticker: string): Promise<VolForecastResponse> {
  return get<VolForecastResponse>(`/api/volatility/forecast/${encodeURIComponent(ticker)}`);
}

/** GET /api/options/skew/:ticker — NSE option-chain PCR/skew; probe-first, may be NOT_AVAILABLE. */
export function getOptionsSkew(ticker: string): Promise<OptionsSkewResponse> {
  return get<OptionsSkewResponse>(`/api/options/skew/${encodeURIComponent(ticker)}`);
}

/** GET /api/position-size/:ticker?capital= — measured-inputs Kelly sizing (half-Kelly headline). */
export function getPositionSize(ticker: string, capital: number): Promise<PositionSizeResponse> {
  return get<PositionSizeResponse>(`/api/position-size/${encodeURIComponent(ticker)}`, { capital });
}

/** POST /api/assistant — Sensei, the stocks-only chat assistant. */
export function askAssistant(message: string): Promise<AssistantResponse> {
  return post<AssistantResponse>('/api/assistant', { message });
}

/* ------------------------------------------------------------------ */
/* V2 — Admin trading desk (/api/admin, no auth for local use;         */
/* x-admin-key sent only when NEXT_PUBLIC_ADMIN_KEY is configured).    */
/* ------------------------------------------------------------------ */

const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_KEY;

function adminConfig() {
  return ADMIN_KEY ? { headers: { 'x-admin-key': ADMIN_KEY } } : undefined;
}

async function adminGet<T>(url: string): Promise<T> {
  try {
    const res = await http.get<ApiEnvelope<T>>(url, adminConfig());
    return unwrap(res.data, res.status);
  } catch (err) {
    throw normalizeError(err);
  }
}

/** GET /api/admin/account */
export function getAdminAccount(): Promise<AdminAccountResponse> {
  return adminGet<AdminAccountResponse>('/api/admin/account');
}

/** GET /api/admin/daily-plan */
export function getAdminDailyPlan(): Promise<DailyPlanResponse> {
  return adminGet<DailyPlanResponse>('/api/admin/daily-plan');
}

/** GET /api/admin/trades — full paper-trade history. */
export function getAdminTrades(): Promise<PaperTrade[]> {
  return adminGet<PaperTrade[]>('/api/admin/trades');
}

/** GET /api/admin/prediction-audit — live predictions vs reality, trade review and expectancy. */
export function getPredictionAudit(): Promise<PredictionAuditResponse> {
  return adminGet<PredictionAuditResponse>('/api/admin/prediction-audit');
}

/**
 * GET /api/admin/forecast-locks — every BUY freezes its purchase-day 7d/30d
 * forecast into the trade; this tracks live price vs the frozen band and
 * grades matured horizons against the real close on the target date. Locks
 * are never recomputed. 404s on an older backend — the desk card hides itself.
 */
export function getForecastLocks(): Promise<ForecastLocksResponse> {
  return adminGet<ForecastLocksResponse>('/api/admin/forecast-locks');
}

/** POST /api/admin/trades — record a paper BUY/SELL. */
export async function recordAdminTrade(req: RecordTradeRequest): Promise<unknown> {
  try {
    const res = await http.post<ApiEnvelope<unknown>>('/api/admin/trades', req, adminConfig());
    return unwrap(res.data, res.status);
  } catch (err) {
    throw normalizeError(err);
  }
}

/** POST /api/admin/account/settings — update capital/target (capital change resets the challenge). */
export async function updateAdminSettings(req: AdminSettingsRequest): Promise<AdminAccountResponse> {
  try {
    const res = await http.post<ApiEnvelope<AdminAccountResponse>>('/api/admin/account/settings', req, adminConfig());
    return unwrap(res.data, res.status);
  } catch (err) {
    throw normalizeError(err);
  }
}

/* ------------------------------------------------------------------ */
/* V9 — SPEC_V9.md Execution Feedback Loop.                            */
/* ------------------------------------------------------------------ */

/**
 * GET /api/execution/summary — YOUR measured win rate / payoff / half-Kelly
 * from closed paper trades vs the model, plus the nightly Kelly-drift series.
 * 404s on an older backend — the desk feedback card hides itself. Uses
 * adminGet so the x-admin-key header rides along when configured (the data
 * comes from the admin PaperTrade ledger).
 */
export function getExecutionSummary(): Promise<ExecutionSummaryResponse> {
  return adminGet<ExecutionSummaryResponse>('/api/execution/summary');
}
