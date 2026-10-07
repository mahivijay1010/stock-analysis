/**
 * Wide scan — the standard short-term pipeline (setup → entry/stop/targets →
 * EV after costs → sizing → gates → action state) run over the stocks that
 * pass the sub-₹100 wide screen, instead of the 152-stock NSE_UNIVERSE.
 *
 * Nothing about the pipeline is relaxed for these stocks: the same tiers,
 * confirmation rules and EV gates decide whether a plan is ENTRY_CONFIRMED,
 * WAIT_FOR_CONFIRMATION, RESEARCH_WATCH or NO_TRADE. Every evaluated stock is
 * persisted (so the existing detail page works for it), but NONE of them write
 * shadow predictions — the radar's live-authority evidence stays the 152's.
 */
import { UniverseStock } from "../../data/nseUniverse";
import { Bar } from "../market/types";
import { liveMarketDataProvider } from "./LiveMarketDataProvider";
import { shortTermScanService } from "./ScanService";
import { ScanParams, ShortTermCandidateView } from "./types";
import { WideScreenReport, buildWideScreenReport } from "./wideScreenReport";
import { RecommendationScore, rankRecommendations, RankedPick } from "./recommendation";
import { wideLedgerService, LogPicksInput } from "./WideLedgerService";
import { WideScreenEvidence } from "./wideLedger";

/** Compact, citable evidence from a screen row — the ONLY thing the AI scout is
 *  later allowed to reason over (quantitative, no fabricated news). */
function screenEvidenceOf(s: {
  symbol: string;
  companyName?: string | null;
  industry?: string | null;
  price: number;
  medianTurnoverLacs20?: number | null;
  medianTrades20?: number | null;
  avgDelivPct60?: number | null;
  delivTrendPp?: number | null;
  ret20Pct?: number | null;
  ret60Pct?: number | null;
  ret250Pct?: number | null;
  vol60AnnPct?: number | null;
  maxDrawdown1yPct?: number | null;
  pctFrom1yHigh?: number | null;
  indices?: string[];
  surveillance?: Array<{ code: string }>;
  corporateActionSuspect?: boolean;
}): WideScreenEvidence {
  return {
    symbol: s.symbol,
    companyName: s.companyName ?? null,
    industry: s.industry ?? null,
    price: s.price,
    medianTurnoverCr20: s.medianTurnoverLacs20 != null ? Math.round((s.medianTurnoverLacs20 / 100) * 100) / 100 : null,
    medianTrades20: s.medianTrades20 ?? null,
    avgDelivPct60: s.avgDelivPct60 ?? null,
    delivTrendPp: s.delivTrendPp ?? null,
    ret20Pct: s.ret20Pct ?? null,
    ret60Pct: s.ret60Pct ?? null,
    ret250Pct: s.ret250Pct ?? null,
    vol60AnnPct: s.vol60AnnPct ?? null,
    maxDrawdown1yPct: s.maxDrawdown1yPct ?? null,
    pctFrom1yHigh: s.pctFrom1yHigh ?? null,
    indices: s.indices ?? [],
    surveillanceCodes: (s.surveillance ?? []).map((x) => x.code),
    corporateActionSuspect: s.corporateActionSuspect ?? false,
  };
}

export const WIDE_SCAN_LABEL = "WIDE_SUB100";

/**
 * Reference levels for EVERY stock, including those with no setup. These are
 * where price has been, not where it will go: support/resistance are the 20-
 * session low/high, the volatility stop sits 2×ATR(14) below the close. They
 * exist so a holder has an exit line and a watcher has a map; they are NOT a
 * trade plan (only a detected setup produces one).
 */
export interface ReferenceLevels {
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

/** Reference levels from completed daily bars (ascending). Null under 20 bars. PURE. */
export function referenceLevels(bars: Bar[]): ReferenceLevels | null {
  if (bars.length < 20) return null;
  const last = bars[bars.length - 1];
  const w20 = bars.slice(-20);
  const w52 = bars.slice(-250);
  const tr: number[] = [];
  for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
    const b = bars[i],
      prev = bars[i - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)));
  }
  const atr = tr.reduce((a, x) => a + x, 0) / tr.length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    close: r2(last.close),
    support20: r2(Math.min(...w20.map((b) => b.low))),
    resistance20: r2(Math.max(...w20.map((b) => b.high))),
    low52w: r2(Math.min(...w52.map((b) => b.low))),
    high52w: r2(Math.max(...w52.map((b) => b.high))),
    atr14: r2(atr),
    atrPct: r2((atr / last.close) * 100),
    volatilityStop: r2(last.close - 2 * atr),
    asOf: last.date,
  };
}

