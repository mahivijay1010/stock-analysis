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
  PredictionLedger,
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

async function put<T>(url: string, body: unknown): Promise<T> {
  try {
    const res = await http.put<ApiEnvelope<T>>(url, body);
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

// ── Predicted vs happened (GET /api/evidence/outcome-review) ─────────────────
export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  predictedMean: number | null;
  actualRate: number | null;
  wilsonLo: number | null;
  wilsonHi: number | null;
  withheld: boolean;
}
export interface CalibrationReport {
  n: number;
  bins: CalibrationBin[];
  brier: number | null;
  ece: number | null;
  overallPredictedMean: number | null;
  overallActualRate: number | null;
  reliability: 'WELL_CALIBRATED' | 'OVERCONFIDENT' | 'UNDERCONFIDENT' | 'INSUFFICIENT';
  headline: string;
}
export interface CohortRate {
  key: string;
  n: number;
  hitRatePct: number;
  wilsonLb95Pct: number;
  meanActualReturnPct: number | null;
}
export interface SurpriseRow {
  ticker: string;
  recommendation: string;
  predictedReturnPct: number | null;
  actualReturnPct: number | null;
  surprisePct: number;
  kind: string;
  outcomeDate: string | null;
}
export interface LaneMaturity {
  lane: string;
  logged: number;
  graded: number;
  note: string;
}
export interface OutcomeReview {
  version: string;
  generatedAt: string;
  laneA: {
    graded: number;
    overallHitRatePct: number | null;
    overallHitWilsonLb95Pct: number | null;
    meanPredictedReturnPct: number | null;
    meanActualReturnPct: number | null;
    band80CoveragePct: number | null;
    calibration: CalibrationReport;
    byRecommendation: CohortRate[];
    byHorizon: CohortRate[];
    surprises: SurpriseRow[];
  };
  lanes: LaneMaturity[];
  headline: string;
  caveat: string;
}

export function getOutcomeReview(): Promise<OutcomeReview> {
  return get<OutcomeReview>('/api/evidence/outcome-review');
}

/** Filtered ledger page: grade (WRONG/CORRECT/PENDING) and/or ticker prefix.
 *  Totals in the response always stay whole-table — a filter narrows the rows,
 *  never the denominator. */
export function getEvidencePredictions(params: {
  limit?: number;
  grade?: 'WRONG' | 'CORRECT' | 'PENDING';
  ticker?: string;
  recommendation?: 'BUY' | 'HOLD' | 'AVOID' | 'NOT_AVOID';
}): Promise<PredictionLedger> {
  const q = new URLSearchParams({ limit: String(params.limit ?? 200) });
  if (params.grade) q.set('grade', params.grade);
  if (params.ticker) q.set('ticker', params.ticker);
  if (params.recommendation) q.set('recommendation', params.recommendation);
  return get<PredictionLedger>(`/api/evidence/predictions?${q.toString()}`);
}

/** The learning journal: pre-registered expectations and the lessons drawn. */
export function getJournal(limit = 200): Promise<JournalBundle> {
  return get<JournalBundle>(`/api/journal?limit=${limit}`);
}

/** Upstox authorization state — never returns the token itself. */
export function getUpstoxAuthStatus(): Promise<UpstoxAuthStatus> {
  return get<UpstoxAuthStatus>('/api/auth/upstox/status');
}

/* ------------------------------------------------------------------ */
/* Wide-universe sub-₹100 screen (descriptive — tradeability, no direction) */
/* ------------------------------------------------------------------ */

export interface WideFact {
  sentiment?: string | null;
  materiality?: string | null;
  kind: string;
  fact: string;
  sourceKind: string;
  sourceUrl: string | null;
  observedAt: string;
  confidence: string;
}

export interface WideStock {
  symbol: string;
  companyName: string | null;
  industry: string | null;
  indices: string[];
  listingDate: string | null;
  asOf: string;
  price: number;
  medianTurnoverLacs20: number | null;
  medianTrades20: number | null;
  avgDelivPct60: number | null;
  delivTrendPp: number | null;
  ret20Pct: number | null;
  ret60Pct: number | null;
  ret250Pct: number | null;
  vol60AnnPct: number | null;
  maxDrawdown1yPct: number | null;
  pctFrom1yHigh: number | null;
  corporateActionSuspect: boolean;
  passed: boolean;
  exclusions: string[];
  rank: { liquidity: number; stability: number; score: number } | null;
  facts: WideFact[];
  flags: string[];
}

export interface WideScreenReport {
  screen: {
    version: string;
    asOf: string;
    rules: { maxPrice: number; minPrice: number; minSessions: number; minMedianTurnoverLacs: number; minMedianTrades: number };
    universeSize: number;
    under100: number;
    passed: number;
    caveat: string;
  };
  generatedAt: string;
  evidenceStatus: string;
  stocks: WideStock[];
  excludedSummary: Record<string, number>;
  knowledgeCoverage: { withFacts: number; total: number };
}

/** GET /api/short-term/wide-screen — every NSE company at or below `maxPrice` through the tradeability screen. */
export function getWideScreen(maxPrice?: number): Promise<WideScreenReport> {
  return get<WideScreenReport>('/api/short-term/wide-screen', maxPrice ? { maxPrice } : undefined);
}

export interface WideReferenceLevels {
  close: number;
  support20: number;
  resistance20: number;
  low52w: number;
  high52w: number;
  atr14: number;
  atrPct: number;
  volatilityStop: number;
  asOf: string;
}

export interface RecommendationScore {
  score: number;
  components: { setup: number; tradeability: number; knowledge: number };
  reasons: string[];
  cautions: string[];
}

export interface WideScanRow {
  symbol: string;
  ticker: string;
  evaluation: StCandidate | null;
  reference: WideReferenceLevels | null;
  decision: { newBuyer: 'BUY' | 'WAIT' | 'WATCH' | 'NO TRADE'; holder: 'HOLD' | 'EXIT' | 'TRAIL' | 'TAKE PARTIAL'; why: string };
  recommendation: RecommendationScore;
  rank: number;
}

export interface WideScanResult {
  scanRunId: string;
  marketSession: string;
  evaluated: number;
  qualifiedCount: number;
  riskManager: { newEntriesAllowed: boolean; reasons: string[] };
  rows: WideScanRow[];
  tradeable: WideScanRow[];
  watch: WideScanRow[];
  note: string;
}

/** POST /api/short-term/wide-scan — the radar's full pipeline over the sub-₹100 wide screen. */
export function runWideScan(params: StScanParams): Promise<WideScanResult> {
  return post<WideScanResult>('/api/short-term/wide-scan', params);
}

// ── Conviction Board (GET /api/short-term/conviction-board) ───────────────────
// Sub-₹100 picks tiered HIGH/MEDIUM/LOW by EVIDENCE strength + reward:risk —
// NOT a probability of profit. A HIGH tier is the most complete setup available,
// never a guarantee; 'buyGrade' is the fail-closed bar every gate must clear.
export type ConvictionTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ScoredConviction {
  symbol: string;
  ticker: string;
  companyName: string | null;
  industry: string | null;
  price: number | null;
  setupType: string;
  decision: string;
  tier: ConvictionTier;
  score: number;
  components: { actionability: number; rewardRisk: number; expectedValue: number; aiRisk: number; tradeability: number };
  rewardRiskToT1: number | null;
  evAfterCostsPct: number | null;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  aiCapAction: 'AFFIRM' | 'CAP_TO_WATCH' | 'CAP_TO_NO_TRADE' | null;
  aiRedFlags: number;
  buyGrade: boolean;
  tradeabilityBlocked: boolean;
  tradeabilityReasons: string[];
  liquidity: {
    medianDailyValueInr20d: number | null;
    daysToExitAt1crore: number | null;
    delivPct20d: number | null;
    deliveryDivergencePp: number | null;
    inferredCircuitBandPct: 5 | 10 | 20 | null;
  } | null;
  valuation: {
    verdict: string;
    dcfMarginOfSafetyPct: number | null;
    valueScore: number | null;
    isValueTrap: boolean;
    pe: number | null;
    pb: number | null;
    roce: number | null;
    trapFlags: string[];
  } | null;
  reasons: string[];
}

// ── Valuation / quality (GET /api/short-term/valuation) ──────────────────────
export interface ValuationRow {
  ticker: string;
  symbol: string;
  price: number | null;
  verdict: string;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  roce: number | null;
  deRatio: number | null;
  dcfMarginOfSafetyPct: number | null;
  promoterHolding: number | null;
  promoterChangeQoq: number | null;
  valueScore: number | null;
  isValueTrap: boolean;
  trapFlags: string[];
  notes: string[];
}

export function getValuation(tickers?: string[]): Promise<{ rows: ValuationRow[]; note: string }> {
  const q = tickers && tickers.length ? `?tickers=${tickers.join(',')}` : '';
  return get<{ rows: ValuationRow[]; note: string }>(`/api/short-term/valuation${q}`);
}

export interface ConvictionBoard {
  version: string;
  generatedAt: string | null;
  /** The price ceiling (₹) the underlying scan used. */
  maxPrice: number | null;
  evaluated: number;
  buyGradeCount: number;
  tierCounts: { high: number; medium: number; low: number };
  high: ScoredConviction[];
  medium: ScoredConviction[];
  low: ScoredConviction[];
  regime?: { regime: string; reasons: string[]; realizedVolPct: number | null; drawdownPct: number | null; sizeMultiplier?: number; gateNote?: string } | null;
  circuitBreaker?: { state: string; canEnter: boolean; reason: string } | null;
  caveat: string;
  headline: string;
}

/** GET /api/short-term/conviction-board — the honest tiered sub-₹100 shortlist. */
export function getConvictionBoard(): Promise<ConvictionBoard> {
  return get<ConvictionBoard>('/api/short-term/conviction-board');
}

// ── Paper pilot (GET /api/short-term/paper-account) ──────────────────────────
export interface PaperAccountView {
  version: string;
  account: { name: string; startingCapitalInr: number; cashInr: number; lastCycleDate: string | null };
  equityInr: number;
  totalReturnPct: number;
  drawdownFromPeakPct: number;
  openPositions: Array<{ ticker: string; sector: string | null; qty: number; entry: number; stop: number; target: number; slippageBps: number; conviction: number | null; entryDate: string }>;
  closedTrades: Array<{ ticker: string; entry: number; exit: number | null; exitReason: string | null; pnlInr: number | null; realizedR: number | null; entryDate: string; exitDate: string | null }>;
  stats: { closed: number; winRatePct: number | null; expectancyR: number | null; realizedPnlInr: number; meanSlippageBps: number | null };
  equityCurve: Array<{ date: string; equityInr: number }>;
  caveat: string;
}

export function getPaperAccount(): Promise<PaperAccountView> {
  return get<PaperAccountView>('/api/short-term/paper-account');
}

// ── Global swing screen (GET /api/short-term/global-swing) ───────────────────
// International large caps (US / ADR / home-market) ranked by how well their PAST
// volatility, trend and liquidity fit a 10–15 trading-day swing profile.
// Descriptive only — UNPROVEN, no direction forecast, no demonstrated edge.
export type GlobalSwingTier = 'SHORTLIST' | 'WATCH' | 'AVOID';
export type GlobalMarket = 'US' | 'ADR' | 'EU' | 'JP' | 'HK' | 'KR' | 'TW' | 'OTHER';
export type GlobalAccess = 'US_BROKER' | 'ADR_ON_US' | 'HOME_MARKET_ONLY';

export interface GlobalSwingRow {
  ticker: string;
  name: string;
  market: GlobalMarket;
  sector: string;
  access: GlobalAccess;
  currency: string;
  price: number;
  asOf: string;
  bars: number;
  atrPct20: number;
  dailyVolPct20: number;
  typicalMove12dPct: number;
  ret20Pct: number;
  ret60Pct: number;
  ret120Pct: number;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  maxDrawdown120Pct: number;
  pos52w: number | null;
  avgValue20: number;
  earningsDate: string | null;
  earningsInWindow: boolean | null;
  earningsSource: 'finnhub' | 'manual' | null;
  plan: { entry: number; stop: number; target: number; stopPct: number; targetPct: number; rewardRisk: number };
  score: number;
  tier: GlobalSwingTier;
  reasons: string[];
  blocks: string[];
  roundTripCostPct: number;
}

export interface GlobalSwingContextRow {
  symbol: string;
  last: number;
  ret5Pct: number;
  ret20Pct: number;
  asOf: string;
}

export interface GlobalSwingBoard {
  generatedAt: string;
  windowTradingDays: [number, number];
  earningsWindowEnd: string;
  context: { spy: GlobalSwingContextRow | null; vix: GlobalSwingContextRow | null };
  shortlist: GlobalSwingRow[];
  watch: GlobalSwingRow[];
  avoid: GlobalSwingRow[];
  failed: Array<{ ticker: string; error: string }>;
  caveat: string;
  method: string[];
  evidence: { status: 'UNPROVEN'; gradedOutcomes: number; note: string };
}

/** GET /api/short-term/global-swing — cached 30 min server-side; refresh forces a rebuild. */
export function getGlobalSwing(refresh = false): Promise<GlobalSwingBoard> {
  return get<GlobalSwingBoard>('/api/short-term/global-swing', refresh ? { refresh: 1 } : undefined);
}

// ── Money Desk (GET /api/capital/today, POST /api/capital/simulate, …) ───────
// A capital-allocation layer over the short-term engine. It sizes already-
// qualified setups for the user's capital and profile, decides cash, and flags
// holdings to reduce/exit. Every number is a system recommendation on measured
// evidence — never a profit promise. Probability only when AVAILABLE.
export type RiskProfileName = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
export type CapitalHorizon = '3-5d' | '5-10d' | '10-21d';

export interface FreshnessContract {
  quoteTimestamp: string | null;
  quoteType: 'EOD_FINAL' | 'DELAYED_INTRADAY' | 'LIVE' | 'STALE' | 'UNKNOWN';
  marketState: 'OPEN' | 'CLOSED' | 'PRE_OPEN' | 'UNKNOWN';
  latestCompletedBarDate: string | null;
  providerDelay: string;
  featureCutoffAt: string | null;
}

export interface PlannedAllocation {
  ticker: string;
  name: string;
  sector: string | null;
  action: 'ALLOCATE' | 'WATCH';
  recommendedAmountInr: number;
  recommendedQuantity: number;
  maxAmountInr: number;
  percentageOfCapital: number;
  entryPrice: number;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  entryType: string;
  stopPrice: number;
  target1: number;
  target2: number | null;
  target3: number | null;
  expectedHoldingSessions: number;
  riskAmountInr: number;
  rewardRisk: number;
  evAfterCostsPct: number | null;
  ev80LowerPct: number | null;
  evidenceTier: string;
  evidenceScore: number | null;
  setupType: string;
  probability: { status: string; targetBeforeStop: number | null };
  reasonCodes: string[];
  riskReasons: string[];
  invalidationReasons: string[];
  sizingConstraints: string[];
  decisionSnapshotId: string | null;
  changesIf: string[];
  environment: { global: EnvLabel; india: EnvLabel; sector: EnvLabel; setup: 'PASS' | 'FAIL'; label: string; macroRiskMultiplier: number };
}

export interface RejectedCandidate {
  ticker: string;
  name: string;
  setupType: string;
  tier: string;
  action: string;
  reasonCodes: string[];
  whyNot: string[];
  gateFailures: Array<{ gate: string; current: string; required: string }>;
}

export interface WithdrawalDecision {
  ticker: string;
  name: string;
  action: 'HOLD' | 'TRAIL' | 'REDUCE' | 'EXIT';
  qty: number;
  currentValueInr: number | null;
  investedInr: number;
  pnlInr: number | null;
  pnlPct: number | null;
  recommendedRemainingInr: number | null;
  amountToWithdrawInr: number | null;
  qtyToSell: number | null;
  trailStopPrice: number | null;
  reasonCodes: string[];
  reasons: string[];
  invalidation: string[];
  evidenceAsOf: string | null;
}

export interface CashSummary {
  capitalAvailableInr: number;
  capitalInvestedInr: number;
  totalEquityInr: number;
  cashReserveInr: number;
  cashReservePct: number;
  recommendedDeploymentInr: number;
  recommendedCashInr: number;
  maxDeployableInr: number;
  riskBudgetInr: number;
  riskUsedInr: number;
  unusedRiskBudgetInr: number;
  whyCash: string[];
}

export interface ScenarioSummary {
  label: string;
  maxPortfolioLossInr: number;
  maxPortfolioLossPct: number;
  maxUpsideAtTarget1Inr: number;
  maxUpsideAtTarget1Pct: number;
  riskPerPositionInr: number[];
  concentrationLargestPct: number;
  positions: number;
}

export interface GlobalDiagnostics {
  snapshotAt: string | null; globalDataAsOf: string | null; indiaDataAsOf: string | null; scanned: number; valid: number;
  byRegion: Record<string, { valid: number; total: number }>; byAssetClass: Record<string, { valid: number; total: number }>;
  regime: string | null; regimeScore: number | null; transmission: string | null; indiaRegime: string | null;
  sectorImpacts: Array<{ sector: string; name: string; label: string; reason: string }>; activeShocks: string[]; note: string;
}

export interface ScanCoverage {
  global: GlobalDiagnostics;
  asOf: string | null;
  scanned: number;
  dataValid: number;
  liquid: number;
  technicalScreen: number;
  researchQualified: number;
  shortTermSetups: number;
  passedGates: number;
  riskQualified: number;
  modelHealthQualified: number;
  engineQualified: number;
  capitalAllocations: number;
  zeroBecause: string[];
  note: string;
}

export interface CapitalPlanResponse {
  coverage: ScanCoverage;
  version: string;
  policyVersion: string;
  asOf: string;
  riskProfile: RiskProfileName;
  horizon: CapitalHorizon;
  maxPositions: number;
  regime: { regime: string; reasons: string[]; sizeMultiplier: number };
  global: { regime: string | null; transmission: EnvLabel | null; macroRiskMultiplier: number; maxPositionsAfterMacro: number; policy: string; reasons: string[]; globalDataAsOf: string | null; indiaDataAsOf: string | null };
  circuitBreaker: { canEnter: boolean; reason: string | null };
  freshness: FreshnessContract;
  allocations: PlannedAllocation[];
  conditional: PlannedAllocation[];
  holds: WithdrawalDecision[];
  withdrawals: WithdrawalDecision[];
  rejected: RejectedCandidate[];
  cash: CashSummary;
  scenario: ScenarioSummary;
  summary: string;
  noNewAllocation: boolean;
  candidatesEvaluated: number;
  planId: string | null;
  persisted: boolean;
  modelHealth: { shortTermModel: string; note: string };
  evidence: { candidatesSource: string; scanRunIds: string[]; scanRunAt: string | null; note: string };
  scenarioNote?: string;
}

export interface DeskSettings {
  capitalAvailableInr: number;
  riskProfile: RiskProfileName;
  horizon: CapitalHorizon;
  maxPositions: number | null;
  dailySnapshot: boolean;
}

export interface DeskRequestParams {
  capital: number;
  profile: RiskProfileName;
  horizon: CapitalHorizon;
  maxPositions?: number;
}

export function getCapitalToday(p: DeskRequestParams): Promise<CapitalPlanResponse> {
  return get<CapitalPlanResponse>('/api/capital/today', {
    capital: p.capital,
    profile: p.profile,
    horizon: p.horizon,
    ...(p.maxPositions ? { maxPositions: p.maxPositions } : {}),
  });
}
export function simulateCapital(p: DeskRequestParams): Promise<CapitalPlanResponse> {
  return post<CapitalPlanResponse>('/api/capital/simulate', p);
}
export function getDeskSettings(): Promise<DeskSettings> {
  return get<DeskSettings>('/api/capital/settings');
}
export function putDeskSettings(s: Partial<DeskSettings>): Promise<DeskSettings> {
  return put<DeskSettings>('/api/capital/settings', s);
}
export function getCapitalHistory(limit = 20): Promise<{ plans: Array<{ id: string; kind: string; asOf: string; riskProfile: string; horizon: string; summary: string; deploymentInr: number; cashInr: number; regime: string }> }> {
  return get('/api/capital/history', { limit });
}

export interface RateStat { n: number; pct: number | null; wilsonLb95Pct: number | null }
export interface MeanStat { n: number; mean: number | null; ci95: [number, number] | null; median: number | null }
export interface CapitalMetrics {
  totalRecommendations: number;
  resolved: number;
  observed: number;
  notFilled: number;
  ambiguous: number;
  winRate: RateStat;
  avgReturnPct: MeanStat;
  medianReturnPct: number | null;
  profitFactor: number | null;
  expectancyR: number | null;
  maxDrawdownPct: number | null;
  mfeR: number | null;
  maeR: number | null;
  benchmarkExcessPct: MeanStat;
  withheld: boolean;
  withheldReason: string | null;
}
export interface CapitalTrackRecord {
  version: string;
  generatedAt: string;
  overall: CapitalMetrics;
  precision: Array<{ k: number; plans: number; precision: number | null; withheldReason: string | null }>;
  bySetupType: Array<{ key: string; metrics: CapitalMetrics }>;
  byHorizon: Array<{ key: string; metrics: CapitalMetrics }>;
  byRegime: Array<{ key: string; metrics: CapitalMetrics }>;
  byRiskProfile: Array<{ key: string; metrics: CapitalMetrics }>;
  bySector: Array<{ key: string; metrics: CapitalMetrics }>;
  byLiquidityBucket: Array<{ key: string; metrics: CapitalMetrics }>;
  byModelVersion: Array<{ key: string; metrics: CapitalMetrics }>;
  headline: string;
  caveat: string;
}
export function getCapitalTrackRecord(): Promise<CapitalTrackRecord> {
  return get<CapitalTrackRecord>('/api/capital/track-record');
}

// ── Model Lab (GET /api/model-lab, GET /api/model-lab/learning) ──────────────
export interface PromotionGate { id: string; rule: string; required: string; measured: string; passed: boolean | null }
export interface ModelLabView {
  version: string;
  generatedAt: string;
  pipeline: Array<{ stage: string; status: string; note: string }>;
  currentModels: Array<{ key: string; scope: string; state: string; updatedAt: string | null; reasons: string[] }>;
  experiments: Array<{ id: string; name: string; kind: string; modelVersion: string | null; status: string; startedAt: string | null; finishedAt: string | null; metrics: Record<string, unknown> | null; notes: string | null }>;
  promotions: Array<{ modelKey: string; from: string; to: string; reason: string; evidenceRunId: string | null; at: string }>;
  calibrators: Array<{ modelName: string; horizonDays: number; promoted: boolean; verdict: string | null; effectiveSamples: number | null; brierBefore: number | null; brierAfter: number | null }>;
  setupEvidence: { asOf: string | null; cells: Array<Record<string, unknown>>; verdict: string | null };
  shadowModels: Array<{ modelName: string; state: string; verdict: string | null; metrics: Record<string, unknown> }>;
  lessons: Array<{ category: string; observation: string; lesson: string; actionTaken: string; createdAt: string }>;
  capitalTrackRecord: CapitalTrackRecord;
  promotionGates: PromotionGate[];
  evidenceVerdict: string;
  policy: string[];
}
export function getModelLab(): Promise<ModelLabView> {
  return get<ModelLabView>('/api/model-lab');
}
export interface LearningFact { id: string; kind: 'FINDING' | 'INSUFFICIENT' | 'CONTEXT'; statement: string; metric: string; value: number | string | null; n: number; source: string }
export interface LearningReport {
  version: string;
  generatedAt: string;
  facts: LearningFact[];
  narrative: Array<{ text: string; cites: string[] }>;
  narrativeSource: 'deterministic' | 'llm' | 'llm-unavailable';
  evidenceStatus: string;
  caveat: string;
}
export function getLearningReport(ai = false): Promise<LearningReport> {
  return get<LearningReport>('/api/model-lab/learning', ai ? { ai: 1 } : undefined);
}

// ── Universe + Research Engine 2.0 (GET /api/universe/*) ─────────────────────
export interface UniverseHealth {
  version: string;
  generatedAt: string;
  securities: { total: number; active: number; tradable: number; tierA: number; tierB: number; tierC: number; excluded: number; byType: Record<string, number>; byCapBucket: Record<string, number>; surveillance: number };
  coverage: { computedAt: string | null; price: number; ohlcv: number; closeOnly: number; fundamentals: number; financialResults: number; corporateActions: number; announcements: number; news: number; technicalFeatures: number; meanScore: number | null; tradableWithTechnical: number };
  freshness: { deliveryAsOf: string | null; ohlcvAsOf: string | null; masterSyncedAt: string | null; coverageComputedAt: string | null };
  syncRuns: Array<{ job: string; source: string; status: string; startedAt: string; finishedAt: string | null; counts: Record<string, unknown>; error: string | null }>;
  providers: Array<{ provider: string; state: string; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null; calls: number; failures: number }>;
  failedSymbols: Array<{ symbol: string; reason: string }>;
  retryQueue: Array<{ symbol: string; reason: string }>;
  recentChanges: Array<{ symbol: string; changeType: string; oldValue: string | null; newValue: string | null; observedAt: string }>;
  caveat: string;
}
export interface FunnelStage { stage: string; entered: number; passed: number; reasons: Record<string, number> }
export interface ScanFunnel { scanId: string | null; asOf: string | null; regime: string | null; stages: FunnelStage[]; finalQualified: number; zeroBecause: string[]; durationMs: number; scanRunId: string | null }
export interface ScannerRow {
  symbol: string;
  company_name: string;
  sector: string | null;
  liquidity_tier: string;
  market_cap_bucket: string;
  stage_reached: string;
  rejected_at_stage: string | null;
  rejection_reasons: string[];
  signals: string[];
  features: Record<string, number | string | boolean | null>;
  technical_score: string | null;
  fundamental_score: string | null;
  event_score: string | null;
  research_evidence_score: string | null;
  liquidity_score: string | null;
  risk_score: string | null;
  model_health_score: string | null;
  screen_rank: number | null;
  setup_type: string | null;
  action: string | null;
  tier: string | null;
  decision_status: string | null;
  plan: Record<string, number | string | null> | null;
  coverage_score: string | null;
  ohlcv_available: boolean | null;
  fundamentals_available: boolean | null;
  news_available: boolean | null;
  research_status: string | null;
  researched_at: string | null;
}
export interface ScannerResult { scanId: string | null; asOf: string | null; regime: string | null; stages: FunnelStage[]; rows: ScannerRow[]; total: number; limit: number; sectors: string[] }
export type ScannerFilters = Partial<Record<'tier' | 'cap' | 'sector' | 'stage' | 'signal' | 'setup' | 'trend' | 'q' | 'sort', string>> & Partial<Record<'minPrice' | 'maxPrice' | 'minRelVol' | 'minTechnical' | 'minFundamental' | 'min52w' | 'maxVol' | 'limit', number>> & { recentEvent?: '1' };

export function getUniverseHealth(): Promise<UniverseHealth> { return get<UniverseHealth>('/api/universe/health'); }
export function getUniverseFunnel(): Promise<ScanFunnel> { return get<ScanFunnel>('/api/universe/funnel'); }
export function getScannerLatest(f: ScannerFilters = {}): Promise<ScannerResult> {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params[k] = v as string | number;
  return get<ScannerResult>('/api/universe/scan/latest', params);
}
export function runUniverseScan(body: { technicalKeep?: number; researchKeep?: number } = {}): Promise<{ funnel: ScanFunnel; queue: { queued: number } }> { return post('/api/universe/scan', body); }
export function runUniverseSync(): Promise<{ sync: Record<string, unknown>; coverage: Record<string, number> }> { return post('/api/universe/sync', {}); }
export interface ResearchQueueRow { symbol: string; priority: number; reasons: string[]; source: string; status: string; queuedAt: string; researchedAt: string | null; profileId: string | null }
export function getResearchQueue(): Promise<{ items: ResearchQueueRow[] }> { return get('/api/universe/research-queue'); }

export interface Sourced<T> { value: T; source: string; asOf: string | null }
export interface EvidenceItem { id: string; section: string; statement: string; value: number | string | null; source: string; sourceUrl: string | null; asOf: string | null; kind: 'FACT' }
export interface AiStatement { kind: 'FACT' | 'INFERENCE' | 'HYPOTHESIS'; text: string; cites: string[] }
export interface AiResearchOutput { promptVersion: string; modelVersion: string; researchVersion: string; timestamp: string; facts: AiStatement[]; inferences: AiStatement[]; hypotheses: AiStatement[]; dropped: number; dropReasons: string[] }
export interface ResearchProfile {
  symbol: string;
  researchVersion: string;
  builtAt: string;
  identity: { companyName: string; isin: string | null; exchange: string; series: string | null; instrumentType: string; sector: string | null; industry: string | null; marketCapBucket: string; marketCapSource: string | null; liquidityTier: string; listedDate: string | null; indices: string[] };
  business: { summary: Sourced<string> | null; segments: Sourced<string[]> | null; keyDrivers: Sourced<string[]> | null; majorRisks: Sourced<string[]> | null };
  fundamentals: Record<string, Sourced<number | null>>;
  valuation: { metrics: Record<string, Sourced<number | null>>; context: Sourced<string> | null };
  market: Record<string, Sourced<number | string | null>>;
  events: Array<{ kind: string; fact: string; eventDate: string | null; source: string; sourceUrl: string | null; observedAt: string }>;
  news: Array<{ kind: string; fact: string; sentiment: string | null; materiality: string | null; source: string; sourceUrl: string | null; observedAt: string }>;
  results: Array<{ periodEnd: string; periodType: string; concept: string; value: number; source: string }>;
  shortTerm: { evaluatedAt: string | null; setupType: string | null; action: string | null; tier: string | null; modelHealth: string | null; trend: string | null; entryZoneLow: number | null; entryZoneHigh: number | null; stop: number | null; target1: number | null; target2: number | null; rewardRisk: number | null; ev80LowerPct: number | null; support: number | null; resistance: number | null; whyNotEntry: string[]; source: string };
  coverage: { score: number | null; ohlcv: boolean; fundamentals: boolean; news: boolean; events: boolean; results: boolean };
  globalContext?: { globalRegime: string | null; indiaRegime: string | null; transmission: string | null; sectorLabel: string | null; sectorName: string | null; statements: Array<{ text: string; evidence: string }> };
  dataAsOf: Record<string, string | null>;
  gaps: string[];
}
export interface CompanyIntelligence {
  symbol: string;
  profile: ResearchProfile;
  evidence: EvidenceItem[];
  profileSource: 'built-now' | 'stored';
  profileBuiltAt: string;
  ai: AiResearchOutput | null;
  aiBuiltAt: string | null;
  decisionHistory: Array<{ plan_date: string; action: string; decision_status: string; recommended_amount_inr: string | null; entry_price: string | null; stop_price: string | null; target1: string | null; reason_codes: string[]; risk_profile: string; market_regime: string }>;
  scanHistory: Array<{ as_of: string; stage_reached: string; rejected_at_stage: string | null; rejection_reasons: string[]; signals: string[]; setup_type: string | null; action: string | null; tier: string | null; technical_score: string | null }>;
  risk: { liquidity_tier: string; liquidity_median_value_inr: string | null; surveillance: string | null; is_tradable: boolean; data_status: string } | null;
}
export function getCompanyIntelligence(symbol: string): Promise<CompanyIntelligence> { return get<CompanyIntelligence>(`/api/universe/company/${encodeURIComponent(symbol)}`); }
export function researchCompany(symbol: string, ai: boolean): Promise<{ profile: ResearchProfile; evidence: EvidenceItem[]; profileId: string | null; ai: AiResearchOutput | null; aiNote: string | null }> {
  return post(`/api/universe/research/${encodeURIComponent(symbol)}${ai ? '?ai=1' : ''}`, {});
}
export interface UniverseLearning extends CapitalTrackRecord {
  byCapBucket: Array<{ key: string; metrics: CapitalMetrics }>;
  byLiquidityTier: Array<{ key: string; metrics: CapitalMetrics }>;
  byVolRegime: Array<{ key: string; metrics: CapitalMetrics }>;
  byStage: Array<{ key: string; metrics: CapitalMetrics }>;
  statements: Array<{ text: string; n: number; metric: string }>;
}
export function getUniverseLearning(): Promise<UniverseLearning> { return get<UniverseLearning>('/api/universe/learning'); }

// ── Global Market Intelligence (GET /api/global/*) ───────────────────────────
export type EnvLabel = 'TAILWIND' | 'NEUTRAL' | 'HEADWIND' | 'STRESS';
export interface GlobalObservation {
  instrument: string; name: string; assetClass: string; region: string; sessionDate: string; exchangeTz: string; localCloseAt: string; utcCloseAt: string; marketStatus: string;
  price: number; return1d: number | null; return5d: number | null; return20d: number | null; chg5bps: number | null; chg20bps: number | null; volatility20: number | null; volume: number | null;
  source: string; sourceTimestamp: string | null; freshness: 'FRESH' | 'DELAYED' | 'STALE'; dataQuality: number; isYield: boolean;
}
export interface RegimeComponent { name: string; score: number | null; value: number | null; unit: string; reasons: string[]; covered: boolean; inputs: string[] }
export interface GlobalRegimeResult { regime: 'RISK_ON' | 'NEUTRAL' | 'CAUTIOUS' | 'RISK_OFF' | 'STRESSED'; score: number; components: RegimeComponent[]; reasons: string[]; dataCoverage: { covered: number; total: number; stale: number; missing: string[] } }
export interface SectorImpact { sector: string; name: string; label: EnvLabel; drivers: Array<{ driver: string; correlation: number | null; beta: number | null; n: number; activeShock: string | null; direction: 'UP' | 'DOWN' | null }>; reasons: string[] }
export interface GlobalPulse {
  id: string | null; cutoffUtc: string; indiaSessionDate: string; globalDataAsOf: string | null; indiaDataAsOf: string | null;
  observations: GlobalObservation[]; excludedForCutoff: Array<{ instrument: string; sessionDate: string; reason: string }>; missing: Array<{ instrument: string; reason: string }>;
  coverage: { scanned: number; valid: number; byRegion: Record<string, { valid: number; total: number }>; byAssetClass: Record<string, { valid: number; total: number }>; stale: number };
  regime: GlobalRegimeResult; india: { regime: string | null; reasons: string[]; diagnosis: { state: string; score: number; date: string } | null };
  transmission: { label: EnvLabel; reasons: string[]; evidence: Array<{ shock: string; n: number; medianPct: number | null; winRatePct: number | null; benchmarkMeanPct: number | null }>; activeShocks: string[] };
  sectors: SectorImpact[]; events: Array<{ event: string; region: string; scheduledAt: string; importance: string; expected: string | null; actual: string | null }>;
  empty?: boolean; note?: string;
}
export function getGlobalPulse(): Promise<GlobalPulse> { return get<GlobalPulse>('/api/global/pulse'); }
export function runGlobalSnapshot(): Promise<GlobalPulse> { return post<GlobalPulse>('/api/global/snapshot', {}); }
export interface ShockStudyRow { driver: string; shock: string; target: string; horizon: number; n: number; meanPct: number | null; medianPct: number | null; winRatePct: number | null; wilsonLb95Pct: number | null; volPct: number | null; maxDrawdownPct: number | null; benchmarkMeanPct: number | null; benchmarkN: number; displayable: boolean; dataFrom: string | null; dataTo: string | null }
export interface SensitivityRow { driver: string; target: string; n: number; correlation: number | null; beta: number | null; displayable: boolean; window: number; note: string }
export function getGlobalStudies(): Promise<{ shocks: Array<{ driver: string; label: string }>; minN: number; studies: ShockStudyRow[]; sensitivities: SensitivityRow[]; caveat: string }> { return get('/api/global/studies'); }
export interface RegimeTrackRecord { regimes: Array<{ regime: string; n: number; nifty: Record<string, { median: number | null; mean: number | null; winRatePct: number | null; n: number }>; sectors: Array<{ target: string; median5d: number | null; n: number }>; setups: Array<{ setupType: string; n: number; winRatePct: number | null; wilsonLb95Pct: number | null; expectancyR: number | null; withheld: boolean }> }>; unconditional5dMedian: number | null; caveat: string }
export function getGlobalTrackRecord(): Promise<RegimeTrackRecord> { return get<RegimeTrackRecord>('/api/global/track-record'); }

// ── India Market Diagnosis (GET /api/india/pulse) ────────────────────────────
export interface IndiaComponent { name: string; score: number | null; value: number | null; unit: string; reasons: string[]; covered: boolean }
export interface IndiaDiagnosis {
  version: string;
  sessionDate: string;
  state: 'STRONG' | 'NEUTRAL' | 'WEAK' | 'STRESSED';
  score: number;
  components: IndiaComponent[];
  reasons: string[];
  coverage: { covered: number; total: number; missing: string[] };
  authoritativeRegime: { regime: string; reasons: string[] } | null;
}
export interface IndiaPulse { diagnosis: IndiaDiagnosis | null; history: Array<{ date: string; state: string; score: number }>; note: string }
export function getIndiaPulse(): Promise<IndiaPulse> { return get<IndiaPulse>('/api/india/pulse'); }

// ── Sector Intelligence (GET /api/india/sectors) ─────────────────────────────
export interface SectorComponent { name: string; score: number | null; value: number | null; unit: string; reasons: string[]; covered: boolean }
export interface SectorRegimeRow { version: string; sector: string; name: string; sessionDate: string; state: 'STRONG' | 'NEUTRAL' | 'WEAK' | 'STRESSED'; score: number; components: SectorComponent[]; reasons: string[] }
export interface IndiaSectors { regimes: SectorRegimeRow[]; history: Record<string, Array<{ date: string; state: string }>>; proxies: Array<{ key: string; name: string; industries: string[] }>; note: string }
export function getIndiaSectors(): Promise<IndiaSectors> { return get<IndiaSectors>('/api/india/sectors'); }
