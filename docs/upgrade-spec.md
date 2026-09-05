# StockSense India: production upgrade and simplification — BINDING SPEC (verbatim, received 2026-09-05)

You are working in my existing StockSense India repository as a senior product engineer, quantitative researcher, data engineer, and test engineer. Refactor and implement the product described below. This is an engineering assignment, not a request for a conceptual mockup or a list of suggestions.

## 1. Mission and working rules

Build a watchlist-first, holdings-aware Indian stock research app that answers: What do I own or follow? What is my actual profit/loss? What are the estimated daily outcomes over the next month? Is a new purchase supported by evidence today? What investment horizon and risks apply?

"Advanced" means reliable data, valid experiments, coherent forecasts, exact accounting given verified inputs, understandable decisions, security, and a clean interface. It does not mean adding as many models or dashboards as possible. Do not promise 100% accuracy, guaranteed profits, or exact future daily prices. Improve predictive performance through experiments; never manufacture an improvement to satisfy this specification.

Read every supplied screenshot/reference and inspect the actual repository, ARCHITECTURE.md, package manifests, entities, routes, services, jobs, tests, and frontend consumers before editing. Distinguish documented claims, observed implementation, and your proposed changes. References report Next.js/Tailwind/Recharts on the frontend and Node/TypeScript/Express/TypeORM/PostgreSQL on the backend. Preserve the working stack; verify installed versions rather than assuming them.

The references report approximately 50-51.5% directional accuracy, Brier score 0.2525, approximately 85% coverage for nominal 80% intervals, and an ensemble that did not improve on the original model. Treat these as historical, unverified-in-this-session measurements, not current production constants. They establish neither a reliable buy signal nor the impossibility of improving the system.

Preserve uncommitted work. Use a dedicated branch when Git is available, and take a verified backup before any data migration. Never use destructive Git resets to simplify the task.

First produce docs/upgrade-audit.md and docs/implementation-plan.md with the dependency map, reproducible baseline, risks, feature-removal matrix, schema/API changes, and phased acceptance criteria. Then implement safe, reversible phases. Ask only for genuinely blocking access, budget, or destructive-migration decisions. Never erase user data, reset an account, install paid services, or deploy publicly without explicit authorization.

Do not claim to inspect files or run tests you cannot access. Without repository access, request the repository rather than inventing patches. Keep a progress file so another session can resume. Use synthetic fixtures only in isolated test/demo environments, never to populate production accuracy or user records.

## 2. Product scope: simplify the frontend and the active backend

Use four primary navigation destinations: Watchlist, Holdings, Discover, and Forecast Track Record. Stock Detail is a drill-down, not another competing dashboard. Put settings and protected diagnostics in secondary navigation.

Implement this disposition after tracing dependencies:

| Existing area | Product disposition | Backend disposition |
| --- | --- | --- |
| Stock analysis, chart, entry verdict | Keep, consolidate into one stock detail experience | One canonical forecast and decision contract |
| Top 5, stock universe, relative leaders | Merge into Discover with search, filters, and explained sorting | Reuse registry; retain rank snapshots for evaluation, not an unproven alpha claim |
| Forecast charts, Monte Carlo cone, repeated rupee tables | Replace with one forecast chart and one daily table | One distribution/projection pipeline; remove inconsistent parallel calculations |
| Standalone holdings calculator | Merge into real holdings | One accounting implementation |
| Portfolio allocation builder and daily cash-split suggestions | Remove from the default product | Disable automatic allocation jobs/routes; retain reusable risk calculations only |
| Paper Trading Desk | Remove from primary navigation; optional isolated sandbox later | Preserve records; extract useful transaction, audit, and forecast-lock logic |
| Kelly sizing, Kelly drift, adaptive execution feedback | Remove from consumer recommendations | Stop active jobs and API consumers; archive experiments and records |
| Six-model voting and regret/FTRL adaptation | Remove from default production execution | Keep reproducible experiment artifacts; promote nothing without new evidence |
| Eight-phase framework and duplicate score rings | Replace with concise reasons, fundamentals, and risks | Retain useful features; remove redundant verdict orchestration |
| HAR/HAR-X and detailed technical indicators | Show a simple risk summary; details on demand | Keep only benchmark-supported models or explicitly labeled descriptive statistics |
| News radar and hype gauges | Keep a few relevant, timestamped events; remove decorative gauges | No news-driven forecast adjustment without point-in-time data and validation |
| Options skew, unconfigured macro, unused provider integrations | Remove unavailable panels and default requests | Remove dead wiring or isolate disabled adapters; do not auto-enable unvalidated feeds |
| Sensei chatbot | Remove from the default interface | Remove unused intent routes/dependencies after dependency audit; use contextual help |
| Accuracy and calibration dashboards | Keep a readable public track record; advanced diagnostics protected | Preserve immutable predictions, evaluations, provenance, and model versions |
| Unrealistic wealth milestones, target-growth paths, guaranteed-sounding copy | Delete | Remove associated recommendation/goal computation from active execution |

