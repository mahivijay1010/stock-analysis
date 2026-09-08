/**
 * V2-14 — 8-Sep four-stock regression through the V2 pipeline.
 *
 * Point-in-time: the DB bars end on the last completed session (2026-09-08),
 * so a scan today reproduces the 8-Sep state. Not hardcoded — the four stocks
 * are run through the real ScanService and we assert the SAFETY property:
 * none reaches ENTRY_CONFIRMED / QUALIFIED while their setup lacks live
 * authority + LOW confidence; they may legitimately be RESEARCH_WATCH /
 * ZONE_REACHED / WAIT_FOR_CONFIRMATION.
 *
 * Usage: npx ts-node --transpile-only scripts/shortTermV2Regression.ts
 */

import { AppDataSource } from "../src/config/database";
import { shortTermScanService } from "../src/services/shortterm/ScanService";
import { setupEvidenceService } from "../src/services/shortterm/setupEvidence";

const WATCH = ["BERGEPAINT.NS", "M&M.NS", "ATGL.NS", "BDL.NS"];

async function main(): Promise<void> {
  await AppDataSource.initialize();
  setupEvidenceService.invalidateCache();
  const r = await shortTermScanService.scan({ budgetInr: 50000, riskPerTradePct: 0.5, horizon: "5-10d", limit: 5 });

  console.log(`universe ${r.universeSize} · passed gates ${r.passedGates} · QUALIFIED ${r.qualifiedCount} · watchlist ${r.watchlistCount}`);
  console.log(`emptyMessage: ${r.emptyMessage ?? "(qualified trades present)"}\n`);

  const all = [...r.candidates, ...r.watchlist];
  let violations = 0;
  for (const t of WATCH) {
    const v = all.find((c) => c.ticker === t);
    if (!v) {
      console.log(`${t}: not in results (filtered earlier — acceptable)`);
      continue;
    }
    const bucket = r.candidates.includes(v) ? "QUALIFIED" : "RESEARCH_WATCHLIST";
    console.log(`${t}: bucket=${bucket} action=${v.action} tier=${v.tier} setup=${v.setupType} conf=${v.forecast.modelConfidence} health=${v.modelHealth}`);
    console.log(`   whyNotEntry: ${v.whyNotEntry.slice(0, 3).join(" | ") || "(none — would be entry-confirmed)"}`);
    console.log(`   ceiling reasons: ${v.ceilingReasons.slice(0, 2).join(" | ")}`);
    // SAFETY ASSERTIONS
    if (v.action === "ENTRY_CONFIRMED") { console.log(`   ❌ VIOLATION: ENTRY_CONFIRMED`); violations++; }
    if (bucket === "QUALIFIED") { console.log(`   ❌ VIOLATION: appeared as a QUALIFIED trade`); violations++; }
  }

  console.log(`\nACCEPTANCE: ${violations === 0 ? "PASS — none of the four is ENTRY_CONFIRMED / QUALIFIED" : `FAIL — ${violations} violation(s)`}`);
  if (r.candidates.length > 0) {
    console.log("\nQualified trades present (all must be tier A + ENTRY_CONFIRMED + affordable):");
    for (const c of r.candidates) console.log(`  #${c.rank} ${c.ticker} ${c.action} tier ${c.tier} setup ${c.setupType}`);
  }
  await AppDataSource.destroy();
  if (violations > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
