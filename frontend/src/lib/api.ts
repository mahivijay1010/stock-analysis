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
  CommitteeLatestResponse,
  DailyForecastResponse,
  DecisionResponse,
  HoldingsProjectionResponse,
  MonthForecastResponse,
  PortfolioOverviewResponse,
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
  VolForecastResponse,
  WatchlistItem,
  LiveFeedRow,
  LiveFeedStatus,
  IntradaySnapshot,
  LiveDetail,
  EvidenceBundle,
  JournalBundle,
  UpstoxAuthStatus,
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
  // X-Requested-With is the CSRF defense-in-depth token the backend requires on
  // every mutating request (a cross-origin page cannot attach custom headers).
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
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

/** POST /api/auth/login — the backend's single-owner auth takes { username, password }. */
export async function login(req: LoginRequest): Promise<AuthAccount> {
  const data = await post<unknown>('/api/auth/login', { username: req.email, password: req.password });
  return readAccount(data);
}

/** POST /api/auth/passcode — admin fast-path: a single passcode logs in as the owner. */
export async function loginWithPasscode(passcode: string): Promise<AuthAccount> {
  const data = await post<unknown>('/api/auth/passcode', { passcode });
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

/** DELETE /api/watchlist/:id — never deletes holdings or their history. */
export function removeWatchlistItem(id: number | string): Promise<unknown> {
  return del<unknown>(`/api/watchlist/${encodeURIComponent(String(id))}`);
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

/** Maps the UI's field names onto the ledger API's RecordTransactionInput shape. */
function toTransactionBody(req: NewTransactionRequest): Record<string, unknown> {
  const { executedAt, priceEstimated, ...rest } = req;
  return { ...rest, tradeDate: executedAt, useClosingPriceEstimate: priceEstimated };
}

/** POST /api/transactions — idempotency key makes retries and CSV re-imports safe. */
export function createTransaction(req: NewTransactionRequest): Promise<unknown> {
  return post<unknown>('/api/transactions', toTransactionBody(req));
}

/** POST /api/transactions/:id/correct with edited values — supersedes the original; never edits it in place. */
export function correctTransaction(id: number | string, req: NewTransactionRequest): Promise<unknown> {
  return post<unknown>(`/api/transactions/${encodeURIComponent(String(id))}/correct`, toTransactionBody(req));
}

/**
 * POST /api/transactions/:id/correct with a note only — a pure void ("remove
 * this mistaken entry"). No replacement is recorded; the position simply
 * nets back to what it would be if the entry never happened.
 */
export function removeTransaction(id: number | string, note?: string): Promise<unknown> {
  return post<unknown>(`/api/transactions/${encodeURIComponent(String(id))}/correct`, note ? { note } : {});
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

/* ------------------------------------------------------------------ */
/* Phase C — immutable forecasts (spec §5). GETs read stored issuances */
/* only; POST /issue creates a NEW immutable issuance (auth).          */
/* ------------------------------------------------------------------ */

/** GET /api/forecast/:ticker/daily — latest stored next-30-calendar-days issuance. */
export function getDailyForecast(ticker: string): Promise<DailyForecastResponse> {
  return get<DailyForecastResponse>(`/api/forecast/${encodeURIComponent(ticker)}/daily`);
}

/** GET /api/forecast/:ticker/month/:period — original snapshot vs latest outlook vs actuals. */
export function getMonthForecast(ticker: string, period: string): Promise<MonthForecastResponse> {
  return get<MonthForecastResponse>(
    `/api/forecast/${encodeURIComponent(ticker)}/month/${encodeURIComponent(period)}`,
  );
}

/** POST /api/forecast/:ticker/issue — on-demand issuance (idempotent per anchor session). */
export function issueForecast(ticker: string): Promise<unknown> {
  return post<unknown>(`/api/forecast/${encodeURIComponent(ticker)}/issue`, {});
}

/** GET /api/holdings/projection — positions transformed through their own forecast distributions. */
export function getHoldingsProjection(): Promise<HoldingsProjectionResponse> {
  return get<HoldingsProjectionResponse>('/api/holdings/projection');
}

/** GET /api/portfolio/overview — the unified watchlist+holdings screen in one read. */
export function getPortfolioOverview(): Promise<PortfolioOverviewResponse> {
  return get<PortfolioOverviewResponse>('/api/portfolio/overview');
}

/** GET /api/decision/:ticker — the latest published evidence-gated decision snapshot. */
export function getDecision(ticker: string): Promise<DecisionResponse> {
  return get<DecisionResponse>(`/api/decision/${encodeURIComponent(ticker)}`);
}

/** GET /api/decision/:ticker/committee — latest stored AI-committee review. */
export function getCommitteeReview(ticker: string): Promise<CommitteeLatestResponse> {
  return get<CommitteeLatestResponse>(`/api/decision/${encodeURIComponent(ticker)}/committee`);
}

/** Phase 14 row-chip summary of a published decision snapshot. */
export interface DecisionBatchEntry {
  decisionStatus: 'BUY_CANDIDATE' | 'WAIT' | 'AVOID_NEW_ENTRY' | 'INSUFFICIENT_EVIDENCE';
  evidenceStatus: string;
  setupScore: number | null;
  entryQualityScore: number | null;
  confidenceBand: string | null;
  confidenceScore: number | null;
  modelHealthState: string | null;
  unmetGateCount: number;
  asOf: string;
  expired: boolean;
}

/** GET /api/decision/batch — latest published summaries for many tickers (absent = not published). */
export function getDecisionBatch(tickers: string[]): Promise<{ decisions: Record<string, DecisionBatchEntry> }> {
  return get<{ decisions: Record<string, DecisionBatchEntry> }>('/api/decision/batch', {
    tickers: tickers.join(','),
  });
}

/** POST /api/decision/:ticker/committee — request a fresh committee review (auth). */
export function runCommitteeReview(
  ticker: string,
  userContext?: { holdsPosition?: boolean; purchasePrice?: number | null; investmentHorizon?: string | null; riskTolerance?: string | null },
): Promise<unknown> {
  return post<unknown>(`/api/decision/${encodeURIComponent(ticker)}/committee`, userContext ?? {});
}

/* ---- OpenAI-first upgrade (O8/O9): vintages, drift, events, AI roles ---- */

export interface VintageSummaryView {
  runId: string;
  issuedAt: string;
  anchorSessionDate: string;
  anchorPrice: number;
  medianAtToday: number | null;
  p10AtToday: number | null;
  p90AtToday: number | null;
  medianReturnPct30: number | null;
  insideBand80: boolean | null;
  errorPct: number | null;
}

export interface DriftAssessmentView {
  version: string;
  ticker: string;
  asOf: string;
  currentPrice: number | null;
  original: VintageSummaryView | null;
  current: VintageSummaryView | null;
  drift: {
    state: 'NORMAL' | 'DRIFTING' | 'INVALIDATED';
    reasons: string[];
    distanceAtr: number | null;
    distanceSigma: number | null;
    regimeChanged: boolean;
    materialEventArrived: boolean;
    volumeAnomaly: boolean;
  } | null;
}

export function getForecastVintage(ticker: string): Promise<DriftAssessmentView> {
  return get<DriftAssessmentView>(`/api/forecast/${encodeURIComponent(ticker)}/vintage`);
}

export interface StructuredEventView {
  id: string;
  eventType: string;
  eventDate: string;
  announcedAt: string;
  source: string;
  sourceTier: number;
  headline: string | null;
  url: string | null;
}

export function getStructuredEvents(ticker: string): Promise<{ events: StructuredEventView[] }> {
  return get<{ events: StructuredEventView[] }>(`/api/events/${encodeURIComponent(ticker)}`);
}

export interface AiRoleRow {
  response: Record<string, unknown>;
  createdAt: string;
  model: string;
  validationResult: string | null;
}

export function getAiRoles(ticker: string): Promise<{ roles: Record<string, AiRoleRow | null> }> {
  return get<{ roles: Record<string, AiRoleRow | null> }>(`/api/ai/${encodeURIComponent(ticker)}`);
}

/* ---- Short-Term Trade Radar ---- */

export interface StScanParams {
  budgetInr?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  horizon?: '1-3d' | '3-5d' | '5-10d' | '10-21d';
  riskPerTradePct?: number;
  strategy?: 'ALL' | 'PULLBACK' | 'BREAKOUT' | 'MOMENTUM' | 'MEAN_REVERSION';
  sector?: string | null;
  aiDepth?: 'AUTO' | 'LOCAL_ONLY' | 'LOW_COST' | 'DEEP_REVIEW';
  limit?: number;
}

export interface StCandidate {
  rank: number | null;
  ticker: string;
  name: string;
  sector: string;
  currentPrice: number | null;
  freshness: { state: 'LIVE' | 'DELAYED' | 'STALE'; lastUpdate: string | null; providerNote: string };
  action: string;
  state: string;
  setupType: string;
  setupScore: number;
  entryQuality: number | null;
  modelHealth: string;
  dataQuality: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  whyCandidate: string[];
  whatCanGoWrong: string[];
  changedSincePrevious: string[] | null;
  plan: Record<string, number | string | null> & {
    entryType: string;
    entryZoneLow: number | null;
    entryZoneHigh: number | null;
    entryTrigger: string | null;
    initialStop: number | null;
    stopBasis: string | null;
    target1: number | null;
    target2: number | null;
    rewardRiskToTarget1: number | null;
    expectedValueAfterCostsPct: number | null;
    expectedHoldingDays: number;
    invalidationReason: string | null;
    transactionCostPct: number;
    estimatedSlippagePct: number;
  };
  sizing: {
    riskAmount: number;
    riskPerShare: number | null;
    positionSizeShares: number;
    capitalRequired: number;
    capitalRemaining: number;
    constraintsApplied: string[];
    lossAtStop: number | null;
  } | null;
  forecast: {
    expectedExcessReturnPct: number | null;
    p10Pct: number | null;
    p50Pct: number | null;
    p90Pct: number | null;
    probabilityTargetBeforeStop: number | null;
    probabilityStatement: string;
    modelConfidence: string;
  };
  gates: { passed: boolean; failures: Array<{ gate: string; current: string; required: string }> };
  rankingScore: number | null;
  // ── V2 fields ──
  tier?: string;
  qualified?: boolean;
  geometryAction?: string;
  freshnessV2?: string;
  whyNotEntry?: string[];
  ceilingReasons?: string[];
  confirmation?: { satisfied: boolean; met: string[]; unmet: string[] } | null;
  contradictions?: Array<{ code: string; message: string; cap: string }>;
  ev?: {
    meanEvAfterCostsPct: number;
    ev80LowerPct: number;
    ev95LowerPct: number;
    expectedR: number;
    cvarR: number;
    p10R: number;
    targetReachRate: number;
    stopHitRate: number;
    probabilityEvPositive: number;
  } | null;
  setupEvidence?: {
    evidenceStrength: string;
    usableForEntry: boolean;
    expectancyAfterCosts: number;
    independentEntryDates: number;
    note: string;
  } | null;
  plausibility?: { target1DistanceAtr: number | null; target1ReachRate: number | null; stopDistanceAtr: number | null; stopNoiseRate: number | null; reasons: string[] } | null;
}

export interface StScanResult {
  scanRunId: string;
  params: Required<StScanParams>;
  marketStatus: { session: string; istTime: string; lastCompletedSession: string | null };
  riskManager: { newEntriesAllowed: boolean; reasons: string[]; openRiskInr: number; openPositions: number };
  candidates: StCandidate[];
  watchlist: StCandidate[];
  universeSize: number;
  passedGates: number;
  qualifiedCount: number;
  watchlistCount: number;
  emptyMessage: string | null;
}

export interface StModelLab {
  available: boolean;
  setupEvidence: { cells: Array<Record<string, unknown>>; verdict: string | null; asOf: string } | null;
  shadow: Array<{ metrics: Record<string, unknown>; verdict: string | null }>;
}

export function getShortTermModelLab(): Promise<StModelLab> {
  return get<StModelLab>('/api/short-term/model-lab');
}

export function runShortTermRevalidate(ticker: string): Promise<{
  ticker: string;
  ok: boolean;
  referencePrice: number | null;
  freshness: string;
  gap: { decision: string; reason: string; gapAtr: number | null };
  vetoes: string[];
  recommendation: string;
}> {
  return post(`/api/short-term/${encodeURIComponent(ticker)}/revalidate`, {});
}

export function runShortTermScan(params: StScanParams): Promise<StScanResult> {
  return post<StScanResult>('/api/short-term/scan', params);
}

export function getShortTermDetail(ticker: string): Promise<{
  candidate: StCandidate;
  state: string;
  evaluatedAt: string;
  transitions: Array<{ fromState: string; toState: string; reason: string; createdAt: string }>;
}> {
  return get(`/api/short-term/${encodeURIComponent(ticker)}`);
}

export interface StAiReview {
  state: string;
  confidence: string;
  whyCandidate: string[];
  whyNotCandidate: string[];
  entrySummary: string;
  exitSummary: string;
  riskSummary: string;
  missingEvidence: string[];
  whatWouldImproveSetup: string[];
  whatWouldInvalidateSetup: string[];
  provider: string;
  model: string;
  clamped: boolean;
  clampNote: string | null;
}

export function runShortTermReview(
  ticker: string,
  body: { depth?: string; question?: string; budgetInr?: number; riskPerTradePct?: number }
): Promise<{ review: StAiReview }> {
  return post(`/api/short-term/${encodeURIComponent(ticker)}/review`, body);
}

export function getShortTermAiUsage(): Promise<{
  usage: { todayUsd: number; monthUsd: number; dailyBudgetUsd: number; monthlyBudgetUsd: number; calls: Record<string, number>; cacheHitPct: number | null };
  mode: string;
}> {
  return get('/api/short-term/ai-usage');
}

// ── Live market feed (STREAMING) ─────────────────────────────────────────────

/** Feed lifecycle + health. Reads are open; start/stop need a session. */
export function getLiveStatus(): Promise<LiveFeedStatus> {
  return get<LiveFeedStatus>('/api/live/status');
}

export function getLiveRows(): Promise<{ rows: LiveFeedRow[]; status: LiveFeedStatus }> {
  return get<{ rows: LiveFeedRow[]; status: LiveFeedStatus }>('/api/live/rows');
}

export function startLiveFeed(tickers?: string[]): Promise<LiveFeedStatus> {
  return post<LiveFeedStatus>('/api/live/start', tickers ? { tickers } : {});
}

export function stopLiveFeed(): Promise<LiveFeedStatus> {
  return post<LiveFeedStatus>('/api/live/stop', {});
}

/** Live 1m/5m forecasts, returned together with their measured scorecard. */
export function getIntradayForecasts(): Promise<IntradaySnapshot> {
  return get<IntradaySnapshot>('/api/live/forecasts');
}

/** Everything known about one ticker: quote, candles, forecasts, results. */
export function getLiveDetail(ticker: string): Promise<LiveDetail> {
  return get<LiveDetail>(`/api/live/detail/${encodeURIComponent(ticker)}`);
}

/**
 * The evidence ledger. One round trip; the backend orders wrong predictions
 * first so the client never has to decide what to surface.
 */
export function getEvidence(limit = 200): Promise<EvidenceBundle> {
  return get<EvidenceBundle>(`/api/evidence?limit=${limit}`);
}

/** The learning journal: pre-registered expectations and the lessons drawn. */
export function getJournal(limit = 200): Promise<JournalBundle> {
  return get<JournalBundle>(`/api/journal?limit=${limit}`);
}

/** Upstox authorization state — never returns the token itself. */
export function getUpstoxAuthStatus(): Promise<UpstoxAuthStatus> {
  return get<UpstoxAuthStatus>('/api/auth/upstox/status');
}