Removing a feature means removing its active routes where safe, scheduled calls, imports, dependency packages, settings, tests specific to removed behavior, and documentation references, not merely hiding its component. Preserve tests for reused behavior. Maintain a route migration map and appropriate redirects. Keep shared providers and mathematical utilities still used by core features.

Preserve historical trades, forecasts, outcomes, model artifacts, and audit evidence. Archive obsolete functionality outside the production build/cron path. Database deletion requires a separate reviewed migration and backup. Verify removed features produce no hidden network requests or background jobs.

## 3. Watchlist and holdings are different concepts

A watchlist item means "I follow this stock" and requires no purchase. A holding means actual recorded ownership and is derived from transactions, not an editable aggregate pretending to be a ledger.

Support adding/removing stocks, search by company or symbol, notes, selected horizon, and optional price/risk alerts. Adding a holding can add the stock to tracking, but removing a watchlist item must never delete its holding or history. Support account ownership from the beginning; do not expand the existing single-user account into a shared global ledger.

For a purchase capture instrument identity, executed purchase date, quantity, execution price or gross amount, separately recorded charges, and account. Derive dependent values; reject contradictory quantity/price/amount combinations. Never substitute the day's closing price for a user's unknown execution price without explicit confirmation and an "estimated input" label.

Support multiple lots, partial sales, charges, dividends, splits/bonuses, transaction corrections, CSV import/export, and position closure. Use an instrument-specific quantity policy. Ordinary trades should respect permitted lot sizes; corporate-action entitlements require appropriate handling rather than arbitrary rounding.

Backdated purchases are allowed when valid, but a forecast generated now must not be labeled a forecast generated on that purchase date. Show earlier actual history and "forecast not recorded" unless an authentic historical snapshot exists. A reconstructed historical backtest is a separate, clearly labeled object.

## 4. Accounting and projected P&L

Use PostgreSQL NUMERIC and a decimal-money library in TypeScript. Do not rely on floating-point arithmetic for authoritative money calculations. Specify scale and rounding rules; round for display only where appropriate. Use transactional FIFO lot matching for the product ledger, with recorded cost allocation and reversible corrections. Do not imply this is a complete tax filing engine.

For remaining quantity q and remaining cost basis B, including allocated purchase charges:

- Current marked value = q * current observed price.
- Unrealized marked P&L = current marked value - B.
- Projected marked P&L at date d = q * forecast price at d - B, assuming unchanged holdings.
- Forecast change from today's value = q * (forecast price at d - current observed price).
- Realized P&L = actual net sale proceeds - allocated cost basis of sold lots.

Separate gross marked P&L, estimated net liquidation P&L, and actually realized P&L. Estimate sale charges only in liquidation scenarios. Never subtract fees twice. Do not count an unexecuted sale as realized profit. Keep distributions separate where necessary and state whether returns include dividends.

