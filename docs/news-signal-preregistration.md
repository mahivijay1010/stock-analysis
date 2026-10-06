# Web-news sentiment signal — pre-registration

**Registered:** 2026-10-06 ~15:30 IST, before any automatically gathered fact had a matured forward return.
**Code:** `src/services/knowledge/` (Firecrawl → DeepSeek → validated facts), `src/services/research/newsSignalStudy.ts` (this test).
**Why:** every price/volume/delivery signal tested so far failed to rank stocks (docs/stock-selection-preregistration.md,
docs/delivery-signals-preregistration.md). News is information those signals never had. Whether it predicts
anything once the system *learns* it — typically after the market has already reacted — is exactly the question.

## Data — point in time by construction

- Facts: `stock_knowledge` rows with `source_kind = 'NEWS'` and `detail.version = 'news-facts-v1'`, written by the
  nightly `nightly-web-knowledge` job. `observed_at` is the IST date the system learned the fact. Manually entered facts
  (2026-10-06, no `version`) are excluded.
- Prices: `nse_delivery.close_price` (EQ, exchange prints). A window containing a >25% one-day move is excluded
  (corporate action or shock).

## Definitions

- **Event** = (symbol, observed_at = d) with ≥ 1 fact of materiality MEDIUM or HIGH.
- **Score** = materiality-weighted net sentiment over that stock-day's facts (`netSentiment`, HIGH 3 / MEDIUM 2 / LOW 1;
  POSITIVE +1, NEGATIVE −1, NEUTRAL/MIXED 0), in [−1, 1]. Score 0 ⇒ no call.
- **Entry** = close of the first session strictly after d (the job runs after the close of d).
  **Exit** = close 10 sessions later.
- **Benchmark** = median 10-session return, same window, of every EQ stock with close ≥ ₹5 and turnover ≥ ₹2 crore on
  the entry session. **Relative return** = stock − benchmark.
- **Hit** = sign(score) = sign(relative return). **Spread** = mean relative return of positive calls − of negative calls.

## Rule (evaluated nightly; judged once the sample threshold is first reached)

Sample threshold: ≥ 20 distinct observation days, ≥ 150 matured calls, ≥ 30 positive and ≥ 30 negative.

PASS iff, on that sample:
1. hit rate > 55%;
2. the observation-day-clustered 95% lower bound of the hit rate > 50%;
3. spread > 0 with day-clustered t ≥ 2.0.

Cost (0.84% long-short round trip) is reported, not ruled on. Before PASS, nothing from this signal enters any
decision, rank or label. After PASS it may be shown as a validated news flag and offered to the next pre-registered
model challenger — it does not directly change BUY/WAIT/WATCH.

## Registered prior (learning_expectations, source STUDY)

- The news-sentiment signal **FAILS** (p ≈ 0.65): by the time a fact is indexed, searched and learned, the price has
  usually moved; post-event drift in large and mid caps is weak.
- Expected earliest judgement: ~mid-November 2026 at 15 searches/day.