export type Decision = "BUY" | "WAIT" | "WATCH" | "NO TRADE";

export interface DecisionView {
  /** For someone who does not own it. */
  newBuyer: Decision;
  /** For someone who already owns it. */
  holder: "HOLD" | "EXIT" | "TRAIL" | "TAKE PARTIAL";
  why: string;
}

/** Plain-language decision from the pipeline's action state — never upgrades it. PURE. */
export function decisionFor(
  v: ShortTermCandidateView | null,
  ref: ReferenceLevels | null,
): DecisionView {
  const stop = v?.plan?.initialStop ?? ref?.volatilityStop ?? null;
  const holderLine = stop != null ? `holders: exit below ₹${stop}` : "holders: no level available";
  if (!v)
    return {
      newBuyer: "NO TRADE",
      holder: "HOLD",
      why: `no usable price history from the provider; ${holderLine}`,
    };
  switch (v.action) {
    case "ENTRY_CONFIRMED":
      return {
        newBuyer: "BUY",
        holder: "HOLD",
        why: `setup ${v.setupType} confirmed and its evidence passed every gate; ${holderLine}`,
      };
    case "ZONE_REACHED":
    case "WAIT_FOR_CONFIRMATION":
      return {
        newBuyer: "WAIT",
        holder: "HOLD",
        why: `price is in the ${v.setupType} entry zone but the entry is not confirmed; ${holderLine}`,
      };
    case "RESEARCH_WATCH":
    case "SETUP_DETECTED":
      return {
        newBuyer: "WATCH",
        holder: "HOLD",
        why: `${v.setupType} setup detected; tier ${v.tier} — no validated edge yet; ${holderLine}`,
      };
    case "TAKE_PARTIAL":
      return { newBuyer: "NO TRADE", holder: "TAKE PARTIAL", why: "target 1 reached" };
    case "TRAIL":
      return { newBuyer: "NO TRADE", holder: "TRAIL", why: "trend intact — trail the stop" };
    case "EXIT":
    case "INVALIDATED":
      return { newBuyer: "NO TRADE", holder: "EXIT", why: "the setup's invalidation level broke" };
    default:
      return {
        newBuyer: "NO TRADE",
        holder: "HOLD",
        why: `no qualifying short-term setup — nothing to enter; ${holderLine} (2×ATR volatility stop)`,
      };
  }
}

export interface WideScanRow {
  symbol: string;
  ticker: string;
  /** Null when the price provider had no usable bars for this stock. */
  evaluation: ShortTermCandidateView | null;
  reference: ReferenceLevels | null;
  decision: DecisionView;
  /** Quality-of-opportunity ranking (NOT an expected-return forecast). */
  recommendation: RecommendationScore;
  /** Position within its bucket: 1 = best. */
  rank: number;
}

export interface WideScanResult {
  /** Prospective ledger write for this scan (sub-₹100 scoreboard). */
  ledger: { logged: number; skipped: { ungradeable: number; noEvaluation: number } };
  report: WideScreenReport;
  scanRunId: string;
  params: ScanParams;
  marketSession: string;
  evaluated: number;
  qualifiedCount: number;
  riskManager: { newEntriesAllowed: boolean; reasons: string[] };
  rows: WideScanRow[];
  /** Rows the pipeline cleared for entry (BUY/WAIT), best first. */
  tradeable: WideScanRow[];
  /** Everything else, best first — quality without a tradeable setup today. */
  watch: WideScanRow[];
  note: string;
}

const toYahoo = (symbol: string) => `${symbol}.NS`;