Distinguish lifetime P&L, this month's P&L, forecast change from today, and next month's projected P&L. For a complete portfolio cash ledger, reconcile period P&L as closing NAV minus opening NAV minus external deposits plus external withdrawals. Deposits and purchases are not investment profits. Do not reconstruct historical daily P&L using today's share quantity.

Use actual entered/broker-reported costs when available. Estimated brokerage, taxes, exchange charges, DP charges, and slippage must have effective-dated assumptions. Unknown charges must be flagged, not silently zeroed. Keep investor-specific capital-gains taxes outside the default net estimate unless explicitly supported and reviewed.

Acceptance fixtures: 10 shares at INR 100 plus INR 10 purchase charges have cost basis INR 1,010. At INR 110 the marked unrealized P&L is INR 90. A forecast price of INR 120 implies projected marked P&L INR 190 before sale charges, not realized profit. Selling four at INR 120 with INR 6 sale charges produces INR 70 realized P&L and leaves six shares with INR 606 cost basis. A 2-for-1 split doubles quantity and halves per-share basis without creating a profit by itself.

## 5. Daily forecasts, monthly renewal, and immutable history

Provide two explicitly different views: "Next 30 calendar days" and "This calendar month / Next calendar month." Use Asia/Kolkata for product dates. Resolve actual exchange sessions rather than hardcoding 30 days to 21 sessions.

Define the rolling window precisely: calendar dates after forecastDateIST through forecastDateIST + 30 days, inclusive at the end. Map those dates to official sessions, with horizons counted from the actual completed-session anchor. Show exact window dates and first/last target sessions. Do not silently mix this with 30 trading days. A same-day close estimate, if implemented, is separately labeled and validated.

Display every calendar day when the user requests day-wise output. Weekends and holidays say "Market closed"; a carried-forward display value is not a new predicted return or an observed close. Special sessions, unexpected closures, suspensions, missing observations, and delayed finalization must have explicit states.

Every forecast issuance is immutable. Store issuedAt, featureCutoffAt, anchorSession, anchorPrice, price basis, target dates, model/calibration/policy versions, input-data manifest/hash, and original predictions. Store observations and evaluation revisions separately; never rewrite the forecast to match reality.

Support an original monthly snapshot and a separately labeled latest outlook. Refreshing outlook creates a new issuance; it must not move the historical line. For a mid-month addition, forecast the remaining month and the rolling window; earlier days show actuals only unless genuine saved forecasts exist.

At month end: reconcile available actuals, archive the completed monthly view, mark missing outcomes pending, carry holdings/cost basis/transactions forward unchanged, and create the next month's snapshot once eligible input data is available. Reset only the reporting period, never ownership, cost basis, lifetime P&L, or accuracy history. Version later corrections. Monthly jobs must be idempotent and recover after downtime.

For each forecast target return median price, available quantiles, mean price only when genuinely computed, return relative to the stated anchor, and supported probability estimates. For holdings, transform the same distribution into position value and P&L; do not call another model.

Use p10-p90 for an 80% interval and p05-p95 for a 90% interval. Do not relabel them. An 80% interval for each date is not an 80% guarantee for the entire month's path. Do not present a randomly simulated jagged path as the most likely future. Do not claim daily up/down certainty from a cumulative return forecast.

## 6. Repair the data foundation before changing models

Audit instrument identity first. Specifically investigate the reference's LTIMindtree/LTTS mapping against official exchange records; a valid ticker with valid bars can still represent the wrong company. Use canonical instrument IDs, ISIN/exchange identifiers where appropriate, effective-dated symbol aliases, listing history, and explicit corporate-action relationships. A rename is not the same as a demerger; never splice unrelated histories.

Store raw prices, adjustment factors, corporate actions, and the precise price/total-return basis used by each experiment. Keep user execution prices on their actual historical basis. A dividend-adjusted series must not be mistaken for a historical executable quote or have its dividends counted twice.

Implement an exchange-session calendar with source/version tracking and overrides. The documented weekday/weekend freshness rule and 30-minute holiday retry guard are not substitutes for a real session calendar. Verify provider finalization; a clock reaching 15:40 alone does not prove the close is available.

