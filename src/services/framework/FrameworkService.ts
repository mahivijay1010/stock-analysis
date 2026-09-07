/**
 * FrameworkService (Module V2-B) — maps the owner's 8-phase methodology onto
 * computable checks over REAL data (quant technicals, Yahoo fundamentals,
 * macro regime, DB sector momentum). NEVER fakes a phase: every check quotes
 * actual values, unavailable data is marked no-data, and `missing[]` honestly
 * lists what free data cannot provide (DCF, qualitative moat, RBI policy).
 *
 * Sector momentum is computed from bars ALREADY IN THE DB for the universe
 * (no Yahoo refetch) and cached 30 minutes in memory.
 *
 * Master score = weighted average over available scored phases with the
 * owner's weights (macro .10, industry .15, fundamentals .20, valuation .20,
 * technicals .15) renormalized; null if fewer than 3 phases scored.
 */

import { AppDataSource } from "../../config/database";
import { NSE_UNIVERSE } from "../../data/nseUniverse";
import {
  Fundamentals,
  FrameworkReport,
  MarketRegime,
  PhaseCheck,
  PhaseResult,
  QuantAnalysis,
  TradePlan,
} from "../../types";

const SECTOR_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_BARS_FOR_R20 = 15;
const OWNER_WEIGHTS = {
  macro: 0.1,
  industry: 0.15,
  fundamentals: 0.2,
  valuation: 0.2,
  technicals: 0.15,
} as const;
const MIN_SCORED_PHASES = 3;

export interface SectorMomentumSnapshot {
  asOf: string;
  sectors: Array<{ sector: string; avgR20Pct: number; count: number; rank: number }>;
  byTicker: Record<string, number>; // ticker → its own 20d return %
}

export interface FrameworkInput {
  ticker: string;
  sector: string | null;
  price: number;
  quant: QuantAnalysis;
  fundamentals: Fundamentals | null;
  /** Set when the fundamentals fetch failed — recorded in the phases, never thrown. */
  fundamentalsWarning: string | null;
  regime: MarketRegime | null;
  sectorMomentum: SectorMomentumSnapshot | null;
  tradePlan: TradePlan | null;
}

