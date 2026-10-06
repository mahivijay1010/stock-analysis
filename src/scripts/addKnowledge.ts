/**
 * Append sourced facts to stock_knowledge from a JSON file:
 *   npx ts-node --transpile-only src/scripts/addKnowledge.ts data/knowledge/<file>.json
 * File: [{ symbol, kind, fact, detail?, sourceKind, sourceUrl, observedAt, confidence }]
 * Duplicate (symbol, kind, fact, observed_at) rows are skipped — the table is append-only.
 */
import { readFileSync } from "fs";
import { AppDataSource } from "../config/database";

interface Fact { symbol: string; kind: string; fact: string; detail?: unknown; sourceKind: string; sourceUrl: string | null; observedAt: string; confidence: "HIGH" | "MEDIUM" | "LOW" }

(async () => {
  const facts: Fact[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
  await AppDataSource.initialize();
  let added = 0;
  for (const f of facts) {
    const [ex]: Array<{ c: string }> = await AppDataSource.query(
      `SELECT count(*) c FROM stock_knowledge WHERE symbol=$1 AND kind=$2 AND fact=$3 AND observed_at=$4`, [f.symbol, f.kind, f.fact, f.observedAt]);
    if (Number(ex.c) > 0) continue;
    await AppDataSource.query(
      `INSERT INTO stock_knowledge (symbol, kind, fact, detail, source_kind, source_url, observed_at, confidence) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [f.symbol, f.kind, f.fact, JSON.stringify(f.detail ?? null), f.sourceKind, f.sourceUrl, f.observedAt, f.confidence]);
    added++;
  }
  console.log(`[knowledge] ${added} of ${facts.length} facts added`);
  await AppDataSource.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