Separate quoteTimestamp, quoteType, marketState, latestCompletedBarDate, providerDelay, and featureCutoffAt. Never label a cached prior close "live." Intraday quotes and completed daily bars need not agree; clearly identify which anchors a forecast and which marks a holding.

Validate OHLC relationships, duplicates, missing sessions, units, impossible prices, corporate-action jumps, and cross-source disagreements. Quarantine questionable inputs rather than silently deleting genuine extreme market moves. Stale data may remain visible, but stale/unreconciled data must block unsupported actionable decisions.

For fundamentals store filing publication time, period, revision, consolidated/standalone basis, units, audited/unaudited status, and provenance. Do not treat every exchange filing as audited. Preserve bank-specific exclusions and test unit conversions, TTM calculations, and restatements. Never use a filing in a historical model before its release.

News and macro inputs require publication/availability timestamps and historical versions. Current headlines must not influence historical backtests. Missing sentiment is missing, not neutral evidence. Keep the product usable without optional feeds. Respect provider access restrictions and permitted use; no bypassing bot protections or silently activating paid data.

## 7. One forecasting contract, not contradictory engines

Create a ForecastEngine interface that separates data validation, feature construction, prediction, calibration, and evaluation. Every output identifies its model, data, target definition, and uncertainty method. The legacy heuristic can remain a named baseline, not unquestioned ground truth.

Begin with reproducible baselines: last-price/no-change forecasts, a documented shrinkage-drift model, empirical return distributions, and simple volatility estimates such as EWMA. Compare HAR/HAR-X against a real volatility baseline, not merely a favorable R-squared number.

Implement a controlled challenger pipeline using pooled, cross-sectional learning across stocks, with stock/sector-aware features and time-based validation. Start with a regularized model and one justified gradient-boosted distributional/quantile model. Candidate inputs include lagged returns, volatility, liquidity, relative strength, sector/market context, and legitimately available fundamentals/events. Record feature ablations.

Use as much lawful, quality-checked multi-year history as available. Explicitly disclose short histories, survivor-only universes, and unavailable point-in-time features. Do not invent historical listings or data to meet a sample target.

For simulated distributions, test volatility-aware residual/block resampling or another justified approach against the simple baseline. Preserve relevant serial and cross-stock dependence. Never imply resampling historical returns captures unseen future shocks or establishes a directional edge. Fix and record seeds for reproducibility, not for selecting flattering paths.

Prefer return/log-price modeling with well-defined conversion to positive prices. The mean and median are different outputs. Quantiles must not cross within a horizon. Do not enforce a steadily rising forecast or force interval widths to widen mechanically just for appearance.

For probabilities, derive them from a supported predictive distribution or a separately validated and clearly identified classifier. Do not infer a precise probability from a few quantiles by unjustified interpolation. Reconcile probability and distribution outputs; do not show incompatible numbers from unrelated models as a single coherent forecast.

Marginal daily forecasts do not automatically define joint stock/time paths. Portfolio uncertainty or target-before-stop probabilities require validated joint/path modeling. Do not sum per-stock quantiles or use the existing fixed 0.35 correlation as a measured portfolio relationship. If joint modeling is unavailable, show marginal holding forecasts and state that portfolio uncertainty is unavailable.

A small isolated Python training/research worker is acceptable if justified by library support. Keep the application/API in the existing stack, exchange versioned artifacts, and avoid unnecessary microservices. Do not train models or run 10,000-path simulations synchronously on page loads.

## 8. Validation and model promotion

Replace the short rolling-window scorecard with a reproducible experiment registry covering multiple market periods where data permits. Group all stocks by date when splitting. Never use random row splits. A standard time-series split alone is not sufficient if overlapping labels still leak.

Use chronological training, validation, calibration, and untouched final test periods. Purge training labels whose outcome intervals overlap evaluation periods; apply an appropriate time gap/embargo for the split design and longest target. Fit feature transforms, feature selection, model weights, thresholds, and calibrators using permitted training/validation data only. Update online models only from matured labels available at that moment.

