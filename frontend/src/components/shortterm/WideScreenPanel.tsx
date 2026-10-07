"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowUpRight,
  Award,
  ChevronDown,
  ExternalLink,
  Filter,
  ListFilter,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { getWideScreen, runWideScan, StScanParams, WideScanRow, WideStock } from "@/lib/api";
import {
  Button,
  Card,
  Chip,
  Input,
  SearchInput,
  Select,
  ErrorState,
  Skeleton,
} from "@/components/ui";
import { useAuth } from "@/components/auth/useAuth";

const DECISION_TONE: Record<string, "buy" | "amber" | "cyan" | "zinc" | "sell"> = {
  BUY: "buy",
  WAIT: "amber",
  WATCH: "cyan",
  "NO TRADE": "zinc",
};
const HOLDER_TONE: Record<string, "buy" | "amber" | "sell" | "zinc"> = {
  HOLD: "zinc",
  TRAIL: "buy",
  "TAKE PARTIAL": "amber",
  EXIT: "sell",
};
const money = (v: number | null | undefined) => (v == null ? "—" : `₹${v}`);

/*
 * STOCKS UNDER ₹100 — wide-universe screen. Every NSE company (not the
 * 152-stock radar universe) through hard tradeability exclusions
 * (surveillance, penny, illiquid, short history, ETFs), ranked by liquidity
 * and stability. DESCRIPTIVE: it never ranks by expected return, because no
 * signal in this system has earned that (Evidence tab). Filters below narrow
 * the list client-side; they never relax the server's exclusions.
 */

const SORTS = [
  { value: "recommendation", label: "Recommendation (best first)" },
  { value: "score", label: "Tradeability score" },
  { value: "turnover", label: "Turnover (liquidity)" },
  { value: "price", label: "Price (low → high)" },
  { value: "vol", label: "Volatility (low → high)" },
  { value: "drawdown", label: "1y drawdown (shallow first)" },
  { value: "deliv", label: "Delivery % (high first)" },
] as const;
type SortKey = (typeof SORTS)[number]["value"];

const TURNOVER_MIN = [
  { value: "0", label: "Any (≥ ₹2 cr)" },
  { value: "5", label: "≥ ₹5 cr/day" },
  { value: "20", label: "≥ ₹20 cr/day" },
  { value: "50", label: "≥ ₹50 cr/day" },
];

const pct = (v: number | null | undefined, d = 1) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
const cr = (lacs: number | null) => (lacs == null ? "—" : `₹${(lacs / 100).toFixed(1)} cr`);

function sortRows(rows: WideStock[], key: SortKey, recBy?: Map<string, number>): WideStock[] {
  const by = (f: (r: WideStock) => number | null, asc: boolean) =>
    [...rows].sort((a, b) => {
      const x = f(a),
        y = f(b);
      if (x == null) return 1;
      if (y == null) return -1;
      return asc ? x - y : y - x;
    });
  switch (key) {
    case "turnover":
      return by((r) => r.medianTurnoverLacs20, false);
    case "price":
      return by((r) => r.price, true);
    case "vol":
      return by((r) => r.vol60AnnPct, true);
    case "drawdown":
      return by((r) => r.maxDrawdown1yPct, false);
    case "deliv":
      return by((r) => r.avgDelivPct60, false);
    case "recommendation":
      return by((r) => recBy?.get(r.symbol) ?? null, false);
    default:
      return by((r) => r.rank?.score ?? null, false);
  }
}

