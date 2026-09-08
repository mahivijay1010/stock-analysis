# AI before / after (upgrade Part 30)

## Before (Claude-only committee, 2026-09-08 morning)
One role (Risk Committee), ANTHROPIC_API_KEY absent in runtime ⇒ the entire AI
layer was BLOCKED_EXTERNAL. Context: snapshot fields only. No evidence graph,
no role separation, no disagreement measure, no evals, no cache.

## After (OpenAI-first, 2026-09-08)
- Provider: OpenAI Responses API, strict Structured Outputs + server-side
  revalidation; Claude preserved as optional (`AI_PROVIDER=claude`).
- Live end-to-end: **verified** on real snapshots (BHEL committee WATCH→
  INSUFFICIENT_DATA/LOW; five specialist roles all validated; cache serving
  repeat runs with zero API calls).
- Evidence graph with per-fact provenance; AI interpretations stored apart
  from facts; anti-hallucination id validation (events, conditions).
- Multi-role pipeline (terra analysts + sol critic/committee) + deterministic
  aiDisagreementScore + deterministic counterfactual conditions with
  AI explanations.
- Evals: 10/10 PASS, 0 raw cap violations, consistent (gate for all prompt/
  model changes).
- Uncertainty decomposition (points lost per source) on the truth panel.
- What did NOT change: the TradeGate and every deterministic control. AI
  remains advisory + cap-only; with no key the deterministic system runs
  identically (verified failure path).

## Honest limits
AI adds explanation, contradiction-detection, extraction and evidence
auditing. It added ZERO forecasting edge — no AI output feeds a forecast, and
the quantitative challengers it accompanies were all declined for promotion
on the evidence (see model-promotion-final.md).
