import axios, { AxiosInstance } from 'axios';
import type {
  AccuracyResponse,
  AdminAccountResponse,
  AdminSettingsRequest,
  AnalyzeResponse,
  AuthAccount,
  AuthStatus,
  CalibrationResponse,
  ChartRange,
  ChartResponse,
  TopPicksResponse,
  ForecastLocksResponse,
  HoldingsResponse,
  LoginRequest,
  NewTransactionRequest,
  NewWatchlistItemRequest,
  PredictionAuditResponse,
  RankUniverseResponse,
  RecordTradeRequest,
  ResearchBrief,
  SearchResult,
  TransactionRecord,
  UniverseStockRow,
  UpdateWatchlistItemRequest,
  VolForecastResponse,
  WatchlistItem,
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

/** True when the failure means "this endpoint has not shipped yet" (B2 slice pending). */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** True when the failure means "not signed in". */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

const http: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
  // Session-cookie auth for the private watchlist/holdings routes (plan §8 Q1).
  withCredentials: true,
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

async function patch<T>(url: string, body: unknown): Promise<T> {
  try {
    const res = await http.patch<ApiEnvelope<T>>(url, body);
    return unwrap(res.data, res.status);
  } catch (err) {
    throw normalizeError(err);
  }
}

async function del<T>(url: string): Promise<T> {
  try {
    const res = await http.delete<ApiEnvelope<T>>(url);
    return unwrap(res.data, res.status);
  } catch (err) {
    throw normalizeError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

/** GET /health — powers the honest topbar status (never a hardcoded "systems normal"). */
export async function getHealth(): Promise<{ status: string; db?: boolean; timestamp?: string }> {
  return get<{ status: string; db?: boolean; timestamp?: string }>('/health');
}

/* ------------------------------------------------------------------ */
/* Public research / discovery / track record                          */
/* ------------------------------------------------------------------ */

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

/** GET /api/accuracy — the public track record's aggregate walk-forward stats. */
export function getAccuracy(): Promise<AccuracyResponse> {
  return get<AccuracyResponse>('/api/accuracy');
}

/** GET /api/calibration — Brier calibration (backtest + live). Callers hide the section on 404. */
export function getCalibration(): Promise<CalibrationResponse> {
  return get<CalibrationResponse>('/api/calibration');
}

/** GET /api/research/:ticker — deterministic research brief (read-only since B1). */
export function getResearchBrief(ticker: string): Promise<ResearchBrief> {
  return get<ResearchBrief>(`/api/research/${encodeURIComponent(ticker)}`);
}

/** GET /api/stocks — the covered NSE universe (Discover). */
export function getStocks(): Promise<UniverseStockRow[]> {
  return get<UniverseStockRow[]>('/api/stocks');
}

/** GET /api/rank/universe — cross-sectional composite ranks (Discover's momentum sort; ~90s cold). */
export function getRankUniverse(): Promise<RankUniverseResponse> {
  return get<RankUniverseResponse>('/api/rank/universe');
}

/** GET /api/volatility/forecast/:ticker — HAR/HAR-X vol forecast, labeled diagnostic. */
export function getVolForecast(ticker: string): Promise<VolForecastResponse> {
  return get<VolForecastResponse>(`/api/volatility/forecast/${encodeURIComponent(ticker)}`);
}

/* ------------------------------------------------------------------ */
/* B2 — accounts / auth (session cookie; endpoints may land after this */
/* UI ships — every consumer treats 404 as "backend slice pending").   */
/* ------------------------------------------------------------------ */

function readAccount(raw: unknown): AuthAccount {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const inner = (o.account ?? o.user ?? o) as Record<string, unknown>;
    return {
      id: (inner.id as number | string | undefined) ?? undefined,
      email: (inner.email as string | undefined) ?? null,
      name: (inner.name as string | undefined) ?? null,
    };
  }
  return {};
}

/**
 * GET /api/auth/me → authenticated | unauthenticated | unavailable.
 * 401/403 = not signed in; 404 = the accounts backend has not shipped yet
 * (no fake login wall — private views degrade honestly instead).
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  try {
    const data = await get<unknown>('/api/auth/me');
    return { status: 'authenticated', account: readAccount(data) };
  } catch (err) {
    if (isUnauthorized(err)) return { status: 'unauthenticated' };
    if (isNotFound(err)) {
      return {
        status: 'unavailable',
        note: 'The accounts service has not shipped on this backend yet (upgrade slice B2). Private views run unauthenticated against the local single-user backend until it lands.',
      };
    }
    throw err;
  }
}

/** POST /api/auth/login */
export async function login(req: LoginRequest): Promise<AuthAccount> {
  const data = await post<unknown>('/api/auth/login', req);
  return readAccount(data);
}

/** POST /api/auth/logout */
export function logout(): Promise<unknown> {
  return post<unknown>('/api/auth/logout', {});
}

/* ------------------------------------------------------------------ */
/* B2 — watchlist ("I follow this stock"; removing an item NEVER       */
/* touches holdings or history)                                        */
/* ------------------------------------------------------------------ */

function readItems<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

/** GET /api/watchlist */
export async function getWatchlist(): Promise<WatchlistItem[]> {
  const raw = await get<unknown>('/api/watchlist');
  return readItems<WatchlistItem>(raw, 'items');
}

/** POST /api/watchlist */
export function addWatchlistItem(req: NewWatchlistItemRequest): Promise<unknown> {
  return post<unknown>('/api/watchlist', req);
}

/** PATCH /api/watchlist/items/:id */
export function updateWatchlistItem(id: number | string, req: UpdateWatchlistItemRequest): Promise<unknown> {
  return patch<unknown>(`/api/watchlist/items/${encodeURIComponent(String(id))}`, req);
}

/** DELETE /api/watchlist/items/:id — never deletes holdings or their history. */
export function removeWatchlistItem(id: number | string): Promise<unknown> {
  return del<unknown>(`/api/watchlist/items/${encodeURIComponent(String(id))}`);
}

/* ------------------------------------------------------------------ */
/* B2 — transactions / holdings (immutable ledger; FIFO lots;          */
/* corrections are linked records, never in-place edits)               */
/* ------------------------------------------------------------------ */

/** GET /api/holdings — positions derived from the transaction ledger. */
export async function getHoldings(): Promise<HoldingsResponse> {
  const raw = await get<unknown>('/api/holdings');
  if (Array.isArray(raw)) return { positions: raw as HoldingsResponse['positions'] };
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    positions: readItems<HoldingsResponse['positions'][number]>(raw, 'positions'),
    totals: (o.totals as HoldingsResponse['totals']) ?? null,
    asOf: (o.asOf as string | undefined) ?? null,
    note: (o.note as string | undefined) ?? null,
  };
}

/** GET /api/transactions — full history including corrections. */
export async function listTransactions(): Promise<TransactionRecord[]> {
  const raw = await get<unknown>('/api/transactions');
  return readItems<TransactionRecord>(raw, 'transactions');
}

/** POST /api/transactions — idempotency key makes retries and CSV re-imports safe. */
export function createTransaction(req: NewTransactionRequest): Promise<unknown> {
  return post<unknown>('/api/transactions', req);
}

/** POST /api/transactions/:id/correct — supersedes the original; never edits it in place. */
export function correctTransaction(id: number | string, req: NewTransactionRequest): Promise<unknown> {
  return post<unknown>(`/api/transactions/${encodeURIComponent(String(id))}/correct`, req);
}

/* ------------------------------------------------------------------ */
/* Sandbox (old paper trading desk — secondary navigation; x-admin-key */
/* sent only when NEXT_PUBLIC_ADMIN_KEY is configured).                */
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

/** GET /api/admin/prediction-audit — live predictions vs reality, trade review, loss guard. */
export function getPredictionAudit(): Promise<PredictionAuditResponse> {
  return adminGet<PredictionAuditResponse>('/api/admin/prediction-audit');
}

/**
 * GET /api/admin/forecast-locks — every BUY freezes its purchase-day 7d/30d
 * forecast into the trade; this tracks live price vs the frozen band and
 * grades matured horizons against the real close on the target date. Locks
 * are never recomputed.
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

/**
 * POST /api/admin/account/settings — currently rejected by the backend with an
 * honest 400 (the destructive reset path was removed pending rework). The UI
 * surfaces that server message verbatim.
 */
export async function updateAdminSettings(req: AdminSettingsRequest): Promise<AdminAccountResponse> {
  try {
    const res = await http.post<ApiEnvelope<AdminAccountResponse>>('/api/admin/account/settings', req, adminConfig());
    return unwrap(res.data, res.status);
  } catch (err) {
    throw normalizeError(err);
  }
}

/** GET /api/stocks/:ticker/chart?range= (Stock Detail price history). */
export function getStockChart(ticker: string, range: ChartRange): Promise<ChartResponse> {
  return get<ChartResponse>(`/api/stocks/${encodeURIComponent(ticker)}/chart`, { range });
}

/** GET /api/top-picks?count&maxPrice (Discover ranked scan). */
export function getTopPicks(count = 5, maxPrice?: number | null): Promise<TopPicksResponse> {
  const params: Record<string, string | number> = { count };
  if (maxPrice != null) params.maxPrice = maxPrice;
  return get<TopPicksResponse>('/api/top-picks', params);
}
