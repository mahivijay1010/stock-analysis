/**
 * Daily web-knowledge job: Firecrawl search → DeepSeek structuring → code
 * validation → stock_knowledge (append-only, observed_at = the day the system
 * LEARNED it, which is what makes the facts usable in a point-in-time test —
 * see research/newsSignalStudy.ts).
 *
 * Target selection (credit-budgeted, ~2 credits per search):
 *   1. stocks with a live short-term setup (WAIT / WATCH / BUY) in the last
 *      3 days — the ones a decision is most likely to be made on;
 *   2. then the rest of the wide sub-₹100 screen and the 152-stock radar
 *      universe, OLDEST knowledge first (never-researched before stale).
 * Stops early below FIRECRAWL_CREDIT_RESERVE.
 */
import { AppDataSource } from "../../config/database";
import { NSE_UNIVERSE } from "../../data/nseUniverse";
import { getOpenAIProvider } from "../reasoning/providerRegistry";
import { firecrawlAvailable, remainingCredits, searchWeb } from "./firecrawl";
import { NEWS_FACT_SCHEMA, NEWS_FACT_VERSION, factSystemPrompt, factUserPrompt, validateFacts } from "./newsFacts";

export interface WebKnowledgeSummary {
  date: string;
  searched: number;
  factsAdded: number;
  rejected: number;
  failures: string[];
  creditsBefore: number | null;
  creditsAfter: number | null;
  skippedReason: string | null;
  targets: string[];
}

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

interface Target { symbol: string; company: string; priority: number; lastResearched: string | null }

async function selectTargets(limit: number): Promise<Target[]> {
  const wide: Array<{ symbol: string; company_name: string }> = await AppDataSource.query(
    `SELECT s.symbol, s.company_name FROM nse_securities s
       JOIN nse_delivery d ON d.symbol = s.symbol AND d.series = 'EQ' AND d.trade_date = (SELECT max(trade_date) FROM nse_delivery)
      WHERE s.instrument_type = 'STOCK' AND d.close_price < 100 AND d.close_price >= 5 AND d.turnover_lacs >= 200`
  );
  const names = new Map<string, string>();
  for (const w of wide) names.set(w.symbol, w.company_name);
  for (const u of NSE_UNIVERSE) names.set(u.ticker.replace(/\.NS$/, ""), u.name);

  const setups: Array<{ ticker: string }> = await AppDataSource.query(
    `SELECT DISTINCT ON (ticker) ticker FROM short_term_candidates
      WHERE created_at > now() - interval '3 days'
        AND action IN ('ENTRY_CONFIRMED','ZONE_REACHED','WAIT_FOR_CONFIRMATION','RESEARCH_WATCH','SETUP_DETECTED')
      ORDER BY ticker, created_at DESC`
  );
  const withSetup = new Set(setups.map((s) => s.ticker.replace(/\.NS$/, "")));

  const last: Array<{ symbol: string; d: string }> = await AppDataSource.query(
    `SELECT symbol, to_char(max(observed_at),'YYYY-MM-DD') d FROM stock_knowledge WHERE source_kind IN ('NEWS','WEB') GROUP BY symbol`
  );
  const lastBy = new Map(last.map((l) => [l.symbol, l.d]));

  const today = istToday();
  const targets: Target[] = [...names.entries()]
    .filter(([sym]) => lastBy.get(sym) !== today) // never twice in a day
    .map(([symbol, company]) => ({ symbol, company, priority: withSetup.has(symbol) ? 0 : 1, lastResearched: lastBy.get(symbol) ?? null }));
  targets.sort((a, b) => a.priority - b.priority || (a.lastResearched ?? "0000").localeCompare(b.lastResearched ?? "0000") || a.symbol.localeCompare(b.symbol));
  return targets.slice(0, limit);
}

export async function runWebKnowledge(opts: { maxSearches?: number; dryRun?: boolean } = {}): Promise<WebKnowledgeSummary> {
  const date = istToday();
  const maxSearches = opts.maxSearches ?? Number(process.env.FIRECRAWL_DAILY_SEARCHES ?? 15);
  const reserve = Number(process.env.FIRECRAWL_CREDIT_RESERVE ?? 100);
  const summary: WebKnowledgeSummary = { date, searched: 0, factsAdded: 0, rejected: 0, failures: [], creditsBefore: null, creditsAfter: null, skippedReason: null, targets: [] };

  if (!firecrawlAvailable()) return { ...summary, skippedReason: "FIRECRAWL_API_KEY not configured" };
  const provider = getOpenAIProvider();
  if (!provider.isAvailable()) return { ...summary, skippedReason: "no AI provider configured to structure search results" };

  summary.creditsBefore = await remainingCredits().catch(() => null);
  if (summary.creditsBefore != null && summary.creditsBefore < reserve) {
    return { ...summary, skippedReason: `credits ${summary.creditsBefore} below reserve ${reserve} — not spending until the plan resets` };
  }

  const targets = await selectTargets(maxSearches);
  summary.targets = targets.map((t) => t.symbol);
  if (opts.dryRun) return summary;

  for (const t of targets) {
    try {
      const results = await searchWeb(`"${t.company}" share news`, 5);
      summary.searched++;
      if (!results.length) continue;
      const { data, meta } = await provider.extract({
        system: factSystemPrompt(),
        user: factUserPrompt(t.symbol, t.company, results),
        format: NEWS_FACT_SCHEMA,
        validate: (raw) => validateFacts(raw, new Set(results.map((r) => r.url)), date, daysAgo(date, 14)),
      });
      summary.rejected += data.rejected;
      for (const f of data.kept) {
        const [ex]: Array<{ c: string }> = await AppDataSource.query(
          `SELECT count(*) c FROM stock_knowledge WHERE symbol = $1 AND (fact = $2 OR (source_url = $3 AND kind = $4 AND observed_at > $5::date - 14))`,
          [t.symbol, f.fact, f.sourceUrl, f.kind, date]
        );
        if (Number(ex.c) > 0) continue;
        await AppDataSource.query(
          `INSERT INTO stock_knowledge (symbol, kind, fact, detail, source_kind, source_url, observed_at, confidence)
           VALUES ($1,$2,$3,$4::jsonb,'NEWS',$5,$6,'MEDIUM')`,
          [
            t.symbol, f.kind, f.fact,
            JSON.stringify({ sentiment: f.sentiment, materiality: f.materiality, eventDate: f.eventDate, version: NEWS_FACT_VERSION, model: meta.model, provider: meta.provider, query: `"${t.company}" share news`, priority: t.priority }),
            f.sourceUrl, date,
          ]
        );
        summary.factsAdded++;
      }
    } catch (e) {
      summary.failures.push(`${t.symbol}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  summary.creditsAfter = await remainingCredits().catch(() => null);
  return summary;
}