Compare directional models against constant 50%, training-window base-rate probabilities, and appropriate always-up/majority direction baselines. Compare price forecasts against last-price forecasts. Brier 0.25 is the constant-50% baseline, not a universal definition of useful skill.

Report by horizon: return/price error versus baseline; directional hit rate; Brier/log loss and calibration; quantile loss, interval score or weighted interval score, interval width and coverage; and relevant stock/sector/regime breakdowns. Distinguish cumulative-horizon direction from consecutive-day direction. Specify flat-price handling.

Estimate uncertainty using methods that account for overlapping labels and correlated stocks, such as date-block resampling. Do not call thousands of overlapping predictions thousands of independent observations. Suppress unsupported per-stock certainty claims and publish raw counts alongside effective-sample caveats.

Evaluate decision policies separately from forecasts with realistic execution timing, costs, slippage, turnover, liquidity constraints, and comparable cash/buy-and-hold benchmarks. A forecast using the closing bar cannot assume an executable fill at that same close. Test the subset actually receiving buy labels; report its coverage, not just its hit rate. Do not equate directional accuracy with a trading strategy's win probability.

Calibration must use held-out/matured outcomes. Evaluate rolling/adaptive conformal or quantile recalibration where appropriate, but do not claim that financial time series satisfy exchangeability or that average coverage guarantees each individual prediction. Report interval sharpness as well as coverage.

Before model search, define primary metrics, minimum evidence, acceptable regressions, and economic/materiality requirements. Keep all trials and an untouched holdout. Promote a challenger only after reproducible improvement, uncertainty analysis, relevant stability checks, and prospective shadow evaluation. Repeatedly retuning on the same test period invalidates its holdout status.

If nothing wins, keep the stronger baseline, label "No validated directional edge," and continue research. Do not lower the bar to make the UI say BUY. Model completion and demonstrated predictive improvement are separate deliverables.

## 9. One evidence-gated decision service

Create a canonical DecisionService consumed by Watchlist, Discover, Stock Detail, Holdings, notifications, and any remaining integrations. Identical instrument, timestamp, model, horizon, and user constraints must produce consistent outcomes.

For new entries return BUY_CANDIDATE, WAIT, AVOID_NEW_ENTRY, or INSUFFICIENT_EVIDENCE, with a concise explanation. For existing holdings expose a separate review status; a new-entry warning must not automatically instruct the owner to sell.

Return decisionStatus, intendedHorizon, riskLevel, evidenceStatus, reasons, risks, asOf, validUntil, modelVersion, and decisionPolicyVersion. Distinguish measured probabilities, data completeness, and descriptive scores. A score of 79/100 must never appear as 79% confidence.

Require fresh verified data, validated policy/model evidence for that horizon, plausible net benefit after costs, acceptable downside/liquidity/concentration, and event-risk checks before BUY_CANDIDATE. Thresholds are versioned and validated, not arbitrary changes to force more buys. Insufficient evidence, missing fundamentals, or an unvalidated horizon can legitimately result in no recommendation.

After market close say "Candidate for next session" rather than implying a trade can occur now. Expire stale entry opinions. Do not force five recommendations when fewer qualify.

Keep holding horizon separate from risk tolerance. Product defaults: short term up to 30 calendar days; medium term 31-365 days; long term beyond 365 days. These are product labels, not tax classifications. A 30-day forecast cannot establish a long-term buy recommendation. Long-term suitability requires a separate fundamentals/valuation assessment with its own evidence and missing-data states.

Remove consumer Kelly advice based on directional hit rate, DCF scenario spreads, or assumed 1.5 payoff ratios. Use understandable exposure/concentration warnings instead. A selected target/stop ratio is not a measured payoff ratio; a stop cannot guarantee execution or a maximum loss.

## 10. Frontend behavior and visual redesign

Retain the dark visual identity, but validate layout at 100% browser zoom rather than copying screenshot scale. Use fluid responsive space, readable typography, accessible contrast, visible labels, keyboard navigation, and mobile-friendly cards/tables. Avoid tiny gray text, narrow content islands, stacked score gauges, duplicate badges, and information repeated across four tabs.

