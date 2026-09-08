# Short-Term AI cost policy (FREE-FIRST)

STAGE 0 (zero AI cost): the entire 151-stock scan — features, setups, plans,
EV, sizing, gates, ranking — is deterministic. STAGE 1 (free/local): LightGBM/
XGBoost/CatBoost challengers run offline in the worker; a deterministic LOCAL
summary is always available in the AI tab (provider "local-deterministic"; a
LocalReasoningProvider slot exists for Ollama-style runtimes). ESCALATION:
gpt-5.6-luna for candidate summaries/questions (AUTO/LOW_COST), gpt-5.6-sol
ONLY for explicit Deep Review — never across all stocks; terra reserved for
the long-term evidence pipeline.

**AiCostGovernor**: AI_DAILY_BUDGET_USD / AI_MONTHLY_BUDGET_USD /
AI_MAX_{LUNA,TERRA,SOL}_CALLS_PER_DAY (env). Usage is computed from the
ai_reviews audit trail (no second meter to drift); over budget ⇒ automatic
fallback to the LOCAL summary with the reason attached. Evidence-hash caching
(ticker+hash+model+promptVersion, 24h) prevents repeat calls on unchanged
evidence. Dashboard: GET /api/short-term/ai-usage (mode FREE-FIRST, $ today/
month, per-tier calls, cache-hit %). OpenAI availability is NEVER required —
verified: no key ⇒ local summaries, deterministic radar unaffected.
