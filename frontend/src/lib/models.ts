// V7 helpers — display names for the six-model pool plus tolerant readers for
// the shapes the backend (built in parallel to SPEC_V7.md) may emit. Every
// reader degrades to null/empty instead of throwing, so UI sections can hide
// themselves gracefully when a field is absent or shaped differently.

import type {
  CalibrationModelsAggregate,
  EnsembleBlock,
  FeatureContribution,
  Horizon,
} from './types';

/** Canonical display order of the pool (spec A1). Unknown models sort last. */
export const MODEL_ORDER = ['momentum', 'meanReversion', 'trend', 'volAdjusted', 'sentiment', 'macro'] as const;

export const MODEL_LABELS: Record<string, string> = {
  momentum: 'Momentum',
  meanReversion: 'Mean reversion',
  trend: 'Trend',
  volAdjusted: 'Vol-adjusted',
  sentiment: 'Sentiment',
  macro: 'Macro',
};

export function modelLabel(name: string | null | undefined): string {
  if (!name) return '—';
  return MODEL_LABELS[name] ?? name;
}

export function sortModelNames(names: string[]): string[] {
  return names.slice().sort((a, b) => {
    const ia = MODEL_ORDER.indexOf(a as (typeof MODEL_ORDER)[number]);
    const ib = MODEL_ORDER.indexOf(b as (typeof MODEL_ORDER)[number]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
}

/* ------------------------------------------------------------------ */
/* Aggregate `models` table on /api/calibration (spec A5.1)            */
/* ------------------------------------------------------------------ */

export interface NormalizedModelStat {
  brier: number | null;
  hitRatePct: number | null;
  samples: number | null;
}

/** model name → horizonDays → stats. */
export type ModelAggregate = Map<string, Map<number, NormalizedModelStat>>;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toStat(v: unknown): NormalizedModelStat | null {
  const bare = num(v);
  if (bare != null) return { brier: bare, hitRatePct: null, samples: null };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { brier?: unknown; brierScore?: unknown; hitRatePct?: unknown; samples?: unknown };
    const brier = num(o.brier) ?? num(o.brierScore);
    const hitRatePct = num(o.hitRatePct);
    const samples = num(o.samples);
    if (brier == null && hitRatePct == null && samples == null) return null;
    return { brier, hitRatePct, samples };
  }
  return null;
}

/** Horizon keys may arrive as 7, "7" or "7d". */
function horizonOf(key: string | number): number | null {
  const n = typeof key === 'number' ? key : Number(String(key).replace(/d$/i, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ingestHorizons(v: unknown, put: (h: number, stat: NormalizedModelStat | null) => void): void {
  if (v == null) return;
  if (Array.isArray(v)) {
    for (const item of v as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const h = horizonOf((o.horizonDays ?? o.horizon ?? NaN) as string | number);
      if (h != null) put(h, toStat(o));
    }
    return;
  }
  if (typeof v === 'object') {
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      const h = horizonOf(k);
      if (h != null) put(h, toStat(item));
    }
  }
}

/**
 * Normalize the aggregate per-model table into model → horizon → stats,
 * accepting model-major arrays, horizon-major arrays and model-keyed records
 * (see CalibrationModelsAggregate in types.ts). Unreadable input → empty map.
 */
export function normalizeModelAggregate(input: CalibrationModelsAggregate | null | undefined): ModelAggregate {
  const out: ModelAggregate = new Map();
  const put = (model: string, horizon: number, stat: NormalizedModelStat | null) => {
    if (!stat) return;
    let byH = out.get(model);
    if (!byH) {
      byH = new Map();
      out.set(model, byH);
    }
    byH.set(horizon, stat);
  };

  const raw: unknown = input;
  if (raw == null || typeof raw !== 'object') return out;

  // Wrapper object the backend actually ships (src/types CalibrationModels):
  // { perModel: [{ model, horizons: [...] }], blended, engineBaseline,
  //   bestByHorizon, note }. Unwrap the model-major rows and ignore the
  // aggregate meta keys — blended/engineBaseline/bestByHorizon are NOT pool
  // models and must not become table rows.
  if (!Array.isArray(raw) && Array.isArray((raw as { perModel?: unknown }).perModel)) {
    return normalizeModelAggregate(
      (raw as { perModel: CalibrationModelsAggregate }).perModel,
    );
  }

  if (Array.isArray(raw)) {
    for (const entry of raw as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const modelName = typeof e.model === 'string' ? e.model : typeof e.name === 'string' ? e.name : null;
      if (modelName) {
        ingestHorizons(e.horizons, (h, stat) => put(modelName, h, stat));
        continue;
      }
      const h = horizonOf((e.horizonDays ?? e.horizon ?? NaN) as string | number);
      if (h != null && e.models && typeof e.models === 'object') {
        for (const [m, v] of Object.entries(e.models as Record<string, unknown>)) put(m, h, toStat(v));
      }
    }
    return out;
  }

  for (const [m, v] of Object.entries(raw as Record<string, unknown>)) {
    ingestHorizons(v, (h, stat) => put(m, h, stat));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ensemble block readers (spec A2.4)                                  */
/* ------------------------------------------------------------------ */

/** Blended P(up) at a horizon, tolerating string keys ("7", "7d"). Null when absent. */
export function blendedProbUpAt(ensemble: EnsembleBlock | null | undefined, horizon: Horizon): number | null {
  const rec = ensemble?.blendedProbUp as Record<string | number, unknown> | null | undefined;
  if (!rec || typeof rec !== 'object') return null;
  const v = rec[horizon] ?? rec[String(horizon)] ?? rec[`${horizon}d`];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One display line per feature contribution, e.g. "r20 +0.8σ → +0.06 prob". Null when unreadable. */
export function contributionText(entry: FeatureContribution | null | undefined): string | null {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry.trim() || null;
  if (typeof entry !== 'object') return null;
  const detail = entry.detail ?? entry.text;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  const feature = entry.feature ?? entry.name ?? entry.label;
  if (!feature) return null;
  const value = entry.value ?? entry.z;
  const contribution = entry.contribution ?? entry.deltaProb;
  let s = feature;
  if (typeof value === 'number' && Number.isFinite(value)) {
    s += ` ${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1)}σ`;
  }
  if (typeof contribution === 'number' && Number.isFinite(contribution)) {
    s += ` → ${contribution < 0 ? '−' : '+'}${Math.abs(contribution).toFixed(2)} prob`;
  }
  return s;
}

/** The contributions list under either key, formatted and de-nulled. */
export function contributionLines(ensemble: EnsembleBlock | null | undefined): string[] {
  const rawList = ensemble?.featureContributions ?? ensemble?.contributions ?? [];
  if (!Array.isArray(rawList)) return [];
  return rawList.map(contributionText).filter((s): s is string => s != null);
}
