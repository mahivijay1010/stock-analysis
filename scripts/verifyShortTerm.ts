import { AppDataSource } from "../src/config/database";
import { shortTermScanService } from "../src/services/shortterm/ScanService";

async function main() {
  await AppDataSource.initialize();
  const r = await shortTermScanService.scan({ budgetInr: 50000, riskPerTradePct: 0.5, horizon: "5-10d", limit: 5 });
  console.log(`scan ${r.scanRunId.slice(0,8)} | universe ${r.universeSize} | passed gates ${r.passedGates} | shown ${r.candidates.length}`);
  console.log("market:", r.marketStatus.session, r.marketStatus.istTime, "| risk mgr:", r.riskManager.newEntriesAllowed, "-", r.riskManager.reasons[0]);
  if (r.emptyMessage) console.log("EMPTY:", r.emptyMessage);
  for (const c of r.candidates) {
    console.log(`#${c.rank} ${c.ticker} ₹${c.currentPrice} [${c.freshness.state}] ${c.setupType} score=${c.setupScore} action=${c.action}`);
    console.log(`   entry: ${c.plan.entryTrigger ?? `₹${c.plan.entryZoneLow}-₹${c.plan.entryZoneHigh}`} | stop ₹${c.plan.initialStop} (${c.plan.stopBasis}) | T1 ₹${c.plan.target1} R:R ${c.plan.rewardRiskToTarget1} | EV ${c.plan.expectedValueAfterCostsPct}%`);
    if (c.sizing) console.log(`   size: ${c.sizing.positionSizeShares} sh (raw risk-based ${c.sizing.rawRiskBasedQty}) capital ₹${c.sizing.capitalRequired} lossAtStop ₹${c.sizing.lossAtStop} [${c.sizing.constraintsApplied[0]}]`);
    console.log(`   prob: ${c.forecast.probabilityStatement}`);
  }
  await AppDataSource.destroy();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