Watchlist is the default screen. Show stock identity, observed price/time, next-month median and range where supported, evidence-gated entry status, horizon, key risk, and Add purchase / Open details. Holdings emphasizes invested basis, observed value, realized/unrealized P&L, and projected outcomes clearly separated from actuals.

Stock Detail should contain a compact identity header; decision summary with two or three reasons and risks; one historical/forecast chart; daily forecast/P&L table; monthly prediction-versus-actual history; and expandable fundamentals/events/provenance. Keep advanced indicators out of the primary reading flow.

The daily table exposes date/session state, original forecast, latest outlook when selected, interval, actual close once observed, and actual/projected holding P&L. Distinguish forecast error from the user's investment return. Future actual cells remain empty/pending.

Chart historical observations as solid and future forecasts as dashed with shaded intervals and a clear issuance boundary. Allow original-versus-latest comparison without merging vintages. Explain that bands are estimates, not guarantees. Provide a table alternative and repair duplicated tooltip series or inconsistent labels.

Discover replaces the three discovery screens. Explain ranking basis and coverage. Show the actual supported universe, not "all NSE" when only a subset is covered. Track Record stays easy to find and summarizes live versus backtested results, baseline comparison, coverage, interval width, evaluation dates, and limitations without burying poor results in admin settings.

Add honest loading, empty, stale, insufficient-history, blocked-provider, partial-data, pending-verification, and error states. Never fabricate demo prices or success badges in normal operation.

## 11. Schema, APIs, and background processing

Reuse or migrate existing entities where sensible. Required concepts include User/Account, Instrument/Alias, TradingSession, CorporateAction, Watchlist/Item, Transaction/LotAllocation, Position projection, ForecastRun/Point, ForecastOutcome, ModelVersion/EvaluationRun, DecisionSnapshot, DataQualityIssue, MonthlyReport, and JobRun. Position totals are derived, not independently editable truth.

Keep forecasts and transactions immutable with explicit correction/version relationships. Index account, instrument, issuance, target date, and model version. Separate private holding projections from reusable market forecasts. Use unique constraints and idempotency keys for imports, purchases, forecast requests, verification, and month renewal.

Design documented, typed APIs for watchlists; transactions/holdings; stock forecasts and decisions; original/latest/monthly forecast history; portfolio marked values; public aggregate track record; and protected jobs/evaluation diagnostics. Expose freshness and evidence states in response schemas.

Fix the documented GET /api/backtest/:ticker?days= behavior that overwrites stored official statistics. Read endpoints must not mutate canonical performance results. Run experiments through authenticated job submissions with immutable run IDs and explicit promotion. Separate experimental, walk-forward, and prospective-live results.

Use durable jobs with retries, bounded concurrency, rate limits, distributed locks, deduplication, and failure alerts. Prefer a PostgreSQL-backed queue initially unless another dependency is justified. Ingestion/finalization precedes feature construction; forecasting precedes decision publication; outcome verification waits for real target-session closes. Monthly rollover and startup recovery must catch up without duplicates.

Cache forecasts by instrument, data cutoff/version, model/calibration version, horizon/calendar definition, and other output-affecting inputs. User purchase price or account notes must not alter market forecasts or leak into shared cache entries.

## 12. Security, deployment, and release boundaries

Enforce authenticated ownership on every private read/write and export. Derive user identity server-side. Test cross-user object access, concurrent sales, replayed imports, CSV formula injection, input validation, rate limiting, and secrets handling. Use secure session/cookie and CSRF protections appropriate to the actual architecture. Admin diagnostics and model promotion require separate authorization.

Set synchronize: false outside disposable development and use reviewed migrations. Add backups, tested restoration, structured logs without sensitive account data, health/readiness checks, job/provider/model monitoring, and a documented rollback. Define privacy-aware retention/deletion rules; preserve evaluation evidence without retaining unnecessary personal identifiers.

