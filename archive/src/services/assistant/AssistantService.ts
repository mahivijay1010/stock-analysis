/**
 * AssistantService — the in-app stock assistant.
 *
 * Deterministic intent router over the app's OWN live services (quotes,
 * analysis, top picks, allocation, accuracy, holdings math, market regime,
 * glossary). No LLM, no external API, no fabricated numbers: every figure in
 * a reply comes from the same code paths the UI uses.
 *
 * SCOPE GUARD: it answers Indian stock-market questions ONLY. Anything else —
 * coding, homework, general chat — gets a polite refusal with suggestions.
 */

import { marketDataService } from "../market/MarketDataService";
import { macroService } from "../market/MacroService";
import { stockService } from "../StockService";
import { portfolioService } from "../portfolio/PortfolioService";
import { holdingsService } from "../holdings/HoldingsService";
import { AssistantResponse, PortfolioStrategy } from "../../types";

const inr = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inr0 = (x: number): string => `₹${Math.round(x).toLocaleString("en-IN")}`;
const sgn = (x: number, dp = 2): string => `${x >= 0 ? "+" : ""}${x.toFixed(dp)}%`;

const DEFAULT_SUGGESTIONS = [
  "Top 5 stocks today",
  "Should I buy TCS?",
  "Split ₹10,000 for me",
  "How accurate are your predictions?",
  "How is the market today?",
];

/** Static educational definitions — concepts, not market data. */
const GLOSSARY: Record<string, string> = {
  rsi: "RSI (Relative Strength Index, 14-day) measures momentum from 0–100. Above 70 = overbought (wait for a pullback), below 30 = oversold (accumulate only if fundamentals are intact). This app computes it with Wilder smoothing on real daily closes.",
  macd: "MACD (12/26/9) tracks trend momentum: the MACD line is the gap between a fast and slow average; crossing above its signal line is bullish, below is bearish. The histogram shows that gap changing.",
  peg: "PEG ratio = P/E ÷ expected earnings growth. Under 1.5 is reasonable, under 1.0 is attractive — you pay less for each unit of growth. It is Phase 5 (valuation) in this app's framework.",
  "ev/ebitda": "EV/EBITDA compares a company's full value (equity + debt − cash) to its operating profit. It neutralises debt and tax differences; under ~12 is generally healthy for Indian large caps.",
  "stop loss": "A stop-loss is the price where you exit no matter what — it caps the maximum loss per trade. This app sets it at max(2×ATR, 5–7.5%) below entry and pairs it with a 3:1 target, so one loss costs a third of one win.",
  bollinger: "Bollinger Bands wrap a 20-day average with ±2 standard deviations. %B near 1 means price is stretched high; near 0, stretched low — useful for mean-reversion at extremes.",
  atr: "ATR (Average True Range, 14-day) measures how much a stock actually moves per day in rupees. This app uses 2×ATR to place stops so normal noise does not shake you out.",
  drawdown: "Max drawdown is the worst peak-to-trough fall over a period — the pain you must be able to sit through. Over 40% in a year marks a stock as HIGH risk here.",
  sma: "An SMA (simple moving average) smooths price over N days. Price above a rising 200-day SMA = long-term uptrend; the 50/200 crossover (golden/death cross) is a classic regime signal.",
  "2% rule": "The 2% rule: never risk more than 2% of your total capital on one trade. Position size = (capital × 2%) ÷ (entry − stop). It guarantees a losing streak cannot destroy the account.",
  "reward risk": "Reward:risk of 3:1 means the target gain is 3× the stop-loss distance. At 3:1 you stay profitable even winning only ~35% of trades — discipline beats prediction.",
};

const OFF_TOPIC_REPLY =
  "I only help with Indian stock-market questions — live prices, analysis and BUY/HOLD/AVOID verdicts, today's top picks, splitting an amount across stocks, profit you can book on a holding, prediction accuracy, market regime, or explaining terms like RSI and PEG. Ask me one of those.";