export async function runWideScan(paramsIn: Partial<ScanParams>): Promise<WideScanResult> {
  // priceMax is the user's cap; it drives the screen itself, not just a filter.
  const report = await buildWideScreenReport({ maxPrice: paramsIn.priceMax ?? undefined });
  const universe: UniverseStock[] = report.stocks.map((s) => ({
    ticker: toYahoo(s.symbol),
    name: s.companyName ?? s.symbol,
    sector: s.industry ?? "Unclassified",
  }));

  const scan = await shortTermScanService.scan(
    // The wide screen already applied price and liquidity; the scan must not cap the list or spend AI per stock.
    { ...paramsIn, priceMax: report.screen.rules.maxPrice, limit: 0, aiDepth: "LOCAL_ONLY" },
    { universe, label: WIDE_SCAN_LABEL, persistAll: true, shadow: false, returnAll: true },
  );

  const byTicker = new Map((scan.all ?? []).map((v) => [v.ticker, v]));
  const todayIso = new Date().toISOString().slice(0, 10);

  // Base rows carry the screen row so ranking + ledger evidence can read it.
  type ScreenStock = (typeof report.stocks)[number];
  interface Base {
    symbol: string;
    ticker: string;
    evaluation: ShortTermCandidateView | null;
    reference: ReferenceLevels | null;
    decision: DecisionView;
    screen: ScreenStock;
  }
  const base: Base[] = [];
  for (const s of report.stocks) {
    const ticker = toYahoo(s.symbol);
    // Same cached completed bars the scan just used — no extra provider load.
    const bars = await liveMarketDataProvider.getCompletedBars(ticker, "1y").catch(() => [] as Bar[]);
    const evaluation = byTicker.get(ticker) ?? null;
    const reference = referenceLevels(bars);
    base.push({ symbol: s.symbol, ticker, evaluation, reference, decision: decisionFor(evaluation, reference), screen: s });
  }

  // Rank into tradeable/watch — a QUALITY-of-opportunity ordering, never an
  // expected-return forecast. A stock with no setup can only ever be a watch item.
  const { tradeable: tRanked, watch: wRanked } = rankRecommendations(base, (b) => ({
    rankingScoreV2: b.evaluation?.rankingScore ?? null,
    tier: (b.evaluation?.tier as "A" | "B" | "C" | "D" | undefined) ?? null,
    action: b.evaluation?.action ?? null,
    liquidityPct: b.screen.rank?.liquidity ?? null,
    stabilityPct: b.screen.rank?.stability ?? null,
    corporateActionSuspect: b.screen.corporateActionSuspect,
    facts: (b.screen.facts ?? []).map((f) => ({ kind: f.kind, sentiment: f.sentiment, materiality: f.materiality })),
    decision: b.decision.newBuyer,
  }));
  const toRow = (p: RankedPick<Base>): WideScanRow => ({
    symbol: p.item.symbol,
    ticker: p.item.ticker,
    evaluation: p.item.evaluation,
    reference: p.item.reference,
    decision: p.item.decision,
    recommendation: p.recommendation,
    rank: p.rank,
  });
  const tradeable = tRanked.map(toRow);
  const watch = wRanked.map(toRow);
  const rows = [...tradeable, ...watch];

  // Log every gradeable pick prospectively (idempotent). Never fatal to the scan.
  const logRows: LogPicksInput["rows"] = base.map((b) => ({
    symbol: b.symbol,
    ticker: b.ticker,
    evaluation: b.evaluation as LogPicksInput["rows"][number]["evaluation"],
    decision: { newBuyer: b.decision.newBuyer },
    screen: screenEvidenceOf(b.screen),
  }));
  let ledger = { logged: 0, skipped: { ungradeable: 0, noEvaluation: 0 } };
  try {
    ledger = await wideLedgerService.logPicks({ horizon: scan.params.horizon, rows: logRows, fallbackAnchor: todayIso });
  } catch (err) {
    console.warn("⚠️ wide-ledger logPicks failed (scan still returned):", (err as Error).message);
  }

  return {
    ledger,
    report,
    scanRunId: scan.scanRunId,
    params: scan.params,
    marketSession: scan.marketStatus.session,
    evaluated: rows.filter((r) => r.evaluation).length,
    qualifiedCount: scan.qualifiedCount,
    riskManager: {
      newEntriesAllowed: scan.riskManager.newEntriesAllowed,
      reasons: scan.riskManager.reasons,
    },
    rows,
    tradeable,
    watch,
    note:
      "Entry, stop and targets come from the same short-term pipeline as the radar, with the same gates. A plan is a level map, not a forecast: " +
      "an action only reaches ENTRY CONFIRMED when the setup has validated out-of-sample evidence, the entry is confirmed and the EV lower bound survives costs. " +
      "These stocks do not feed the radar's evidence base.",
  };
}
