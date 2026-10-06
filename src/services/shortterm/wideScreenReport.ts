/**
 * Detailed report for the wide-universe sub-₹100 screen: the screen's numbers
 * beside every sourced fact the knowledge base holds for each passing stock,
 * with the system's own evidence status stated first.
 *
 * The report never says "buy". It says what the stock IS (price, liquidity,
 * delivery, drawdown, exchange status, industry), what is KNOWN about it
 * (dated, sourced facts), what is UNKNOWN, and what the system's track record
 * entitles it to claim about direction (nothing, as of 2026-10-06 — see the
 * Evidence tab). Markdown is written to docs/reports/ so it is versioned.
 */
import { AppDataSource } from "../../config/database";
import { ScreenRow, WideScreenResult, runWideScreen } from "./wideScreen";

export interface KnowledgeFact {
  /** From the automated news pipeline (news-facts-v1); null for exchange/manual facts. */
  sentiment: string | null;
  materiality: string | null;
  kind: string;
  fact: string;
  sourceKind: string;
  sourceUrl: string | null;
  observedAt: string;
  confidence: string;
}

export interface ReportStock extends ScreenRow {
  facts: KnowledgeFact[];
  /** Plain-language flags derived from the numbers — descriptive, not predictive. */
  flags: string[];
}

export interface WideScreenReport {
  screen: Omit<WideScreenResult, "rows">;
  generatedAt: string;
  evidenceStatus: string;
  stocks: ReportStock[];
  excludedSummary: Record<string, number>;
  knowledgeCoverage: { withFacts: number; total: number };
}

/** Flags from the screen numbers. PURE. */
export function flagsFor(r: ScreenRow): string[] {
  const f: string[] = [];
  if (r.corporateActionSuspect) f.push("a >25% one-day print inside the window — bonus/split or a shock; unadjusted returns below are NOT reliable");
  if (r.pctFrom1yHigh != null && r.pctFrom1yHigh <= -30) f.push(`${r.pctFrom1yHigh.toFixed(0)}% below its 1-year high`);
  if (r.pctFrom1yHigh != null && r.pctFrom1yHigh >= -2) f.push("at its 1-year high");
  if (r.ret250Pct != null && r.ret250Pct >= 100) f.push(`+${r.ret250Pct.toFixed(0)}% in a year — a move this size in a small stock is a risk in itself`);
  if (r.vol60AnnPct != null && r.vol60AnnPct >= 40) f.push(`high volatility (${r.vol60AnnPct.toFixed(0)}% annualised)`);
  if (r.vol60AnnPct != null && r.vol60AnnPct < 18) f.push(`low volatility (${r.vol60AnnPct.toFixed(0)}% annualised)`);
  if (r.avgDelivPct60 != null && r.avgDelivPct60 < 30) f.push(`low delivery (${r.avgDelivPct60.toFixed(0)}% of volume taken into delivery — mostly intraday churn)`);
  if (r.avgDelivPct60 != null && r.avgDelivPct60 >= 55) f.push(`high delivery (${r.avgDelivPct60.toFixed(0)}%)`);
  if (r.price < 15) f.push("under ₹15: a one-tick move is a large fraction of the price; costs bite harder");
  if (!r.indices.length) f.push("not in any NSE broad index (less institutional coverage)");
  return f;
}

export async function buildWideScreenReport(): Promise<WideScreenReport> {
  const screen = await runWideScreen();
  const passing = screen.rows.filter((r) => r.passed);
  const symbols = passing.map((r) => r.symbol);
  const rows: Array<{ symbol: string; kind: string; fact: string; source_kind: string; source_url: string | null; observed_at: string; confidence: string; sentiment: string | null; materiality: string | null }> =
    await AppDataSource.query(
      `SELECT symbol, kind, fact, source_kind, source_url, to_char(observed_at,'YYYY-MM-DD') observed_at, confidence,
              detail->>'sentiment' sentiment, detail->>'materiality' materiality
         FROM stock_knowledge WHERE symbol = ANY($1) AND kind <> 'SURVEILLANCE' ORDER BY symbol, observed_at DESC, kind`,
      [symbols]
    );
  const facts = new Map<string, KnowledgeFact[]>();
  for (const r of rows) {
    const g = facts.get(r.symbol) ?? [];
    g.push({ kind: r.kind, fact: r.fact, sourceKind: r.source_kind, sourceUrl: r.source_url, observedAt: r.observed_at, confidence: r.confidence, sentiment: r.sentiment, materiality: r.materiality });
    facts.set(r.symbol, g);
  }
  const excludedSummary: Record<string, number> = {};
  for (const r of screen.rows) for (const e of r.exclusions) {
    const k = e.split(":")[0].replace(/ \(.*\)$/, "");
    excludedSummary[k] = (excludedSummary[k] ?? 0) + 1;
  }
  const { rows: _drop, ...rest } = screen;
  return {
    screen: rest,
    generatedAt: new Date().toISOString(),
    evidenceStatus:
      "No signal in this system has demonstrated stock-picking skill: 9 pre-registered signals and the quant-v1 model all failed on sealed data " +
      "(Evidence tab → baselines, stock-selection studies). This report therefore ranks TRADEABILITY, states facts with sources, and makes no directional call.",
    stocks: passing.map((r) => ({ ...r, facts: facts.get(r.symbol) ?? [], flags: flagsFor(r) })),
    excludedSummary,
    knowledgeCoverage: { withFacts: passing.filter((r) => facts.has(r.symbol)).length, total: passing.length },
  };
}

const n = (v: number | null | undefined, d = 1, suffix = "") => (v == null ? "—" : `${v.toFixed(d)}${suffix}`);

