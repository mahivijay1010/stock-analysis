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
VERSION = "worker-v1-sklearn"
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
        if self.path != "/fit-predict":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(n))
            result = fit_predict(payload)
            self._send(200 if "error" not in result else 422, result)
        except Exception as e:  # noqa: BLE001 — report, never crash the server
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    print(f"StockSense forecast worker ({VERSION}) on :{PORT}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
