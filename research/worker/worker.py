"""StockSense forecasting worker (completion directive, Phase 2).

Stdlib http.server + scikit-learn (repo-local venv). Serves batch
fit-predict for the ML challengers over features the TS side computed with
zero lookahead. This process holds NO state between requests, never touches
the database, and never invents data: rows with missing features are imputed
with TRAIN medians (a documented, train-only transform — no leakage).

Run:  research/worker/.venv/bin/python research/worker/worker.py  (port 5102)

Models:
  elastic-net      sklearn ElasticNetCV (returns; quantiles from residual σ)
  logistic         sklearn LogisticRegression (direction, L2)
  hgb-regressor    HistGradientBoostingRegressor + quantile variants (p10/p90)
  hgb-classifier   HistGradientBoostingClassifier (direction)
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import ElasticNetCV, LogisticRegression

PORT = 5102
VERSION = "worker-v2-panel"
Z90 = 1.2816


def build_matrix(rows, feature_names=None, medians=None):
    """Rows -> (X, feature_names, medians). Train-only median imputation."""
    if feature_names is None:
        counts = {}
        for r in rows:
            for k, v in r["features"].items():
                if v is not None and np.isfinite(v):
                    counts[k] = counts.get(k, 0) + 1
        feature_names = sorted(k for k, c in counts.items() if c >= 0.9 * len(rows))
    X = np.full((len(rows), len(feature_names)), np.nan)
    for i, r in enumerate(rows):
        for j, k in enumerate(feature_names):
            v = r["features"].get(k)
            if v is not None and np.isfinite(v):
                X[i, j] = v
    if medians is None:
        medians = np.nanmedian(X, axis=0)
        medians = np.where(np.isfinite(medians), medians, 0.0)
    idx = np.where(np.isnan(X))
    X[idx] = np.take(medians, idx[1])
    return X, feature_names, medians


def fit_predict(payload):
    model_name = payload["model"]
    train = payload["train"]
    eval_rows = payload["eval"]
    if len(train) < 100:
        return {"error": f"insufficient training rows ({len(train)} < 100)"}

    y = np.array([r["target"] for r in train], dtype=float)
    X, names, med = build_matrix(train)
    Xe, _, _ = build_matrix(eval_rows, feature_names=names, medians=med)
    training_end = max(r["key"].split("|")[1] for r in train)
    preds = []

    def out(key, expected=None, prob=None, p10=None, p50=None, p90=None):
        preds.append(
            {
                "key": key,
                "expectedReturn": None if expected is None else float(expected),
                "rawDirectionProbability": None if prob is None else float(min(1 - 1e-6, max(1e-6, prob))),
                "p10": None if p10 is None else float(p10),
                "p50": None if p50 is None else float(p50),
                "p90": None if p90 is None else float(p90),
            }
        )

    if model_name == "elastic-net":
        m = ElasticNetCV(l1_ratio=[0.1, 0.5, 0.9], cv=5, alphas=30, max_iter=5000, random_state=0)
        m.fit(X, y)
        resid = y - m.predict(X)
        sigma = max(1e-6, float(np.std(resid, ddof=1)))
        mu = m.predict(Xe)
        from math import erf, sqrt

        for r, m_i in zip(eval_rows, mu):
            prob = 0.5 * (1 + erf((m_i / sigma) / sqrt(2)))
            out(r["key"], expected=m_i, prob=prob, p10=m_i - Z90 * sigma, p50=m_i, p90=m_i + Z90 * sigma)

    elif model_name == "logistic":
        yc = (y > 0).astype(int)
        if len(set(yc)) < 2:
            return {"error": "degenerate direction labels in train"}
        m = LogisticRegression(C=1.0, max_iter=2000)
        m.fit(X, yc)
        p = m.predict_proba(Xe)[:, 1]
        for r, p_i in zip(eval_rows, p):
            out(r["key"], prob=p_i)

    elif model_name == "hgb-regressor":
        mid = HistGradientBoostingRegressor(max_iter=200, max_depth=3, learning_rate=0.05, random_state=0)
        lo = HistGradientBoostingRegressor(loss="quantile", quantile=0.1, max_iter=150, max_depth=3, learning_rate=0.05, random_state=0)
        hi = HistGradientBoostingRegressor(loss="quantile", quantile=0.9, max_iter=150, max_depth=3, learning_rate=0.05, random_state=0)
        mid.fit(X, y)
        lo.fit(X, y)
        hi.fit(X, y)
        resid = y - mid.predict(X)
        sigma = max(1e-6, float(np.std(resid, ddof=1)))
        mu = mid.predict(Xe)
        q10 = lo.predict(Xe)
        q90 = hi.predict(Xe)
        from math import erf, sqrt

        for r, m_i, l_i, h_i in zip(eval_rows, mu, q10, q90):
            l2, h2 = (min(l_i, m_i), max(h_i, m_i))  # enforce non-crossing (spec §7)
            prob = 0.5 * (1 + erf((m_i / sigma) / sqrt(2)))
            out(r["key"], expected=m_i, prob=prob, p10=l2, p50=m_i, p90=h2)

    elif model_name == "hgb-classifier":
        yc = (y > 0).astype(int)
        if len(set(yc)) < 2:
            return {"error": "degenerate direction labels in train"}
        m = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.05, random_state=0)
        m.fit(X, yc)
        p = m.predict_proba(Xe)[:, 1]
        for r, p_i in zip(eval_rows, p):
            out(r["key"], prob=p_i)

    else:
        return {"error": f"unknown model '{model_name}'"}

    return {"model": model_name, "version": VERSION, "trainingEndDate": training_end, "predictions": preds}


def panel_matrix(rows, feature_names, medians=None):
    """Panel rows -> (X, medians). Train-only median imputation (documented)."""
    X = np.full((len(rows), len(feature_names)), np.nan)
    for i, r in enumerate(rows):
        for j, k in enumerate(feature_names):
            v = r["features"].get(k)
            if v is not None and np.isfinite(v):
                X[i, j] = v
    if medians is None:
        medians = np.nanmedian(X, axis=0)
        medians = np.where(np.isfinite(medians), medians, 0.0)
    idx = np.where(np.isnan(X))
    X[idx] = np.take(medians, idx[1])
    return X, medians


def panel_fit_predict(payload):
    """Cross-sectional panel models (upgrade Parts 6/7): regression on excess
    returns, binary outperform-probability, and LambdaRank. Train rows carry
    `target` (excess return); rank grades are derived per TRAIN date only."""
    model_name = payload["model"]
    feature_names = payload["featureNames"]
    train = payload["train"]
    eval_rows = payload["eval"]
    if len(train) < 500:
        return {"error": f"insufficient panel training rows ({len(train)} < 500)"}

    X, med = panel_matrix(train, feature_names)
    Xe, _ = panel_matrix(eval_rows, feature_names, medians=med)
    y = np.array([r["target"] for r in train], dtype=float)
    training_end = max(r["date"] for r in train)
    out = []

    def emit(scores, probs=None):
        for k, r in enumerate(eval_rows):
            out.append({
                "id": r["id"],
                "score": float(scores[k]),
                "prob": None if probs is None else float(min(1 - 1e-6, max(1e-6, probs[k]))),
            })

    if model_name == "lgbm-reg":
        import lightgbm as lgb
        m = lgb.LGBMRegressor(n_estimators=400, num_leaves=31, learning_rate=0.03,
                              min_child_samples=50, subsample=0.8, colsample_bytree=0.8,
                              random_state=0, verbose=-1)
        m.fit(X, y)
        emit(m.predict(Xe))

    elif model_name == "lgbm-cls":
        import lightgbm as lgb
        yc = (y > 0).astype(int)
        if len(set(yc)) < 2:
            return {"error": "degenerate outperform labels"}
        m = lgb.LGBMClassifier(n_estimators=400, num_leaves=31, learning_rate=0.03,
                               min_child_samples=50, subsample=0.8, colsample_bytree=0.8,
                               random_state=0, verbose=-1)
        m.fit(X, yc)
        p = m.predict_proba(Xe)[:, 1]
        emit(p, probs=p)

    elif model_name == "lgbm-rank":
        import lightgbm as lgb
        # LambdaRank: group by TRAIN date; grade = within-date quintile of excess return.
        order = np.argsort([r["date"] for r in train], kind="stable")
        Xs, ys = X[order], y[order]
        dates_sorted = [train[k]["date"] for k in order]
        groups, grades = [], np.zeros(len(ys), dtype=int)
        start = 0
        for k in range(1, len(dates_sorted) + 1):
            if k == len(dates_sorted) or dates_sorted[k] != dates_sorted[start]:
                seg = ys[start:k]
                if len(seg) >= 5:
                    qs = np.quantile(seg, [0.2, 0.4, 0.6, 0.8])
                    grades[start:k] = np.searchsorted(qs, seg)
                groups.append(k - start)
                start = k
        m = lgb.LGBMRanker(objective="lambdarank", n_estimators=300, num_leaves=31,
                           learning_rate=0.05, min_child_samples=30, random_state=0, verbose=-1)
        m.fit(Xs, grades, group=groups)
        emit(m.predict(Xe))

    elif model_name == "xgb-reg":
        import xgboost as xgb
        m = xgb.XGBRegressor(n_estimators=400, max_depth=5, learning_rate=0.03,
                             subsample=0.8, colsample_bytree=0.8, random_state=0, verbosity=0)
        m.fit(X, y)
        emit(m.predict(Xe))

    elif model_name == "cat-reg":
        from catboost import CatBoostRegressor
        m = CatBoostRegressor(iterations=400, depth=6, learning_rate=0.03,
                              random_seed=0, verbose=False)
        m.fit(X, y)
        emit(m.predict(Xe))

    elif model_name == "enet-reg":
        m = ElasticNetCV(l1_ratio=[0.1, 0.5, 0.9], cv=5, alphas=30, max_iter=5000, random_state=0)
        m.fit(X, y)
        emit(m.predict(Xe))

    else:
        return {"error": f"unknown panel model '{model_name}'"}

    return {"model": model_name, "version": VERSION, "trainingEndDate": training_end, "predictions": out}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "version": VERSION})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/fit-predict", "/panel-fit-predict"):
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(n))
            result = panel_fit_predict(payload) if self.path == "/panel-fit-predict" else fit_predict(payload)
            self._send(200 if "error" not in result else 422, result)
        except Exception as e:  # noqa: BLE001 — report, never crash the server
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    print(f"StockSense forecast worker ({VERSION}) on :{PORT}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