/** Markdown rendering. PURE. */
export function renderMarkdown(rep: WideScreenReport, detailTop = 30): string {
  const s = rep.screen;
  const L: string[] = [];
  L.push(`# Stocks under ₹100 — wide-universe screen, ${s.asOf}`);
  L.push("");
  L.push(`Generated ${rep.generatedAt}. Universe: every NSE EQ company (${s.universeSize} instruments on ${s.asOf}); ${s.under100} companies closed under ₹${s.rules.maxPrice}; **${s.passed} pass** the tradeability screen.`);
  L.push("");
  L.push(`> **Evidence status.** ${rep.evidenceStatus}`);
  L.push("");
  L.push("## What the screen does");
  L.push("");
  L.push(`A stock passes only if, on ${s.asOf}: no ASM/GSM/ESM/IBC surveillance; close ≥ ₹${s.rules.minPrice}; ≥ ${s.rules.minSessions} sessions of history; listed > 1 year; median 20-session turnover ≥ ₹${s.rules.minMedianTurnoverLacs / 100} crore and median trades ≥ ${s.rules.minMedianTrades}; and it is a company, not an ETF.`);
  L.push("Passing stocks are ordered by a **tradeability score** = ½ liquidity percentile + ½ stability percentile (lower volatility, shallower 1-year drawdown). Past return earns nothing in the score, on purpose.");
  L.push("");
  L.push("## Why stocks were excluded");
  L.push("");
  L.push("| Reason | Stocks |\n|---|---|");
  for (const [k, v] of Object.entries(rep.excludedSummary).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push("");
  L.push(`## Passing stocks (${rep.stocks.length})`);
  L.push("");
  L.push("| # | Symbol | Company | Price | Turnover/day | Deliv % | 20d | 60d | 1y | Vol (ann.) | 1y drawdown | From 1y high | Industry | Score |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  rep.stocks.forEach((r, i) => {
    L.push(
      `| ${i + 1} | ${r.symbol} | ${r.companyName ?? "—"} | ₹${r.price.toFixed(2)} | ₹${n((r.medianTurnoverLacs20 ?? 0) / 100, 1)} cr | ${n(r.avgDelivPct60, 0)} | ${n(r.ret20Pct, 1, "%")} | ${n(r.ret60Pct, 1, "%")} | ${n(r.ret250Pct, 0, "%")}${r.corporateActionSuspect ? " ⚠" : ""} | ${n(r.vol60AnnPct, 0, "%")} | ${n(r.maxDrawdown1yPct, 0, "%")} | ${n(r.pctFrom1yHigh, 0, "%")} | ${r.industry ?? "—"} | ${n(r.rank?.score ?? null, 2)} |`
    );
  });
  L.push("");
  L.push("⚠ = a >25% one-day print inside the window (bonus/split or shock): unadjusted returns unreliable.");
  L.push("");
  L.push(`## Detail — top ${Math.min(detailTop, rep.stocks.length)} by tradeability`);
  L.push("");
  for (const r of rep.stocks.slice(0, detailTop)) {
    L.push(`### ${r.symbol} — ${r.companyName ?? ""}`);
    L.push("");
    L.push(`₹${r.price.toFixed(2)} · ${r.industry ?? "industry n/a"} · ${r.indices.length ? r.indices.join(", ") : "no broad index"} · listed ${r.listingDate ?? "n/a"}`);
    L.push("");
    L.push(`- Liquidity: median ₹${n((r.medianTurnoverLacs20 ?? 0) / 100, 1)} cr/day, ${Math.round(r.medianTrades20 ?? 0)} trades/day; delivery ${n(r.avgDelivPct60, 0, "%")} of volume (5-day trend ${n(r.delivTrendPp, 1, " pp")}).`);
    L.push(`- Price path: 20d ${n(r.ret20Pct, 1, "%")}, 60d ${n(r.ret60Pct, 1, "%")}, 1y ${n(r.ret250Pct, 1, "%")}; volatility ${n(r.vol60AnnPct, 0, "%")} ann.; 1y max drawdown ${n(r.maxDrawdown1yPct, 0, "%")}; ${n(r.pctFrom1yHigh, 0, "%")} from 1y high.`);
    if (r.flags.length) L.push(`- Flags: ${r.flags.join("; ")}.`);
    if (r.facts.length) {
      L.push("- Known (sourced):");
      for (const f of r.facts) L.push(`  - **${f.kind}**${f.sentiment ? ` · ${f.sentiment.toLowerCase()}/${(f.materiality ?? "").toLowerCase()}` : ""} (${f.observedAt}, ${f.confidence.toLowerCase()} confidence): ${f.fact}${f.sourceUrl ? ` [source](${f.sourceUrl})` : ""}`);
    } else {
      L.push("- Known: nothing in the knowledge base yet for this stock — numbers only.");
    }
    L.push(`- Direction: **no call**. The system has no demonstrated skill at this; a trade here is a judgement you make, with the cost model's slippage assumptions valid at this liquidity.`);
    L.push("");
  }
  L.push("## How to read this");
  L.push("");
  L.push("- Everything above is descriptive. A high score means *cheap to trade and historically steadier*, not *likely to rise*.");
  L.push("- Facts carry a date and a source; a fact from a broker or price-tracker site is marked low/medium confidence. Analyst targets are opinions.");
  L.push("- Prices are exchange prints (unadjusted); a bonus or split inside the window is flagged rather than silently scored.");
  L.push("- Surveillance lists are refreshed from NSE daily; a stock entering ASM/GSM drops out of the next report.");
  return L.join("\n");
}