function PlanBlock({ w, onOpen }: { w: WideScanRow; onOpen: (ticker: string) => void }) {
  const e = w.evaluation;
  const p = e?.plan;
  const ref = w.reference;
  const hasPlan = !!p && (p.entryZoneLow != null || p.entryTriggerPrice != null);
  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={DECISION_TONE[w.decision.newBuyer] ?? "zinc"}>
          New buyer: {w.decision.newBuyer}
        </Chip>
        <Chip tone={HOLDER_TONE[w.decision.holder] ?? "zinc"}>
          If you own it: {w.decision.holder}
        </Chip>
        {e && (
          <Chip tone="zinc">
            {e.setupType.replace(/_/g, " ")} · tier {e.tier}
          </Chip>
        )}
        {e && <Chip tone="zinc">{e.action.replace(/_/g, " ")}</Chip>}
      </div>
      <p className="mt-1.5 text-slate-400">{w.decision.why}.</p>
      {hasPlan && p ? (
        <div className="mt-2 grid gap-x-6 gap-y-1 text-slate-300 sm:grid-cols-2 lg:grid-cols-4">
          <p>
            Entry zone{" "}
            <span className="float-right tabular-nums">
              {p.entryZoneLow != null ? `₹${p.entryZoneLow} – ₹${p.entryZoneHigh}` : "—"}
            </span>
          </p>
          <p>
            Entry trigger{" "}
            <span className="float-right tabular-nums">
              {money(p.entryTriggerPrice as number | null)}
            </span>
          </p>
          <p>
            Stop{" "}
            <span className="float-right tabular-nums text-rose-300">{money(p.initialStop)}</span>
          </p>
          <p>
            Target 1 / 2{" "}
            <span className="float-right tabular-nums text-emerald-300">
              {money(p.target1)} / {money(p.target2)}
            </span>
          </p>
          <p>
            Reward : risk (T1){" "}
            <span className="float-right tabular-nums">{p.rewardRiskToTarget1 ?? "—"}</span>
          </p>
          <p>
            Expected hold{" "}
            <span className="float-right tabular-nums">{p.expectedHoldingDays ?? "—"} days</span>
          </p>
          <p>
            EV after costs{" "}
            <span className="float-right tabular-nums">
              {e?.ev ? `${e.ev.meanEvAfterCostsPct}% (80% low ${e.ev.ev80LowerPct}%)` : "—"}
            </span>
          </p>
          <p>
            Size at your risk{" "}
            <span className="float-right tabular-nums">
              {e?.sizing
                ? `${e.sizing.positionSizeShares} sh · ₹${e.sizing.capitalRequired.toLocaleString("en-IN")}`
                : "—"}
            </span>
          </p>
        </div>
      ) : (
        <p className="mt-2 text-slate-500">
          No setup, so no entry plan — the pipeline does not invent an entry. Reference levels below
          are where price has been, not a forecast.
        </p>
      )}
      {ref && (
        <div className="mt-2 grid gap-x-6 gap-y-1 text-slate-400 sm:grid-cols-2 lg:grid-cols-4">
          <p>
            20d support / resistance{" "}
            <span className="float-right tabular-nums">
              ₹{ref.support20} / ₹{ref.resistance20}
            </span>
          </p>
          <p>
            52-week range{" "}
            <span className="float-right tabular-nums">
              ₹{ref.low52w} – ₹{ref.high52w}
            </span>
          </p>
          <p>
            ATR(14){" "}
            <span className="float-right tabular-nums">
              ₹{ref.atr14} ({ref.atrPct}%)
            </span>
          </p>
          <p>
            Volatility stop (2×ATR){" "}
            <span className="float-right tabular-nums text-rose-300/80">₹{ref.volatilityStop}</span>
          </p>
        </div>
      )}
      {e && e.whyNotEntry && (e.whyNotEntry as unknown as string[]).length > 0 && (
        <p className="mt-2 text-slate-500">
          Why not an entry: {(e.whyNotEntry as unknown as string[]).slice(0, 3).join(" · ")}
        </p>
      )}
      {e && (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            onOpen(w.ticker);
          }}
          className="mt-2 inline-flex items-center gap-1 text-cyan-300 hover:underline"
        >
          Open full short-term detail (entry · exit · AI review · track record){" "}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * The ranked answer to "which of these?". Split is load-bearing: a stock with
 * no tradeable setup can never appear under "best to act on", however good the
 * company looks — that is what keeps this a recommendation and not a tip sheet.
 */
function TopPicks({
  tradeable,
  watch,
  onOpen,
}: {
  tradeable: WideScanRow[];
  watch: WideScanRow[];
  onOpen: (t: string) => void;
}) {
  const Pick = ({ w: row, idx }: { w: WideScanRow; idx: number }) => {
    const p = row.evaluation?.plan;
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-display text-sm font-semibold text-slate-100">
            #{idx + 1} {row.symbol}
          </span>
          <Chip tone={DECISION_TONE[row.decision.newBuyer] ?? "zinc"}>{row.decision.newBuyer}</Chip>
          {row.evaluation && <Chip tone="zinc">tier {row.evaluation.tier}</Chip>}
          <span className="ml-auto text-[11px] text-slate-500">
            score {row.recommendation.score}
          </span>
        </div>
        {p?.entryZoneLow != null && (
          <p className="mt-1.5 tabular-nums text-slate-300">
            Entry ₹{p.entryZoneLow}–{p.entryZoneHigh} · stop{" "}
            <span className="text-rose-300">₹{p.initialStop}</span> · T1{" "}
            <span className="text-emerald-300">₹{p.target1}</span>
            {p.rewardRiskToTarget1 != null && <> · R:R {p.rewardRiskToTarget1}</>}
          </p>
        )}
        {row.recommendation.reasons.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-slate-400">
            {row.recommendation.reasons.slice(0, 3).map((x, k) => (
              <li key={k}>+ {x}</li>
            ))}
          </ul>
        )}
        {row.recommendation.cautions.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-amber-200/70">
            {row.recommendation.cautions.slice(0, 3).map((x, k) => (
              <li key={k}>− {x}</li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => onOpen(row.ticker)}
          className="mt-1.5 inline-flex items-center gap-1 text-cyan-300 hover:underline"
        >
          Full detail <ArrowUpRight className="h-3 w-3" aria-hidden />
        </button>
      </div>
    );
  };

  return (
    <section className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.03] p-3 text-xs">
      <p className="flex items-center gap-2 font-medium text-slate-200">
        <Award className="h-4 w-4 text-cyan-300" aria-hidden /> Best of this list, ranked
      </p>
      {tradeable.length > 0 ? (
        <>
          <p className="mt-0.5 text-slate-500">Cleared for entry by the pipeline, best first.</p>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {tradeable.slice(0, 4).map((r, i) => (
              <Pick key={r.symbol} w={r} idx={i} />
            ))}
          </div>
        </>
      ) : (
        <p className="mt-0.5 text-slate-400">
          <span className="text-slate-300">Nothing is cleared for entry today.</span> No stock at
          this price cap has a confirmed setup that passes the evidence and cost gates — that is a
          real answer, not a gap. The strongest watch candidates are below.
        </p>
      )}
      {watch.length > 0 && (
        <>
          <p className="mt-3 text-slate-500">
            Strongest without a tradeable setup — watch, do not buy on this alone:
          </p>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {watch.slice(0, tradeable.length > 0 ? 2 : 4).map((r, i) => (
              <Pick key={r.symbol} w={r} idx={i} />
            ))}
          </div>
        </>
      )}
      <p className="mt-2 text-[11px] text-slate-600">
        Ranked on measured things: setup evidence and its priced plan, liquidity and stability,
        minus known risks from the knowledge base. It is a quality-of-opportunity order, NOT a
        prediction of which will rise — no directional signal in this system has passed its
        pre-registered test.
      </p>
    </section>
  );
}

function StockRow({
  r,
  i,
  w,
  onOpen,
  expandedMetrics,
}: {
  r: WideStock;
  i: number;
  w: WideScanRow | undefined;
  onOpen: (ticker: string) => void;
  expandedMetrics: boolean;
}) {
  const [open, setOpen] = useState(false);
  const p = w?.evaluation?.plan;
  return (
    <>
      <tr
        className={clsx(
          "screener-stock-row cursor-pointer hover:bg-white/[0.03]",
          open && "screener-stock-row-open",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-2 py-2 tabular-nums text-slate-600">{i + 1}</td>
        <td className="px-2 py-2">
          <button
            type="button"
            className="screener-stock-name"
            aria-expanded={open}
            aria-controls={`screener-detail-${r.symbol}`}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            {r.symbol}
          </button>
          {r.facts.length > 0 && (
            <span className="ml-1.5 rounded bg-cyan-400/10 px-1 text-[10px] text-cyan-300">
              {r.facts.length} facts
            </span>
          )}
          {r.corporateActionSuspect && (
            <span
              className="ml-1 text-[10px] text-amber-300"
              title="A >25% one-day print — bonus/split or shock; unadjusted returns unreliable"
            >
              ⚠
            </span>
          )}
          <p className="max-w-[220px] truncate text-[11px] text-slate-500">{r.companyName ?? ""}</p>
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-200">₹{r.price.toFixed(2)}</td>
        <td className="px-2 py-2">
          {w ? (
            <Chip tone={DECISION_TONE[w.decision.newBuyer] ?? "zinc"}>{w.decision.newBuyer}</Chip>
          ) : (
            <span className="text-slate-600">—</span>
          )}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-300">
          {p?.entryZoneLow != null ? (
            `₹${p.entryZoneLow}–${p.entryZoneHigh}`
          ) : (
            <span className="text-slate-600">{w ? "No setup" : "Not evaluated"}</span>
          )}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-rose-300/90">
          {money(p?.initialStop ?? w?.reference?.volatilityStop ?? null)}
          {p?.initialStop == null && w?.reference ? (
            <span className="text-[10px] text-slate-600"> ref</span>
          ) : null}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-emerald-300/90">
          {money(p?.target1 ?? null)}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-400">
          {cr(r.medianTurnoverLacs20)}
        </td>
        {expandedMetrics && (
          <>
            <td className="px-2 py-2 text-right tabular-nums text-slate-400">
              {r.avgDelivPct60 != null ? `${r.avgDelivPct60.toFixed(0)}%` : "—"}
            </td>
            <td
              className={clsx(
                "px-2 py-2 text-right tabular-nums",
                (r.ret20Pct ?? 0) >= 0 ? "text-slate-300" : "text-slate-400",
              )}
            >
              {pct(r.ret20Pct)}
            </td>
            <td className="px-2 py-2 text-right tabular-nums text-slate-400">
              {pct(r.ret250Pct, 0)}
            </td>
            <td className="px-2 py-2 text-right tabular-nums text-slate-400">
              {r.vol60AnnPct != null ? `${r.vol60AnnPct.toFixed(0)}%` : "—"}
            </td>
            <td className="px-2 py-2 text-right tabular-nums text-slate-400">
              {pct(r.maxDrawdown1yPct, 0)}
            </td>
            <td className="px-2 py-2 text-[11px] text-slate-500">{r.industry ?? "—"}</td>
          </>
        )}
        <td className="px-2 py-2 text-right tabular-nums text-slate-300">
          {r.passed ? (
            <span className="screener-score">{(r.rank?.score ?? 0).toFixed(2)}</span>
          ) : (
            <span className="text-rose-300">excluded</span>
          )}
        </td>
        <td className="px-1 py-2">
          <button
            type="button"
            aria-label={`${open ? "Hide" : "Show"} ${r.symbol} facts and sources`}
            aria-expanded={open}
            aria-controls={`screener-detail-${r.symbol}`}
            className="radar-row-expand"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            <ChevronDown
              className={clsx("h-3.5 w-3.5 transition", open && "rotate-180")}
              aria-hidden
            />
          </button>
        </td>
      </tr>
      {open && (
        <tr id={`screener-detail-${r.symbol}`}>
          <td
            colSpan={expandedMetrics ? 16 : 10}
            className="screener-detail-cell bg-white/[0.015] px-4 py-3 text-xs"
          >
            {w ? (
              <PlanBlock w={w} onOpen={onOpen} />
            ) : (
              <p className="mb-2 text-slate-500">
                Entry/exit not evaluated yet — press “Evaluate entry &amp; exit”.
              </p>
            )}
            <p className="text-slate-400">
              {r.industry ?? "Industry n/a"} ·{" "}
              {r.indices.length ? r.indices.join(", ") : "not in any NSE broad index"} · listed{" "}
              {r.listingDate ?? "n/a"} · {Math.round(r.medianTrades20 ?? 0).toLocaleString("en-IN")}{" "}
              trades/day · 60d {pct(r.ret60Pct)} · {pct(r.pctFrom1yHigh, 0)} from 1y high
            </p>
            {!r.passed && (
              <p className="mt-1.5 text-rose-300">Excluded: {r.exclusions.join("; ")}</p>
            )}
            {r.flags.length > 0 && (
              <p className="mt-1.5 text-amber-200/80">Flags: {r.flags.join("; ")}.</p>
            )}
            {r.facts.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {r.facts.map((f, k) => (
                  <li key={k} className="text-slate-300">
                    <span className="mr-1.5 rounded bg-white/5 px-1 text-[10px] uppercase tracking-wide text-slate-400">
                      {f.kind}
                    </span>
                    {f.sentiment && (
                      <span
                        className={clsx(
                          "mr-1.5 rounded px-1 text-[10px] uppercase tracking-wide",
                          f.sentiment === "POSITIVE"
                            ? "bg-emerald-400/10 text-emerald-300"
                            : f.sentiment === "NEGATIVE"
                              ? "bg-rose-400/10 text-rose-300"
                              : "bg-white/5 text-slate-400",
                        )}
                      >
                        {f.sentiment.toLowerCase()} · {(f.materiality ?? "").toLowerCase()}
                      </span>
                    )}
                    {f.fact}{" "}
                    <span className="text-slate-600">
                      ({f.observedAt}, {f.confidence.toLowerCase()} confidence)
                    </span>
                    {f.sourceUrl && (
                      <a
                        href={f.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-1 inline-flex items-center gap-0.5 text-cyan-300 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        source <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-slate-500">
                No researched facts yet for this stock — numbers only.
              </p>
            )}
            <p className="mt-2 text-slate-500">
              Direction: <span className="font-medium text-slate-300">no call</span> — the system
              has no demonstrated skill at predicting which of these rise.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

export function WideScreenPanel({
  scanParams,
  onOpen,
}: {
  scanParams: StScanParams;
  onOpen: (ticker: string) => void;
}) {
  const q = useQuery({
    queryKey: ["wide-screen"],
    queryFn: () => getWideScreen(),
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const { auth } = useAuth();
  const signedIn = auth?.status === "authenticated";
  const evalM = useMutation({ mutationFn: (p: StScanParams) => runWideScan(p) });
  const [decisionFilter, setDecisionFilter] = useState("ALL");
  const [maxPrice, setMaxPrice] = useState("100");
  const evalBy = useMemo(
    () => new Map((evalM.data?.rows ?? []).map((w) => [w.symbol, w])),
    [evalM.data],
  );
  const evalParams = useMemo<StScanParams>(
    () => ({
      budgetInr: scanParams.budgetInr,
      horizon: scanParams.horizon,
      riskPerTradePct: scanParams.riskPerTradePct,
      strategy: "ALL",
    }),
    [scanParams.budgetInr, scanParams.horizon, scanParams.riskPerTradePct],
  );
  // Evaluate once automatically when the list is loaded and the user is signed in.
  const autoRan = useRef(false);
  useEffect(() => {
    if (q.data && signedIn && !autoRan.current) {
      autoRan.current = true;
      evalM.mutate(evalParams);
    }
  }, [q.data, signedIn, autoRan, evalM, evalParams]);
  const [industry, setIndustry] = useState("ALL");
  const [minTurnover, setMinTurnover] = useState("0");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recommendation");
  const [showExcluded, setShowExcluded] = useState(false);
  const [onlyWithFacts, setOnlyWithFacts] = useState(false);
  const [limit, setLimit] = useState(12);
  const [expandedMetrics, setExpandedMetrics] = useState(false);

  const industries = useMemo(() => {
    const s = new Set<string>();
    for (const r of q.data?.stocks ?? []) if (r.industry) s.add(r.industry);
    return ["ALL", ...[...s].sort()];
  }, [q.data]);

  const rows = useMemo(() => {
    const all = q.data?.stocks ?? [];
    const mt = Number(minTurnover) * 100;
    const needle = search.trim().toUpperCase();
    const filtered = all.filter(
      (r) =>
        (showExcluded || r.passed) &&
        (industry === "ALL" || r.industry === industry) &&
        (!maxPrice || (r.price ?? 0) <= Number(maxPrice)) &&
        (r.medianTurnoverLacs20 ?? 0) >= mt &&
        (!onlyWithFacts || r.facts.length > 0) &&
        (decisionFilter === "ALL" || evalBy.get(r.symbol)?.decision.newBuyer === decisionFilter) &&
        (!needle ||
          r.symbol.includes(needle) ||
          (r.companyName ?? "").toUpperCase().includes(needle)),
    );
    return sortRows(filtered, sort);
  }, [
    q.data,
    maxPrice,
    industry,
    minTurnover,
    search,
    sort,
    showExcluded,
    onlyWithFacts,
    decisionFilter,
    evalBy,
  ]);

  const notDeployed =
    q.isError && /404|not found/i.test(q.error instanceof Error ? q.error.message : "");

  return (
    <Card className="radar-research-panel screener-panel">
      <div className="radar-panel-heading">
        <div>
          <p className="flex items-center gap-2 font-display text-sm font-semibold text-slate-200">
            <Filter className="h-4 w-4 text-cyan-300" aria-hidden /> Stocks under ₹100 — whole NSE
          </p>
          <p className="mt-0.5 max-w-3xl text-xs text-slate-500">
            Every listed company, filtered for <span className="text-slate-300">tradeability</span>:
            no exchange surveillance, ≥ ₹5, ≥ 1 year listed, ≥ ₹2 cr/day turnover. Ranked by
            liquidity + stability, never by past return.
          </p>
        </div>
        {q.data && (
          <div className="flex flex-wrap gap-1.5">
            <Chip tone="zinc">
              {q.data.screen.under100} at or below ₹{q.data.screen.rules.maxPrice}
            </Chip>
            <Chip tone="buy">{q.data.screen.passed} pass</Chip>
            <Chip tone="zinc">data {q.data.screen.asOf}</Chip>
            <Chip tone="zinc">{q.data.knowledgeCoverage.withFacts} researched</Chip>
          </div>
        )}
      </div>

      {q.data && (
        <p className="radar-evidence-caveat screener-evidence-note">
          <ShieldAlert aria-hidden />
          {q.data.evidenceStatus}
        </p>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <label className="text-xs text-slate-500">
          Max price ₹
          <Input
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value.replace(/[^\d]/g, ""))}
            className="mt-1"
          />
        </label>
        <label className="text-xs text-slate-500">
          Industry
          <Select
            value={industry}
            onChange={setIndustry}
            options={industries.map((x) => ({
              value: x,
              label: x === "ALL" ? "All industries" : x,
            }))}
            className="mt-1"
          />
        </label>
        <label className="text-xs text-slate-500">
          Min turnover
          <Select
            value={minTurnover}
            onChange={setMinTurnover}
            options={TURNOVER_MIN}
            className="mt-1"
          />
        </label>
        <label className="text-xs text-slate-500">
          Sort by
          <Select
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            options={SORTS.map((s) => ({ value: s.value, label: s.label }))}
            className="mt-1"
          />
        </label>
        <label className="text-xs text-slate-500 sm:col-span-2">
          Search
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Symbol or company"
            className="mt-1"
          />
        </label>
      </div>
      <div className="screener-evaluation-row">
        <Select
          ariaLabel="Filter by new buyer decision"
          value={decisionFilter}
          onChange={(v) => {
            setDecisionFilter(v);
            setLimit(12);
          }}
          options={["ALL", "BUY", "WAIT", "WATCH", "NO TRADE"].map((x) => ({
            value: x,
            label: x === "ALL" ? "All decisions" : x,
          }))}
          className="screener-decision-filter"
        />
        <Button
          variant="secondary"
          loading={evalM.isPending}
          onClick={() => evalM.mutate(evalParams)}
          disabled={!signedIn || !q.data}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {evalM.isPending ? "Evaluating entry & exit…" : "Evaluate entry & exit"}
        </Button>
        <span className="radar-control-hint">
          {!signedIn
            ? "Sign in to evaluate entry/exit (it records a scan run)."
            : evalM.data
              ? `${evalM.data.evaluated} evaluated · ${evalM.data.qualifiedCount} qualified · market ${evalM.data.marketSession.toLowerCase()} · uses your budget ₹${scanParams.budgetInr ?? "—"}, ${scanParams.horizon}, ${scanParams.riskPerTradePct}% risk`
              : "Uses the budget, horizon and risk from Scan parameters above."}
        </span>
      </div>
      {evalM.isError && (
        <p className="mt-2 text-xs text-rose-300">
          {evalM.error instanceof Error ? evalM.error.message : "Evaluation failed."}
        </p>
      )}
      {evalM.data && <p className="mt-2 text-[11px] text-slate-500">{evalM.data.note}</p>}
      <div className="screener-display-controls">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={onlyWithFacts}
            onChange={(e) => setOnlyWithFacts(e.target.checked)}
          />{" "}
          Only researched stocks
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showExcluded}
            onChange={(e) => setShowExcluded(e.target.checked)}
          />{" "}
          Show excluded (with reasons)
        </label>
        <button
          type="button"
          className="screener-metrics-toggle"
          aria-pressed={expandedMetrics}
          onClick={() => setExpandedMetrics((v) => !v)}
        >
          <ListFilter aria-hidden />
          {expandedMetrics ? "Essential columns" : "All metrics"}
        </button>
      </div>

      {evalM.data && (
        <TopPicks tradeable={evalM.data.tradeable} watch={evalM.data.watch} onOpen={onOpen} />
      )}

      {evalM.data && (
        <TopPicks tradeable={evalM.data.tradeable} watch={evalM.data.watch} onOpen={onOpen} />
      )}

      {q.isPending && (
        <div className="radar-table-loading" role="status">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
          <span className="sr-only">Loading the whole-market screen…</span>
        </div>
      )}
      {notDeployed && (
        <ErrorState
          message="The stock screener is not available yet. Try again once the research engine has prepared the report."
          onRetry={() => q.refetch()}
        />
      )}
      {q.isError && !notDeployed && (
        <ErrorState
          message={q.error instanceof Error ? q.error.message : "Screen failed to load."}
          onRetry={() => q.refetch()}
        />
      )}

      {q.data && (
        <>
          <div
            className="radar-table-scroll"
            role="region"
            aria-label="Stock screener, scroll horizontally for all columns"
            tabIndex={0}
          >
            <table
              className={clsx(
                "radar-data-table screener-data-table",
                expandedMetrics && "screener-table-all-metrics",
              )}
            >
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">#</th>
                  <th className="px-2 py-1.5">Stock</th>
                  <th className="px-2 py-1.5 text-right">Price</th>
                  <th className="px-2 py-1.5">Decision</th>
                  <th className="px-2 py-1.5 text-right">Entry zone</th>
                  <th className="px-2 py-1.5 text-right">Stop</th>
                  <th className="px-2 py-1.5 text-right">Target 1</th>
                  <th className="px-2 py-1.5 text-right">Turnover/day</th>
                  {expandedMetrics && (
                    <>
                      <th className="px-2 py-1.5 text-right">Delivery</th>
                      <th className="px-2 py-1.5 text-right">20d</th>
                      <th className="px-2 py-1.5 text-right">1y</th>
                      <th className="px-2 py-1.5 text-right">Volatility</th>
                      <th className="px-2 py-1.5 text-right">1y drawdown</th>
                      <th className="px-2 py-1.5">Industry</th>
                    </>
                  )}
                  <th className="px-2 py-1.5 text-right">Score</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {rows.slice(0, limit).map((r, i) => (
                  <StockRow
                    key={r.symbol}
                    r={r}
                    i={i}
                    w={evalBy.get(r.symbol)}
                    onOpen={onOpen}
                    expandedMetrics={expandedMetrics}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <div className="radar-filter-empty">
              <Search aria-hidden />
              <h3>No stocks match these filters.</h3>
              <p>Try a different company, price ceiling or industry.</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setMaxPrice("100");
                  setIndustry("ALL");
                  setMinTurnover("0");
                  setSearch("");
                  setDecisionFilter("ALL");
                  setOnlyWithFacts(false);
                  setShowExcluded(false);
                  setLimit(12);
                }}
              >
                Reset filters
              </Button>
            </div>
          )}
          <div className="radar-panel-footer">
            <span>
              Showing {Math.min(limit, rows.length)} of {rows.length} stocks · expand for facts and
              sources
            </span>
            {rows.length > limit && (
              <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + 12)}>
                Show more
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
          <p className="radar-evidence-caveat">
            <ShieldAlert aria-hidden />
            <span>{q.data.screen.caveat}</span>
          </p>
        </>
      )}
    </Card>
  );
}
