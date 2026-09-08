import { AppDataSource } from "../src/config/database";
import { decisionService } from "../src/services/decision/DecisionService";

async function main() {
  await AppDataSource.initialize();
  const snap = await decisionService.publish("BHEL.NS");
  const dp = (snap.inputs as Record<string, unknown>)?.directionProbability;
  console.log("decision:", snap.decisionStatus, "| policy:", snap.decisionPolicyVersion);
  console.log("directionProbability:", JSON.stringify(dp, null, 2));
  await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
