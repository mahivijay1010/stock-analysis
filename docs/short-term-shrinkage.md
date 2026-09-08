# Short-Term shrinkage (empirical Bayes)

Setup cells are often sparse; a stock with five examples must not show an
extreme rate. `shrinkToward` applies James–Stein-style shrinkage
(weight = n/(n+k), k=25) toward a prior, and `hierarchicalShrink` chains
stock→sector→global, recording WHICH level supplied the estimate. Only the
shrunk estimate enters the decision system (`ConditionalShortTermForecast`).
A 5-sample cell is pulled ~83% toward its parent; a 500-sample cell keeps ~95%
of its own signal. Below `minCellN` a level cannot be a standalone source and
the estimate falls back to the fully-shrunk parent/global value.