/** Words that hint the user is asking about something other than stocks. */
const NON_STOCK_PATTERNS =
  /\b(code|coding|program|python|javascript|typescript|java\b|c\+\+|sql|html|css|react|api key|homework|essay|poem|story|recipe|cook|movie|song|cricket|football|weather|joke|translate|math problem|resume|cover letter)\b/i;

function parseAmount(text: string): number | null {
  // ₹10,000 | 10000 | 10k | 1.5 lakh | 2 lac | 1 crore
  const m = text
    .toLowerCase()
    .match(/(?:₹|rs\.?\s*)?([\d,]+(?:\.\d+)?)\s*(k|thousand|lakh|lakhs|lac|lacs|crore|crores|cr)?\b/);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = m[2];
  const mult =
    unit === "k" || unit === "thousand"
      ? 1_000
      : unit && unit.startsWith("lak")
        ? 100_000
        : unit && (unit.startsWith("lac") || unit === "lacs")
          ? 100_000
          : unit && (unit.startsWith("cr") || unit.startsWith("crore"))
            ? 10_000_000
            : 1;
  return base * mult;
}

/** Try to resolve a ticker/company mentioned anywhere in the message. */
async function findTicker(text: string): Promise<{ ticker: string; name: string } | null> {
  const cleaned = text
    .replace(/[?.!,]/g, " ")
    .replace(
      /\b(should|i|buy|sell|hold|analyse|analyze|analysis|of|about|stock|share|price|quote|what|is|the|for|in|me|tell|give|current|today|now|please|can|you|do|a|an|how|much|will|worth|invest|good|bad|idea)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  // Try the longest remaining phrase first, then individual words (longest first).
  const candidates = [cleaned, ...cleaned.split(" ").filter((w) => w.length >= 3).sort((a, b) => b.length - a.length)];
  for (const cand of candidates.slice(0, 4)) {
    try {
      const r = await marketDataService.resolve(cand);
      if (r) return { ticker: r.ticker, name: r.name };
    } catch {
      /* resolution error → try the next candidate */
    }
  }
  return null;
}

export class AssistantService {
  async answer(rawMessage: string): Promise<AssistantResponse> {
    const message = (rawMessage ?? "").trim().slice(0, 500);
    if (!message) {
      return { reply: OFF_TOPIC_REPLY, suggestions: DEFAULT_SUGGESTIONS, offTopic: true };
    }
    const lower = message.toLowerCase();

    // Hard scope guard first.
    if (NON_STOCK_PATTERNS.test(lower)) {
      return { reply: OFF_TOPIC_REPLY, suggestions: DEFAULT_SUGGESTIONS, offTopic: true };
    }

    try {
      // Greeting / help
      if (/^(hi|hii+|hello|hey|namaste|help|what can you do|start)\b/.test(lower)) {
        return {
          reply:
            "Namaste! I'm the StockSense assistant — I answer Indian stock-market questions using this app's live data:\n" +
            "• \"price of SBIN\" — live quote\n" +
            "• \"should I buy Reliance?\" — full verdict with score, forecast ranges and reasons\n" +
            "• \"top stocks today\" — the ranked picks\n" +
            "• \"split ₹10,000\" (add \"long term\" if you want quality over momentum)\n" +
            "• \"bought Suzlon at ₹10 with ₹10,000 — profit?\"\n" +
            "• \"how accurate are you?\" / \"how is the market?\" / \"what is RSI?\"",
          suggestions: DEFAULT_SUGGESTIONS,
          offTopic: false,
        };
      }

      // Glossary
      for (const [term, definition] of Object.entries(GLOSSARY)) {
        if (
          new RegExp(`(what\\s+is|what's|explain|meaning\\s+of|define)\\s+.*\\b${term.replace("/", "\\/?")}\\b`, "i").test(lower) ||
          new RegExp(`^\\s*${term.replace("/", "\\/?")}\\s*\\??\\s*$`, "i").test(lower)
        ) {
          return {
            reply: definition,
            suggestions: ["Should I buy TCS?", "Top 5 stocks today", "What is the 2% rule?"],
            offTopic: false,
          };
        }
      }

      // Accuracy
      if (/(accurate|accuracy|hit rate|track record|how good|success rate|backtest)/.test(lower)) {
        const acc = await stockService.getAccuracy();
        const rows = acc.overall
          .map(
            (h) =>
              `• ${h.horizonDays}d: direction ${h.directionHitRatePct.toFixed(1)}% over ${h.samples.toLocaleString("en-IN")} predictions, avg error ±${h.avgAbsErrorPct.toFixed(2)}%, real price inside the 80% band ${h.withinBandPct.toFixed(1)}%`
          )
          .join("\n");
        return {
          reply:
            `Honest, measured numbers from walk-forward backtests (predict at day T with data up to T only, verify against the real later price):\n${rows}\n\n` +
            `Read: up/down direction is close to a coin flip for everyone — the value is in the calibrated ranges (~85% coverage), the ranking and the risk discipline. Anyone promising 90%+ direction accuracy is lying.`,
          suggestions: ["Top 5 stocks today", "How is the market today?", "Split ₹10,000 for me"],
          offTopic: false,
        };
      }

      // Market regime
      if (/(how('| i)?s the market|market (today|now|mood|condition|regime)|nifty|vix|sensex)/.test(lower)) {
        const r = await macroService.getMarketRegime();
        return {
          reply:
            `Market regime: ${r.regime.toUpperCase()} (${Math.round(r.score)}/100)\n` +
            `• NIFTY 50 ${r.nifty.price.toLocaleString("en-IN")}: ${sgn(r.nifty.vs50dmaPct, 1)} vs 50DMA, ${sgn(r.nifty.vs200dmaPct, 1)} vs 200DMA, 20-day ${sgn(r.nifty.r20dPct, 1)} — trend ${r.nifty.trend}\n` +
            `• India VIX ${r.vix.value.toFixed(2)} (${r.vix.zone})\n` +
            `• USDINR ${r.usdinr.value.toFixed(2)} (${r.usdinr.trend.replace(/-/g, " ")})\n\n` +
            (r.regime === "risk-off"
              ? "Risk-off: the allocation engine deploys only 50% and keeps the rest in cash — capital preservation first."
              : r.regime === "neutral"
                ? "Neutral: the allocation engine deploys 80% and keeps 20% dry."
                : "Risk-on: full deployment is justified, discipline still applies."),
          suggestions: ["Top 5 stocks today", "Split ₹10,000 for me", "Should I buy HDFC Bank?"],
          offTopic: false,
        };
      }

      // Top picks
      if (/(top|best)\s+(5\s+)?(stocks?|picks?|shares?)|which stocks? (to|should)/.test(lower)) {
        const top = await stockService.getTopPicks(5);
        const rows = top.picks
          .map((p) => {
            const p7 = p.predictions.find((x) => x.horizonDays === 7);
            return `${p.rank}. ${p.name} (${p.ticker}) — ${inr(p.price)}, score ${Math.round(p.score)}, ${p.recommendation}, ${p.riskLevel} risk${p7 ? `, 7d expected ${sgn(p7.expectedReturnPct)} (range ${sgn(p7.low80Pct)}..${sgn(p7.high80Pct)})` : ""}`;
          })
          .join("\n");
        return {
          reply: `Today's top ${top.picks.length} of ${top.scannedCount} scanned (by quant score):\n${rows}\n\nOpen a stock in the Analyze tab for the full 8-phase breakdown, or ask me "should I buy <name>?".`,
          suggestions: top.picks.slice(0, 3).map((p) => `Should I buy ${p.name}?`),
          offTopic: false,
        };
      }

      // V6: research brief — "research/brief/thesis on X" → summarized brief.
      if (/\b(research|brief|thesis)\b/.test(lower)) {
        const rt = await findTicker(
          message.replace(/\b(research|brief|thesis|report|on|write|full|detailed|quick)\b/gi, " ")
        );
        if (rt) {
          const b = await stockService.getResearchBrief(rt.ticker);
          const f30 = b.forecast.find((x) => x.horizonDays === 30);
          const bull = b.bullCase.slice(0, 3).map((x) => `• ${x}`).join("\n");
          const bear = b.bearCase.slice(0, 3).map((x) => `• ${x}`).join("\n");
          return {
            reply:
              `Research brief — ${b.name} (${b.ticker}${b.sector ? `, ${b.sector}` : ""})\n` +
              `Verdict: ${b.verdict.recommendation} — quant ${b.verdict.quantScore}/100` +
              (b.verdict.masterScore != null
                ? `, Master Score ${b.verdict.masterScore.toFixed(1)}/100`
                : "") +
              `, ${b.verdict.riskLevel} risk; entry ${b.verdict.entryAction.replace(/_/g, " ")} ` +
              `(timing ${b.verdict.timingScore}/100)\n\n` +
              `${b.thesis.split("\n\n")[0]}\n` +
              (bull ? `\nBull case:\n${bull}\n` : "") +
              (bear ? `\nBear case:\n${bear}\n` : "") +
              (f30
                ? `\n30d forecast: ${sgn(f30.expectedPct)} (80% range ${sgn(f30.low80Pct)}..${sgn(f30.high80Pct)}), ` +
                  `P(gain) ${(f30.pop * 100).toFixed(0)}%\n`
                : "") +
              `\n${b.accuracyContext}\n\nThe full brief (key numbers, risks, news context) is on the Analyze tab.`,
            suggestions: [
              `Should I buy ${b.name}?`,
              `price of ${b.name}`,
              "How accurate are you?",
            ],
            offTopic: false,
          };
        }
        return {
          reply:
            'Tell me which stock you want the brief on — e.g. "research brief on TCS" or "thesis on Reliance".',
          suggestions: ["research brief on TCS", "thesis on Reliance", "Top 5 stocks today"],
          offTopic: false,
        };
      }

      // Holdings profit: "bought X at 10, 1000 shares / with ₹10,000"
      if (/\b(bought|holding|i have|purchased)\b/.test(lower) && /\b(at|@|price)\b/.test(lower)) {
        const t = await findTicker(message);
        if (t) {
          const priceM = lower.match(/(?:at|@|price of?)\s*(?:₹|rs\.?\s*)?([\d,]+(?:\.\d+)?)/);
          const qtyM = lower.match(/([\d,]+)\s*(?:shares?|qty|quantity)/);
          const amtM = lower.match(/(?:with|invested|investment of?)\s*(?:₹|rs\.?\s*)?([\d,]+(?:\.\d+)?)\s*(k|lakh|lac|crore)?/);
          const buyPrice = priceM ? Number(priceM[1].replace(/,/g, "")) : null;
          if (buyPrice && buyPrice > 0) {
            const quantity = qtyM ? Number(qtyM[1].replace(/,/g, "")) : undefined;
            const amount = !quantity && amtM ? parseAmount(amtM[0]) ?? undefined : undefined;
            if (quantity || amount) {
              const r = await holdingsService.calculate({
                ticker: t.ticker,
                buyPrice,
                quantity,
                amount,
              });
              return {
                reply:
                  `${r.name} (${r.ticker}): ${r.quantity} share${r.quantity === 1 ? "" : "s"} @ ${inr(r.buyPrice)} → now ${inr(r.currentPrice)}\n` +
                  `• Invested ${inr(r.invested)} → worth ${inr(r.currentValue)}\n` +
                  `• Book now: net ${r.netProfit >= 0 ? "profit" : "loss"} ${inr(Math.abs(r.netProfit))} (${sgn(r.netProfitPct)}) after ${inr(r.fees.roundTrip)} fees\n\n${r.note}`,
                suggestions: [`Should I buy ${r.name}?`, "Top 5 stocks today", "How accurate are you?"],
                offTopic: false,
              };
            }
            return {
              reply: `Tell me the position size too — e.g. "bought ${t.name} at ₹${buyPrice} with ₹10,000" or "... 500 shares". You can also use the profit calculator on the Analyze tab.`,
              suggestions: [`bought ${t.name} at ${buyPrice} with ₹10,000`],
              offTopic: false,
            };
          }
        }
      }

      // Allocation: "split/invest/allocate ₹N"
      if (/(split|allocate|distribute|diversify|invest)\b/.test(lower) && parseAmount(lower) !== null) {
        const amount = parseAmount(lower)!;
        if (amount >= 100 && amount <= 100_000_000) {
          const strategy: PortfolioStrategy = /long[\s-]?term|quality|compound/.test(lower)
            ? "long-term"
            : /short[\s-]?term|swing|momentum/.test(lower)
              ? "short-term"
              : "balanced";
          const { allocation, reason } = await portfolioService.suggest(amount, strategy);
          if (!allocation) {
            return {
              reply: reason ?? "No qualified setup right now — holding cash is the right move.",
              suggestions: ["Top 5 stocks today", "How is the market today?"],
              offTopic: false,
            };
          }
          const legs = allocation.stocks
            .map((s) => `• ${s.qty} × ${s.name} (${s.ticker}, ${s.sector}) = ${inr(s.invested)} — stop ${s.stopLoss != null ? inr(s.stopLoss) : "n/a"}${s.masterScore != null ? `, Master Score ${s.masterScore.toFixed(0)}` : ""}, momentum ${s.score}`)
            .join("\n");
          const o30 = allocation.outcomes.find((o) => o.horizonDays === 30);
          return {
            reply:
              `${strategy.toUpperCase()} split of ${inr0(amount)} (deployed ${inr(allocation.cashUsed)}, cash kept ${inr(allocation.cashLeft)} — ${allocation.cashReservePct}% regime reserve):\n${legs}\n` +
              (o30
                ? `\n30-day combined: expected ${inr(o30.expectedValue)} (${sgn(o30.expectedProfitPct)}), 80% range ${inr(o30.lowValue)}–${inr(o30.highValue)}.`
                : "") +
              `\nFull reasoning, evidence and tranche plan are on the Portfolio tab. Estimates, not guarantees.`,
            suggestions: [
              `split ${inr0(amount)} long term`,
              "Top 5 stocks today",
              "How accurate are you?",
            ],
            offTopic: false,
          };
        }
      }

      // V5: entry timing — "buy today or wait?" / "right time to buy?" / "good entry?"
      if (
        /buy\s+.*\btoday\b|today or wait|\bor wait\b|right time to buy|when (should|to) (i )?(buy|enter)|\bentry\b|good time to buy/.test(
          lower
        )
      ) {
        const tt = await findTicker(
          message.replace(/\b(wait|or|right|time|entry|enter|when|good)\b/gi, " ")
        );
        if (tt) {
          const a = await stockService.analyze(tt.ticker);
          const et = a.entryTiming;
          const actionText =
            et.action === "BUY_TODAY" ? "BUY TODAY" : et.action === "WAIT" ? "WAIT" : "AVOID ENTRY";
          const reasons = et.reasons.slice(0, 3).map((r) => `• ${r}`).join("\n");
          return {
            reply:
              `${a.name} (${a.ticker}) — ${inr(a.quote.price)} (${sgn(a.quote.changePercent)} today)\n` +
              `Entry timing: ${actionText} — timing score ${et.score}/100 (verdict ${a.analysis.recommendation}, quant score ${a.analysis.score}/100)\n` +
              `${reasons}\n` +
              (et.waitFor ? `\nWhat to wait for: ${et.waitFor}\n` : "") +
              `\nThis is a timing lean layered on measured signals, not a certainty — ` +
              `measured direction accuracy is close to a coin flip, so position sizing and the stop-loss ` +
              `matter more than the entry day.`,
            suggestions: [
              `Should I buy ${a.name}?`,
              "Top 5 stocks today",
              "How accurate are you?",
            ],
            offTopic: false,
          };
        }
        return {
          reply:
            'Tell me which stock you mean — e.g. "should I buy TCS today or wait?" or "is now a good entry for Reliance?".',
          suggestions: ["Should I buy TCS today or wait?", "Top 5 stocks today"],
          offTopic: false,
        };
      }

      // Analyze / should-I-buy / price for a specific stock
      const wantsPriceOnly = /\b(price|quote|ltp|trading at|current)\b/.test(lower) && !/\b(should|buy|sell|analy)/.test(lower);
      const t = await findTicker(message);
      if (t) {
        if (wantsPriceOnly) {
          const q = await marketDataService.getQuote(t.ticker);
          return {
            reply: `${t.name} (${t.ticker}): ${inr(q.price)} (${sgn(q.changePercent)} today, prev close ${inr(q.previousClose)}).${q.fiftyTwoWeekHigh != null && q.fiftyTwoWeekLow != null ? ` 52-week range ${inr(q.fiftyTwoWeekLow)}–${inr(q.fiftyTwoWeekHigh)}.` : ""}`,
            suggestions: [`Should I buy ${t.name}?`, "Top 5 stocks today"],
            offTopic: false,
          };
        }
        const a = await stockService.analyze(t.ticker);
        const p7 = a.analysis.predictions.find((p) => p.horizonDays === 7);
        const p30 = a.analysis.predictions.find((p) => p.horizonDays === 30);
        const acc1d = a.accuracy?.horizons.find((h) => h.horizonDays === 1);
        const posReasons = a.analysis.reasons.positive.slice(0, 2).map((r) => `• ${r}`).join("\n");
        const negReasons = a.analysis.reasons.negative.slice(0, 2).map((r) => `• ${r}`).join("\n");
        return {
          reply:
            `${a.name} (${a.ticker}) — ${inr(a.quote.price)} (${sgn(a.quote.changePercent)} today)\n` +
            `Verdict: ${a.analysis.recommendation} — momentum score ${a.analysis.score}/100${a.framework.masterScore != null ? `, framework Master Score ${a.framework.masterScore.toFixed(1)}/100 (${a.framework.verdict})` : ""}, ${a.analysis.riskLevel} risk\n` +
            (p7 ? `7d forecast: ${sgn(p7.expectedReturnPct)} (80% range ${sgn(p7.low80Pct)}..${sgn(p7.high80Pct)})\n` : "") +
            (p30 ? `30d forecast: ${sgn(p30.expectedReturnPct)} (range ${sgn(p30.low80Pct)}..${sgn(p30.high80Pct)})\n` : "") +
            (posReasons ? `\nFor:\n${posReasons}` : "") +
            (negReasons ? `\nAgainst:\n${negReasons}` : "") +
            (acc1d ? `\n\nMeasured 1-day direction accuracy for this stock: ${acc1d.directionHitRatePct.toFixed(1)}% (${acc1d.samples} samples) — treat the verdict as a lean, not a promise.` : "") +
            `\nFull 8-phase breakdown is on the Analyze tab.`,
          suggestions: [`price of ${t.name}`, "Top 5 stocks today", `split ₹10,000`],
          offTopic: false,
        };
      }

      // No stock found and no intent matched → refuse (stock-only bot).
      return { reply: OFF_TOPIC_REPLY, suggestions: DEFAULT_SUGGESTIONS, offTopic: true };
    } catch (err) {
      return {
        reply: `I hit an error fetching live data: ${(err as Error).message}. Try again in a moment.`,
        suggestions: DEFAULT_SUGGESTIONS,
        offTopic: false,
      };
    }
  }
}

export const assistantService = new AssistantService();
export default assistantService;
