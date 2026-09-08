import { AppDataSource } from "../src/config/database";
import { eventService } from "../src/services/market/EventService";
import { decisionService } from "../src/services/decision/DecisionService";

async function main() {
  await AppDataSource.initialize();
  const reports = await eventService.ingestAll("BHEL.NS");
  console.log("ingest reports:", JSON.stringify(reports, null, 1));
  const risk = await eventService.assessEventRisk("BHEL.NS", new Date());
  console.log("event risk:", JSON.stringify({ ...risk, events: risk.events.slice(0, 5) }, null, 1));
  const snap = await decisionService.publish("BHEL.NS");
  const inp = snap.inputs as Record<string, any>;
  console.log("snapshot decision:", snap.decisionStatus);
  console.log("snapshot eventRisk.upcomingEventRisk:", inp?.eventRisk?.upcomingEventRisk, "| reasons:", inp?.eventRisk?.reasons);
  console.log("snapshot regime.stockRegime:", inp?.regime?.stockRegime, "| entryRegime:", inp?.regime?.entryRegime);
  console.log("fund completeness: xbrl", inp?.fundamentalsCompleteness?.xbrlCompletenessPct, "% | yahoo", inp?.fundamentalsCompleteness?.yahooCompletenessPct, "%");
  const sample = (inp?.fundamentalsCompleteness?.fields ?? []).filter((f: any) => f.source === "xbrl").slice(0, 3);
  console.log("sample xbrl fields:", JSON.stringify(sample));
  await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