function round1(x: number): number {
  const r = Math.round(x * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

const signed = (x: number, dp = 1): string => `${x >= 0 ? "+" : ""}${x.toFixed(dp)}%`;
const inr = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** ₹ crore, for balance-sheet magnitudes. */
const crore = (x: number): string => `₹${(x / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;

/** Pass-rate score over non-no-data checks: pass=1, neutral=0.5, fail=0. */
function scoreFromChecks(checks: PhaseCheck[]): number | null {
  const scored = checks.filter((c) => c.result !== "no-data");
  if (scored.length === 0) return null;
  const pts = scored.reduce(
    (s, c) => s + (c.result === "pass" ? 1 : c.result === "neutral" ? 0.5 : 0),
    0
  );
  return round1((pts / scored.length) * 100);
}

export class FrameworkService {
  private sectorCache: { snapshot: SectorMomentumSnapshot; builtAt: number } | null = null;
  private sectorInFlight: Promise<SectorMomentumSnapshot> | null = null;

  // ── Sector momentum (30-min cache, DB bars only) ──────────────────────────

  async getSectorMomentum(): Promise<SectorMomentumSnapshot> {
    if (this.sectorCache && Date.now() - this.sectorCache.builtAt < SECTOR_CACHE_TTL_MS) {
      return this.sectorCache.snapshot;
    }
    if (!this.sectorInFlight) {
      this.sectorInFlight = this.buildSectorMomentum().finally(() => {
        this.sectorInFlight = null;
      });
    }
    const snapshot = await this.sectorInFlight;
    this.sectorCache = { snapshot, builtAt: Date.now() };
    return snapshot;
  }

  /** 20d returns per universe ticker from stock_history — NO Yahoo refetch. */
  private async buildSectorMomentum(): Promise<SectorMomentumSnapshot> {
    const tickers = NSE_UNIVERSE.map((u) => u.ticker);
    const rows: Array<{ ticker: string; date: string; close: string }> =
      await AppDataSource.query(
        `SELECT s.ticker,
                to_char(h.trading_date, 'YYYY-MM-DD') AS date,
                h.close_price AS close
           FROM stocks s
           JOIN stock_history h ON h.stock_id = s.id
          WHERE s.ticker = ANY($1)
            AND h.trading_date >= CURRENT_DATE - INTERVAL '60 days'
          ORDER BY s.ticker, h.trading_date ASC, h.fetch_timestamp ASC`,
        [tickers]
      );

    // Dedupe by (ticker, date) — latest fetch wins (rows are fetch_ts ASC).
    const closesByTicker = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const close = Number.parseFloat(row.close);
      if (!Number.isFinite(close) || close <= 0) continue;
      let m = closesByTicker.get(row.ticker);
      if (!m) {
        m = new Map();
        closesByTicker.set(row.ticker, m);
      }
      m.set(row.date, close);
    }

    const byTicker: Record<string, number> = {};
    const sectorAgg = new Map<string, { sum: number; count: number }>();
    for (const u of NSE_UNIVERSE) {
      const m = closesByTicker.get(u.ticker);
      if (!m || m.size < MIN_BARS_FOR_R20) continue;
      const closes = Array.from(m.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([, c]) => c);
      const k = Math.min(21, closes.length - 1);
      const past = closes[closes.length - 1 - k];
      if (!(past > 0)) continue;
      const r20 = (closes[closes.length - 1] / past - 1) * 100;
      byTicker[u.ticker] = round2(r20);
      const agg = sectorAgg.get(u.sector) ?? { sum: 0, count: 0 };
      agg.sum += r20;
      agg.count += 1;
      sectorAgg.set(u.sector, agg);
    }

    const sectors = Array.from(sectorAgg.entries())
      .map(([sector, a]) => ({
        sector,
        avgR20Pct: round2(a.sum / a.count),
        count: a.count,
        rank: 0,
      }))
      .sort((a, b) => b.avgR20Pct - a.avgR20Pct);
    sectors.forEach((s, i) => {
      s.rank = i + 1;
    });

    return { asOf: new Date().toISOString(), sectors, byTicker };
  }

  // ── Report composition ────────────────────────────────────────────────────

  buildReport(input: FrameworkInput): FrameworkReport {
    const phases: PhaseResult[] = [
      this.phaseMacro(input),
      this.phaseIndustry(input),
      this.phaseMoat(input),
      this.phaseFundamentals(input),
      this.phaseValuation(input),
      this.phaseTechnicals(input),
    ];

    // Master score over available scored phases 1-6, weights renormalized.
    const keyByPhase: Record<number, keyof typeof OWNER_WEIGHTS> = {
      1: "macro",
      2: "industry",
      4: "fundamentals",
      5: "valuation",
      6: "technicals",
    };
    const scored = phases.filter(
      (p) => p.score !== null && keyByPhase[p.phase] !== undefined
    );
    let masterScore: number | null = null;
    const weightsUsed: Record<string, number> = {};
    if (scored.length >= MIN_SCORED_PHASES) {
      const totalW = scored.reduce((s, p) => s + OWNER_WEIGHTS[keyByPhase[p.phase]], 0);
      let acc = 0;
      for (const p of scored) {
        const w = OWNER_WEIGHTS[keyByPhase[p.phase]] / totalW;
        weightsUsed[keyByPhase[p.phase]] = round2(w);
        acc += w * (p.score as number);
      }
      masterScore = round1(acc);
    }

    // T3 fix (audit §10.7): a null master score (insufficient scored phases)
    // is DATA ABSENCE, not a judgment — it must not share the reject label.
    const verdict: FrameworkReport["verdict"] =
      masterScore === null
        ? "NO_DATA"
        : masterScore > 85
          ? "STRONG_CANDIDATE"
          : masterScore >= 70
            ? "WATCH"
            : "PASS";

    phases.push(this.phaseMasterScore(masterScore, verdict, weightsUsed, scored.length));
    phases.push(this.phaseRiskPlan(input));

    const coverage = { done: 0, partial: 0, unavailable: 0 };
    for (const p of phases) coverage[p.status] += 1;

    return { phases, masterScore, verdict, coverage, weightsUsed };
  }

  // ── Phase 1: Macro-Economic Tide (w .10) ──────────────────────────────────

  private phaseMacro(input: FrameworkInput): PhaseResult {
    const { regime } = input;
    const missing = [
      "RBI policy stance & rate cycle — not available from free data",
      "GDP/inflation trajectory — not available from free data",
    ];
    if (!regime) {
      return {
        phase: 1,
        name: "Macro-Economic Tide",
        status: "unavailable",
        score: null,
        weight: OWNER_WEIGHTS.macro,
        checks: [
          {
            name: "Market regime (NIFTY/VIX/USDINR)",
            result: "no-data",
            value: "macro data fetch failed — regime unavailable this run",
          },
        ],
        missing,
      };
    }
    const checks: PhaseCheck[] = [
      {
        name: "NIFTY vs 200DMA",
        result: regime.nifty.vs200dmaPct > 0 ? "pass" : "fail",
        value: `NIFTY ${regime.nifty.price.toFixed(0)} is ${signed(regime.nifty.vs200dmaPct)} vs its 200DMA`,
      },
      {
        name: "NIFTY vs 50DMA",
        result: regime.nifty.vs50dmaPct > 0 ? "pass" : "fail",
        value: `NIFTY is ${signed(regime.nifty.vs50dmaPct)} vs its 50DMA (20d return ${signed(regime.nifty.r20dPct)}, trend ${regime.nifty.trend})`,
      },
      {
        name: "India VIX zone",
        result:
          regime.vix.zone === "calm" || regime.vix.zone === "normal"
            ? "pass"
            : regime.vix.zone === "elevated"
              ? "neutral"
              : "fail",
        value: `India VIX ${regime.vix.value.toFixed(2)} — ${regime.vix.zone}`,
      },
      {
        name: "INR stability (USDINR)",
        result: regime.usdinr.trend === "weakening-inr" ? "fail" : "pass",
        value: `USDINR ${regime.usdinr.value.toFixed(2)}, ${signed(regime.usdinr.r60dPct)} over ~60 sessions — ${regime.usdinr.trend}`,
      },
    ];
    return {
      phase: 1,
      name: "Macro-Economic Tide",
      status: "done",
      score: regime.score,
      weight: OWNER_WEIGHTS.macro,
      checks,
      missing,
    };
  }

  // ── Phase 2: Industry & Sector Momentum (w .15) ───────────────────────────

  private phaseIndustry(input: FrameworkInput): PhaseResult {
    const { sector, sectorMomentum, quant, ticker } = input;
    const missing = [
      "Industry TAM / order-book / capex cycle — qualitative, not available free",
    ];
    const sectorRow =
      sector && sectorMomentum
        ? sectorMomentum.sectors.find((s) => s.sector === sector)
        : undefined;
    if (!sectorMomentum || !sector || !sectorRow) {
      return {
        phase: 2,
        name: "Industry & Sector Momentum",
        status: "unavailable",
        score: null,
        weight: OWNER_WEIGHTS.industry,
        checks: [
          {
            name: "Sector 20d momentum rank",
            result: "no-data",
            value: !sectorMomentum
              ? "sector momentum snapshot unavailable (DB bars could not be read)"
              : !sector
                ? `${ticker} is not in the tracked NSE universe — sector unknown`
                : `no DB bar coverage for sector "${sector}"`,
          },
        ],
        missing,
      };
    }

    const total = sectorMomentum.sectors.length;
    const rankPct = total > 1 ? ((total - sectorRow.rank) / (total - 1)) * 100 : 50;
    const stockR20 =
      quant.technicals.returns.r20dPct ?? sectorMomentum.byTicker[ticker] ?? null;

    const checks: PhaseCheck[] = [
      {
        name: "Sector 20d momentum rank",
        result:
          sectorRow.rank <= Math.ceil(total / 3)
            ? "pass"
            : sectorRow.rank > Math.ceil((2 * total) / 3)
              ? "fail"
              : "neutral",
        value: `${sector} avg 20d return ${signed(sectorRow.avgR20Pct)} — rank ${sectorRow.rank}/${total} sectors (${sectorRow.count} stocks)`,
      },
    ];
    let relScore = 50;
    if (stockR20 !== null) {
      const diff = stockR20 - sectorRow.avgR20Pct;
      relScore = Math.min(100, Math.max(0, 50 + diff * 10));
      checks.push({
        name: "Relative strength vs own sector",
        result: diff > 0.5 ? "pass" : diff < -0.5 ? "fail" : "neutral",
        value: `stock 20d ${signed(stockR20)} vs ${sector} avg ${signed(sectorRow.avgR20Pct)} (${signed(diff)}pp)`,
      });
    } else {
      checks.push({
        name: "Relative strength vs own sector",
        result: "no-data",
        value: "stock 20d return unavailable",
      });
    }

    const score = round1(0.7 * rankPct + 0.3 * relScore);
    return {
      phase: 2,
      name: "Industry & Sector Momentum",
      status: "done",
      score,
      weight: OWNER_WEIGHTS.industry,
      checks,
      missing,
    };
  }

  // ── Phase 3: Moat & Management (w 0, informational) ───────────────────────

  private phaseMoat(input: FrameworkInput): PhaseResult {
    const { fundamentals, fundamentalsWarning } = input;
    const missing = [
      "Qualitative moat (brand, switching costs, network effects) — not computable from free data",
      "Management track record & capital-allocation history — qualitative",
    ];
    if (fundamentalsWarning) missing.push(`Fundamentals fetch failed: ${fundamentalsWarning}`);

    const insider = fundamentals?.insiderHoldingPct ?? null;
    const checks: PhaseCheck[] = [
      insider !== null
        ? {
            name: "Insider/promoter holding >5% (owner's rule)",
            result: insider > 5 ? "pass" : "fail",
            value: `insiders/promoters hold ${insider.toFixed(1)}% (${insider > 5 ? ">" : "≤"}5%)`,
          }
        : {
            name: "Insider/promoter holding >5% (owner's rule)",
            result: "no-data",
            value: fundamentalsWarning
              ? `fundamentals unavailable — ${fundamentalsWarning}`
              : "insider holding not reported by Yahoo for this ticker",
          },
      {
        name: "Qualitative moat",
        result: "no-data",
        value: "moat is a qualitative judgement — not computable from free data",
      },
    ];
    return {
      phase: 3,
      name: "Moat & Management",
      status: insider !== null ? "partial" : "unavailable",
      score: null, // informational only (owner's weight = 0)
      weight: 0,
      checks,
      missing,
    };
  }

  // ── Phase 4: Fundamentals & ROIC proxy (w .20) ────────────────────────────

  private phaseFundamentals(input: FrameworkInput): PhaseResult {
    const { fundamentals: f, fundamentalsWarning } = input;
    const missing: string[] = [
      "True ROIC — needs invested-capital breakdown, not available free (ROE used as a labelled proxy)",
    ];
    if (!f) {
      if (fundamentalsWarning) missing.push(`Fundamentals fetch failed: ${fundamentalsWarning}`);
      return {
        phase: 4,
        name: "Fundamentals & ROIC",
        status: "unavailable",
        score: null,
        weight: OWNER_WEIGHTS.fundamentals,
        checks: [
          {
            name: "Fundamentals dataset",
            result: "no-data",
            value: fundamentalsWarning
              ? `fundamentals unavailable this run — ${fundamentalsWarning}`
              : "fundamentals unavailable this run",
          },
        ],
        missing,
      };
    }

    const checks: PhaseCheck[] = [];
    const add = (
      name: string,
      val: number | null,
      judge: (v: number) => PhaseCheck["result"],
      fmt: (v: number) => string,
      noDataNote: string
    ): void => {
      if (val === null) {
        checks.push({ name, result: "no-data", value: noDataNote });
      } else {
        checks.push({ name, result: judge(val), value: fmt(val) });
      }
    };

    add(
      "Revenue growth >10% (owner's growth rule)",
      f.revenueGrowthPct,
      (v) => (v > 10 ? "pass" : v > 0 ? "neutral" : "fail"),
      (v) => `revenue growth ${signed(v)} YoY`,
      "revenue growth not reported"
    );
    add(
      "Earnings growth positive",
      f.earningsGrowthPct,
      (v) => (v > 0 ? "pass" : "fail"),
      (v) => `earnings growth ${signed(v)} YoY`,
      "earnings growth not reported"
    );
    add(
      "Net margin positive",
      f.netMarginPct,
      (v) => (v > 0 ? "pass" : "fail"),
      (v) => `net margin ${v.toFixed(1)}%`,
      "net margin not reported"
    );
    add(
      "Operating margin level",
      f.operatingMarginPct,
      (v) => (v >= 15 ? "pass" : v >= 5 ? "neutral" : "fail"),
      (v) => `operating margin ${v.toFixed(1)}% (≥15% strong, 5–15% ok, <5% thin)`,
      "operating margin not reported"
    );
    add(
      "ROE ≥15% (proxy for owner's ROIC ≥15% rule)",
      f.returnOnEquityPct,
      (v) => (v >= 15 ? "pass" : v >= 10 ? "neutral" : "fail"),
      (v) => `ROE ${v.toFixed(1)}% — labelled PROXY for ROIC (true ROIC not available free)`,
      "ROE not reported by Yahoo for this ticker"
    );
    add(
      "Free cash flow positive",
      f.freeCashflow,
      (v) => (v > 0 ? "pass" : "fail"),
      (v) => `free cash flow ${crore(v)}`,
      "free cash flow not reported"
    );
    if (f.totalDebt !== null && f.totalCash !== null) {
      checks.push({
        name: "Balance sheet: cash vs debt (bonus)",
        result: f.totalCash > f.totalDebt ? "pass" : "neutral",
        value: `cash ${crore(f.totalCash)} vs debt ${crore(f.totalDebt)} — ${
          f.totalCash > f.totalDebt ? "net cash" : "net debt"
        }`,
      });
    } else {
      checks.push({
        name: "Balance sheet: cash vs debt (bonus)",
        result: "no-data",
        value: "total cash/debt not fully reported",
      });
    }
    add(
      "Current ratio ≥1",
      f.currentRatio,
      (v) => (v >= 1 ? "pass" : "fail"),
      (v) => `current ratio ${v.toFixed(2)}`,
      "current ratio not reported"
    );

    const nullCount = checks.filter((c) => c.result === "no-data").length;
    for (const c of checks) {
      if (c.result === "no-data") missing.push(`${c.name} — ${c.value}`);
    }
    const score = scoreFromChecks(checks);
    return {
      phase: 4,
      name: "Fundamentals & ROIC",
      status: score === null ? "unavailable" : nullCount > 2 ? "partial" : "done",
      score,
      weight: OWNER_WEIGHTS.fundamentals,
      checks,
      missing,
    };
  }

  // ── Phase 5: Valuation (w .20) ────────────────────────────────────────────

  private phaseValuation(input: FrameworkInput): PhaseResult {
    const { fundamentals: f, fundamentalsWarning } = input;
    const missing = [
      "DCF intrinsic value — needs 10y FCF projections, not available free",
    ];
    if (!f) {
      if (fundamentalsWarning) missing.push(`Fundamentals fetch failed: ${fundamentalsWarning}`);
      return {
        phase: 5,
        name: "Valuation",
        status: "unavailable",
        score: null,
        weight: OWNER_WEIGHTS.valuation,
        checks: [
          {
            name: "Valuation dataset",
            result: "no-data",
            value: fundamentalsWarning
              ? `fundamentals unavailable this run — ${fundamentalsWarning}`
              : "fundamentals unavailable this run",
          },
        ],
        missing,
      };
    }

    const checks: PhaseCheck[] = [];
    if (f.pegRatio !== null) {
      checks.push({
        name: "PEG <1.5 (owner's rule; <1.0 strong)",
        result: f.pegRatio < 1.5 ? "pass" : "fail",
        value: `PEG ${f.pegRatio.toFixed(2)} — ${
          f.pegRatio < 1.0 ? "strong (<1.0)" : f.pegRatio < 1.5 ? "pass (<1.5)" : "expensive (≥1.5)"
        }`,
      });
    } else {
      checks.push({
        name: "PEG <1.5 (owner's rule; <1.0 strong)",
        result: "no-data",
        value: "PEG not reported (needs growth estimates)",
      });
    }
    if (f.enterpriseToEbitda !== null) {
      checks.push({
        name: "EV/EBITDA <12 pass, 12–18 neutral, >18 fail",
        result:
          f.enterpriseToEbitda < 12 ? "pass" : f.enterpriseToEbitda <= 18 ? "neutral" : "fail",
        value: `EV/EBITDA ${f.enterpriseToEbitda.toFixed(1)}`,
      });
    } else {
      checks.push({
        name: "EV/EBITDA <12 pass, 12–18 neutral, >18 fail",
        result: "no-data",
        value: "EV/EBITDA not reported",
      });
    }
    if (f.priceToBook !== null) {
      checks.push({
        name: "P/B <4",
        result: f.priceToBook < 4 ? "pass" : "fail",
        value: `price-to-book ${f.priceToBook.toFixed(2)}${f.trailingPE !== null ? ` (trailing P/E ${f.trailingPE.toFixed(1)})` : ""}`,
      });
    } else {
      checks.push({ name: "P/B <4", result: "no-data", value: "price-to-book not reported" });
    }
    const paysDividend = f.dividendYieldPct !== null && f.dividendYieldPct > 0;
    if (paysDividend && f.payoutRatioPct !== null) {
      checks.push({
        name: "Payout ratio <60% (dividend-paying)",
        result: f.payoutRatioPct < 60 ? "pass" : "fail",
        value: `payout ratio ${f.payoutRatioPct.toFixed(1)}% on a ${f.dividendYieldPct!.toFixed(2)}% yield`,
      });
    } else if (paysDividend) {
      checks.push({
        name: "Payout ratio <60% (dividend-paying)",
        result: "no-data",
        value: `dividend yield ${f.dividendYieldPct!.toFixed(2)}% but payout ratio not reported`,
      });
    } else {
      checks.push({
        name: "Payout ratio <60% (dividend-paying)",
        result: "neutral",
        value: "not dividend-paying (or no dividend data) — payout check not applicable",
      });
    }

    for (const c of checks) {
      if (c.result === "no-data") missing.push(`${c.name} — ${c.value}`);
    }
    const withData = checks.filter((c) => c.result !== "no-data").length;
    const score = scoreFromChecks(checks);
    return {
      phase: 5,
      name: "Valuation",
      status: score === null ? "unavailable" : withData >= 3 ? "done" : "partial",
      score,
      weight: OWNER_WEIGHTS.valuation,
      checks,
      missing,
    };
  }

  // ── Phase 6: Technicals & Timing (w .15) ──────────────────────────────────

  private phaseTechnicals(input: FrameworkInput): PhaseResult {
    const { quant, price } = input;
    const t = quant.technicals;
    const checks: PhaseCheck[] = [];

    if (t.sma200 !== null && t.sma200 > 0) {
      const d = (price / t.sma200 - 1) * 100;
      checks.push({
        name: "Price vs 200DMA (owner: rarely buy below)",
        result: d >= 0 ? "pass" : "fail",
        value: `price ${inr(price)} is ${signed(d)} vs 200DMA ${inr(t.sma200)}`,
      });
    } else {
      checks.push({
        name: "Price vs 200DMA (owner: rarely buy below)",
        result: "no-data",
        value: "200DMA unavailable (needs ~200 bars)",
      });
    }

    if (t.rsi14 !== null) {
      const fundamentalsIntact =
        input.fundamentals !== null &&
        (input.fundamentals.netMarginPct ?? -1) > 0 &&
        (input.fundamentals.revenueGrowthPct ?? -1) > 0;
      checks.push(
        t.rsi14 > 70
          ? {
              name: "RSI zone (>70 wait, <30 accumulate if fundamentals intact)",
              result: "fail",
              value: `RSI ${t.rsi14.toFixed(1)} — overbought, owner's rule says wait`,
            }
          : t.rsi14 < 30
            ? {
                name: "RSI zone (>70 wait, <30 accumulate if fundamentals intact)",
                result: fundamentalsIntact ? "pass" : "neutral",
                value: `RSI ${t.rsi14.toFixed(1)} — oversold${
                  fundamentalsIntact
                    ? "; fundamentals intact (positive margins + growth) → accumulate zone"
                    : "; fundamentals not confirmed intact → caution"
                }`,
              }
            : {
                name: "RSI zone (>70 wait, <30 accumulate if fundamentals intact)",
                result: "neutral",
                value: `RSI ${t.rsi14.toFixed(1)} — neutral zone (30–70)`,
              }
      );
    } else {
      checks.push({
        name: "RSI zone (>70 wait, <30 accumulate if fundamentals intact)",
        result: "no-data",
        value: "RSI unavailable",
      });
    }

    if (t.week52) {
      const offHigh = t.week52.high > 0 ? (price / t.week52.high - 1) * 100 : 0;
      const offLow = t.week52.low > 0 ? (price / t.week52.low - 1) * 100 : 0;
      checks.push({
        name: "52-week range position (support/resistance proxy)",
        result: t.week52.positionPct >= 60 ? "pass" : t.week52.positionPct <= 20 ? "fail" : "neutral",
        value: `at ${t.week52.positionPct.toFixed(0)}% of 52w range — ${signed(offHigh)} vs high ${inr(t.week52.high)} (resistance), ${signed(offLow)} vs low ${inr(t.week52.low)} (support)`,
      });
    } else {
      checks.push({
        name: "52-week range position (support/resistance proxy)",
        result: "no-data",
        value: "52-week range unavailable (needs ~1y of bars)",
      });
    }

    if (t.volumeRatio20d !== null) {
      const r5 = t.returns.r5dPct ?? 0;
      checks.push({
        name: "Volume confirmation",
        result:
          t.volumeRatio20d >= 1.1 && r5 >= 0
            ? "pass"
            : t.volumeRatio20d >= 1.5 && r5 < 0
              ? "fail"
              : "neutral",
        value: `volume ${t.volumeRatio20d.toFixed(2)}× the 20d average with 5d return ${signed(r5)}`,
      });
    } else {
      checks.push({ name: "Volume confirmation", result: "no-data", value: "volume data unavailable" });
    }

    if (t.sma50 !== null && t.sma200 !== null) {
      checks.push({
        name: "Golden/death cross (50DMA vs 200DMA)",
        result: t.sma50 > t.sma200 ? "pass" : "fail",
        value: `50DMA ${inr(t.sma50)} ${t.sma50 > t.sma200 ? ">" : "<"} 200DMA ${inr(t.sma200)} — ${
          t.sma50 > t.sma200 ? "golden alignment" : "death-cross alignment"
        }`,
      });
    } else {
      checks.push({
        name: "Golden/death cross (50DMA vs 200DMA)",
        result: "no-data",
        value: "needs both 50DMA and 200DMA",
      });
    }

    const noData = checks.filter((c) => c.result === "no-data").length;
    const score = scoreFromChecks(checks);
    return {
      phase: 6,
      name: "Technicals & Timing",
      status: score === null ? "unavailable" : noData > 2 ? "partial" : "done",
      score,
      weight: OWNER_WEIGHTS.technicals,
      checks,
      missing: [],
    };
  }

  // ── Phase 7: Master Score Matrix ──────────────────────────────────────────

  private phaseMasterScore(
    masterScore: number | null,
    verdict: FrameworkReport["verdict"],
    weightsUsed: Record<string, number>,
    scoredCount: number
  ): PhaseResult {
    const weightsStr = Object.entries(weightsUsed)
      .map(([k, w]) => `${k} ${(w * 100).toFixed(1)}%`)
      .join(", ");
    return {
      phase: 7,
      name: "Master Score Matrix",
      status: masterScore !== null ? "done" : "unavailable",
      score: masterScore,
      weight: 0, // this IS the composite — not re-weighted into itself
      checks: [
        masterScore !== null
          ? {
              name: "Weighted composite (>85 strong / 70–85 watch / <70 pass)",
              result: masterScore > 85 ? "pass" : masterScore >= 70 ? "neutral" : "fail",
              value: `master score ${masterScore.toFixed(1)}/100 → ${verdict} (renormalized weights: ${weightsStr})`,
            }
          : {
              name: "Weighted composite (>85 strong / 70–85 watch / <70 pass)",
              result: "no-data",
              value: `only ${scoredCount} phase(s) scored — need ≥${MIN_SCORED_PHASES} for an honest master score`,
            },
      ],
      missing: [],
    };
  }

  // ── Phase 8: Risk Management Plan ─────────────────────────────────────────

  private phaseRiskPlan(input: FrameworkInput): PhaseResult {
    const { tradePlan, quant } = input;
    const missing = [
      "Portfolio-level exposure & correlation checks — needs your full portfolio, not available here",
    ];
    if (!tradePlan) {
      return {
        phase: 8,
        name: "Risk Management Plan",
        status: "done",
        score: null, // not scored — this phase produces the trade plan
        weight: 0,
        checks: [
          {
            name: "Trade plan",
            result: "neutral",
            value:
              quant.recommendation === "AVOID"
                ? "no trade plan — recommendation is AVOID, so the correct risk plan is to not enter"
                : "no trade plan could be generated for this stock",
          },
        ],
        missing,
      };
    }
    return {
      phase: 8,
      name: "Risk Management Plan",
      status: "done",
      score: null, // not scored — produces the TradePlan (Module V2-C)
      weight: 0,
      checks: [
        {
          name: "Entry",
          result: "neutral",
          value: `entry at current price ${inr(tradePlan.entry)}`,
        },
        {
          name: "Stop-loss (max of 2×ATR14 and vol-tier floor)",
          result: "pass",
          value: `stop ${inr(tradePlan.stopLoss)} (−${tradePlan.stopLossPct.toFixed(1)}%)`,
        },
        {
          name: "Target (owner's 3:1 reward:risk rule)",
          result: "pass",
          value: `target ${inr(tradePlan.target)} (+${tradePlan.targetPct.toFixed(1)}%), R:R ${tradePlan.rewardRiskRatio.toFixed(1)}:1`,
        },
        {
          name: "Target plausibility (+2.5σ√21d clamp)",
          result: tradePlan.meetsRewardRisk ? "pass" : "fail",
          value: tradePlan.note,
        },
      ],
      missing,
    };
  }
}

/** Singleton export. */
export const frameworkService = new FrameworkService();
export default frameworkService;
