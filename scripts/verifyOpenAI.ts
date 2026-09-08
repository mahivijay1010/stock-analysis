import { AppDataSource } from "../src/config/database";
import { reasoningService } from "../src/services/reasoning/ReasoningService";

async function main() {
  await AppDataSource.initialize();
  console.log("provider:", reasoningService.providerName(), "| available:", reasoningService.available());
  const { review, result } = await reasoningService.review("BHEL.NS");
  console.log("model:", result.modelName, "| latency:", result.latencyMs, "ms | tokens:", result.tokensIn, "/", result.tokensOut);
  console.log("action:", result.review.action, "| newEntry:", result.review.newEntryAction, "| band:", result.review.confidenceBand, "| confidence:", result.review.confidence);
  console.log("clamped:", result.clamped, result.clampNotes.length ? "| notes: " + result.clampNotes[0] : "");
  console.log("reasoning:", result.review.reasoningSummary.slice(0, 220));
  console.log("audit row id:", review.id, "| provider:", review.provider);
  await AppDataSource.destroy();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
