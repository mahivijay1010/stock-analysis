import { AppDataSource } from "../src/config/database";
import { roleOrchestrator } from "../src/services/ai/RoleOrchestrator";

async function main() {
  await AppDataSource.initialize();
  const r = await roleOrchestrator.analyze("BHEL.NS");
  console.log("=== role run ===");
  console.log("evidenceHash:", r.evidenceHash.slice(0, 12), "| cached:", r.cached.join(",") || "none", "| failures:", JSON.stringify(r.failures));
  if (r.fundamental) console.log("FUND:", r.fundamental.businessTrajectory, "/", r.fundamental.qualityAssessment, "/", r.fundamental.valuationAssessment, "| eq:", r.fundamental.earningsQuality, "| cited:", r.fundamental.citedEvidenceIds.slice(0,4).join(","));
  if (r.events) console.log("EVENTS:", r.events.overallEventRisk, "|", r.events.interpretations.length, "interpretations | first:", r.events.interpretations[0]?.eventId?.slice(0,12), r.events.interpretations[0]?.materiality, r.events.interpretations[0]?.direction);
  if (r.technical) console.log("TECH:", r.technical.longTermTrend, "/", r.technical.shortTermState, "| momentum:", r.technical.momentum, "| participation:", r.technical.participation, "| overall:", r.technical.overallState);
  if (r.critic) console.log("CRITIC: usable:", r.critic.forecastUsable, "| conf:", r.critic.confidence, "| cap:", r.critic.recommendedActionCap, "| concern:", r.critic.primaryConcerns[0]);
  console.log("DISAGREEMENT:", r.disagreement.score, "|", r.disagreement.reasons[0] ?? "none");
  console.log("CONDITIONS:", r.upgradeConditions.map(c => c.conditionId).join(", "));
  console.log("CF explanations:", r.counterfactualExplanations?.length ?? 0);
  if (r.committee) console.log("COMMITTEE:", r.committee.review.action, "| band:", r.committee.review.confidenceBand, "| conf:", r.committee.review.confidence, "| clamped:", r.committee.clamped);
  await AppDataSource.destroy();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
