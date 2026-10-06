/**
 * Firecrawl client — web search for the knowledge base.
 *
 * FIRECRAWL_API_KEY lives in server env only (never logged or returned).
 * Measured 2026-10-06: a 5-result search WITHOUT page scraping costs ~2
 * credits; the plan is 1,000 credits/month, so the daily job is budgeted in
 * searches (FIRECRAWL_DAILY_SEARCHES) and refuses to run below a credit
 * reserve (FIRECRAWL_CREDIT_RESERVE) — knowledge gathering must never drain
 * the account mid-month.
 */

const BASE = process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev";
const TIMEOUT_MS = 60_000;

export interface SearchResult {
  url: string;
  title: string;
  description: string;
}

function key(): string {
  return (process.env.FIRECRAWL_API_KEY ?? "").trim();
}

export function firecrawlAvailable(): boolean {
  return key().length > 0;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: unknown; error?: string } | null;
    if (!res.ok || !body?.success) throw new Error(`firecrawl ${path} → ${res.status}${body?.error ? `: ${body.error}` : ""}`);
    return body.data as T;
  } finally {
    clearTimeout(t);
  }
}

export async function remainingCredits(): Promise<number | null> {
  if (!firecrawlAvailable()) return null;
  const d = await call<{ remaining_credits?: number }>("/v1/team/credit-usage", { method: "GET" });
  return typeof d.remaining_credits === "number" ? d.remaining_credits : null;
}

/** Past-week web search, India-located. No page scraping (that costs far more credits). */
export async function searchWeb(query: string, limit = 5, tbs = "qdr:w"): Promise<SearchResult[]> {
  if (!firecrawlAvailable()) throw new Error("FIRECRAWL_API_KEY is not configured");
  const data = await call<Array<{ url?: string; title?: string; description?: string }>>("/v1/search", {
    method: "POST",
    body: JSON.stringify({ query, limit, tbs, location: "India" }),
  });
  return (data ?? [])
    .filter((r) => typeof r.url === "string" && r.url.startsWith("http"))
    .map((r) => ({ url: r.url!, title: (r.title ?? "").slice(0, 300), description: (r.description ?? "").slice(0, 1500) }));
}
