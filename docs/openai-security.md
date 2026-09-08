# OpenAI security & privacy (upgrade Part 26)

- `OPENAI_API_KEY` lives in the server's `.env` ONLY (gitignored, verified via
  `git check-ignore`). It is never logged, never serialized into API
  responses, never shipped to frontend JavaScript (all OpenAI calls are
  server-side in `OpenAIProvider`).
- The key was provided in-chat by the owner; recommendation: **rotate it**,
  since chat transcripts are an exposure surface outside this repo's control.
- No user identity, email, or credentials are ever sent to OpenAI. Position
  analysis sends ONLY explicitly-supplied fields (holdsPosition,
  purchasePrice, quantity, investmentHorizon, riskTolerance,
  maximumAcceptableLoss). Risk tolerance is never inferred.
- Every AI call is audited in `ai_reviews`: provider, model + snapshot,
  promptVersion, inputHash, responseId, latency, tokens, schemaVersion,
  validationResult, clamps. Invalid outputs store `{rejected: true}` — the
  raw payload is never trusted into state.
- Anti-hallucination validators: event interpretations must reference known
  eventIds; counterfactual explanations must reference known conditionIds;
  eval suite scans committee text for invented tickers.