Default to research and record-keeping, not broker execution. Before public recommendations or commercialization, require qualified review of current Indian securities-research/advice, advertising/performance-claim, privacy, and market-data licensing obligations. An "educational only" label is not a substitute for that review. No promises of guaranteed returns or compliance by disclaimer.

Free-first development is a budget constraint, not permission to redistribute restricted data or call delayed quotes real-time. Surface external blockers and optional paid upgrades without silently buying them.

## 13. Acceptance tests and verification evidence

Preserve meaningful existing regression coverage, then add unit, integration, migration, concurrency, end-to-end, and property-based tests where useful. Acceptance must cover:

1. Watch-only additions create no fictional purchase or P&L.
2. Multiple purchases, partial FIFO sales, corrections, charges, and dividends reconcile; overselling is rejected atomically.
3. Money fixtures in section 4 pass with deterministic rounding.
4. Splits and symbol changes preserve economic ownership; unrelated instruments never merge.
5. Backdated holdings never create falsely live historical predictions.
6. All calendar days display correctly across weekends, exchange holidays, special sessions, February/leap years, and year boundaries.
7. Monthly renewal preserves holdings/cost basis/lifetime history and is idempotent after retries/downtime.
8. Original forecasts remain byte-identical after refreshes, model changes, and month rollover.
9. Outcomes cannot mature before the target close is actually available; missing observations remain pending.
10. Changing future bars/filings cannot alter an earlier point-in-time forecast or fitted training pipeline.
11. Training/validation/calibration/test labels obey time cutoffs and overlap rules across all stocks.
12. Quantiles do not cross; probabilities are bounded; price basis and P&L transformations are consistent.
13. No edge or inadequate data produces an evidence-limited state, not a forced buy.
14. Identical decision context agrees across all UI surfaces and notifications.
15. Provider failures degrade honestly and do not trigger unsafe retries or invented values.
16. No user can access another user's holdings, transactions, exports, or private forecasts.
17. Removed features have no active jobs, dead routes, orphan imports, or hidden requests.
18. Core flows work on mobile and desktop in Chromium, Firefox, and WebKit where the environment supports them; report untested browsers.
19. Performance measurements identify dataset, hardware, concurrency, and cold/warm conditions; no lengthy computation blocks page rendering.
20. Backup restoration and migration rollback/recovery are exercised in an isolated environment.

Do not alter tests merely to conceal defects. Report commands, actual outputs, failures, and unsupported checks. Screenshots of the new working flows must use real connected data or conspicuously labeled fixtures.

## 14. Implementation sequence and final handover

Phase A: repository audit, isolated baseline, data/security correctness, and removal/dependency plan.
Phase B: safe navigation cleanup, typed contracts, transaction ledger, watchlist/holdings vertical slice, migrations and tests.
Phase C: immutable daily/monthly forecasting, P&L projection, outcome verification, renewal and history UI.
Phase D: expanded datasets, benchmark/challenger experiments, calibration, decision-policy validation, and prospective shadow mode.
Phase E: integration hardening, accessibility/browser/performance checks, observability, operational documentation, and release review.

Keep a usable app after each phase. After a verified phase, continue to the next safe phase. If session limits interrupt progress, save a reproducible checkpoint and exact next commands. Separate safe code implementation from irreversible data changes and public release. Do not declare prospective validation complete just because code or a historical test passes.

Deliver the feature-removal matrix; working code and migrations; updated ARCHITECTURE.md; API/schema documentation; data/forecast/accounting definitions; model/evaluation cards; a measured before-versus-after report; test evidence; screenshots; setup and rollback instructions; remaining blockers; and docs/next-session.md.

Your final report must distinguish IMPLEMENTED, VERIFIED, EXPERIMENTAL, and BLOCKED. Identify exactly which features and jobs were removed, which existing assets were preserved, and whether predictive performance actually improved. An excellent implementation with no demonstrated directional edge must say so plainly.

Begin by inspecting the repository and creating the audit and plan. Then execute the first safe phase.
