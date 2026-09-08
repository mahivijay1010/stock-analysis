# OpenAI AI architecture (upgrade Parts 1/2/13/14/23/24)

## Provider layer
- `InvestmentReasoningProvider` abstraction preserved; `providerRegistry.ts`
  routes by `AI_PROVIDER` (openai | claude), defaulting to OpenAI when
  `OPENAI_API_KEY` exists. ClaudeProvider kept intact as an optional provider.
- `OpenAIProvider` uses the official SDK + **Responses API** with
  `json_schema, strict: true` on EVERY call, then **revalidates server-side**
  (`roles.ts` validators). Invalid output ⇒ rejected + audited; never coerced.
- Model routing (env-overridable): `gpt-5.6-luna` extraction ·
  `gpt-5.6-terra` analysis · `gpt-5.6-sol` critic/committee.

## Evidence graph (Part 2)
`EvidenceGraphService` builds STOCK → {business, fundamentals, valuation,
technicalState, regime, events, forecasts, calibration, modelHealth,
expectedValue, risks, positionContext} from stored deterministic sources only.
Every fact: `{id, value, source, sourceUrl, sourceAuthority 1-5, asOf,
availableAt, retrievedAt, quality, isPrimarySource}`. AI outputs are stored
separately in `ai_reviews` (role, responseId, schemaVersion, validationResult,
meta) and can never overwrite facts.

## Roles (Part 13)
Fundamental / Event / Technical analysts (terra) each receive ONLY their
evidence slice; Forecast Critic and Risk Committee (sol) receive forecast
evidence and the validated role findings respectively. Deterministic
`aiDisagreementScore` (0-100 + reasons) is computed in code — contradictions
reduce confidence, never averaged away.

## Final authority (Part 14)
DATA → FEATURES → QUANT → ENSEMBLE → CALIBRATION → MODEL HEALTH → EV → ENTRY
QUALITY → **TradeGate** → AI analysts → AI critic → AI committee →
**deterministic clamp** → final action. `clampReviewToGate` guarantees AI can
lower and never raise; the Critic's `recommendedActionCap` is cap-only by
contract and validation.

## Tools & data access (Part 23)
AI never touches the database. All inputs come pre-assembled by services that
enforce point-in-time constraints (evidence graph, snapshot fields). Web
search is NOT wired into any decision path; the research-ingestion flow for
external content is the structured event engine with `announcedAt` provenance
(tier 1-5) — and web search remains prohibited in all backtests.

## Cost routing + cache (Part 24)
Stage 1 deterministic scan (free) → Stage 2 extraction (luna) only on new
evidence → Stage 3 analysts (terra) for shortlisted/followed instruments →
Stage 4 committee+critic (sol) only for candidates, holdings, contradictions,
or explicit user request (`POST /api/ai/:t/analyze`). Cache key =
sha256(evidenceHash + promptVersion + model) where evidenceHash covers factual
content only (provenance timestamps excluded); verified: a re-run with
unchanged evidence served all five roles from cache with zero OpenAI calls.

## Failure mode (Part 25)
No key / timeout / rate limit / invalid schema / outage ⇒ role recorded as
failed, pipeline continues, UI shows "AI review unavailable. The deterministic
evidence-gated decision remains active." AI unavailability can never produce
a BUY.
