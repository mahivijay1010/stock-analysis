/**
 * Phase D (spec §8) — date-grouped chronological splits with purge + embargo.
 * PURE: operates on sorted arrays of session dates (YYYY-MM-DD).
 *
 * Rules encoded:
 *  - ALL stocks are grouped by date: a date belongs to exactly one segment,
 *    so no random row splits and no cross-sectional leakage across segments.
 *  - Chronological order: train → validation → calibration → test.
 *  - PURGE: a training/earlier-segment date whose label interval
 *    [date, date + horizonDays] overlaps the next segment is dropped — its
 *    outcome would peek across the boundary.
 *  - EMBARGO: an additional gap of embargoDays after each boundary is removed
 *    from the LATER segment, so serial correlation around the boundary cannot
 *    leak fitted state forward.
 */

import { addCalendarDays } from "../forecast/dates";

export interface SplitSpec {
  /** ASCENDING session dates (YYYY-MM-DD), the full usable history. */
  dates: string[];
  /** Longest label horizon in CALENDAR days (purge window). */
  horizonDays: number;
  /** Embargo gap in CALENDAR days applied after each boundary. */
  embargoDays: number;
  /** Fractions summing to ≤ 1; remainder goes to test. */
  trainFrac: number;
  valFrac: number;
  calFrac: number;
}

export interface Splits {
  train: string[];
  validation: string[];
  calibration: string[];
  test: string[];
  purgedFromTrain: string[];
  purgedFromValidation: string[];
  purgedFromCalibration: string[];
  embargoed: string[];
  boundaries: { trainEnd: string; valEnd: string; calEnd: string };
}

/**
 * Split by DATE COUNT fractions, then purge label overlap and apply embargo.
 * Throws when a segment ends up empty — a split that silently vanishes is a
 * configuration error, not a result.
 */
export function buildPurgedSplits(spec: SplitSpec): Splits {
  const { dates, horizonDays, embargoDays, trainFrac, valFrac, calFrac } = spec;
  if (dates.length < 40) {
    throw new Error(`buildPurgedSplits needs at least 40 dates, got ${dates.length}`);
  }
  if (trainFrac + valFrac + calFrac >= 1) {
    throw new Error("trainFrac + valFrac + calFrac must leave room for a test segment");
  }
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] <= dates[i - 1]) throw new Error("dates must be strictly ascending");
  }

  const n = dates.length;
  const trainEndIdx = Math.floor(n * trainFrac) - 1;
  const valEndIdx = Math.floor(n * (trainFrac + valFrac)) - 1;
  const calEndIdx = Math.floor(n * (trainFrac + valFrac + calFrac)) - 1;
  if (trainEndIdx < 0 || valEndIdx <= trainEndIdx || calEndIdx <= valEndIdx || calEndIdx >= n - 1) {
    throw new Error("split fractions produce an empty segment for this history length");
  }

  const rawTrain = dates.slice(0, trainEndIdx + 1);
  const rawVal = dates.slice(trainEndIdx + 1, valEndIdx + 1);
  const rawCal = dates.slice(valEndIdx + 1, calEndIdx + 1);
  const rawTest = dates.slice(calEndIdx + 1);

  // Purge: drop dates in a segment whose [d, d+horizon] crosses into the next.
  const purge = (segment: string[], nextStart: string) => {
    const kept: string[] = [];
    const purged: string[] = [];
    for (const d of segment) {
      if (addCalendarDays(d, horizonDays) >= nextStart) purged.push(d);
      else kept.push(d);
    }
    return { kept, purged };
  };
  // Embargo: drop dates in the LATER segment within embargoDays of the boundary.
  const embargoed: string[] = [];
  const embargo = (segment: string[], boundaryDate: string) => {
    const cutoff = addCalendarDays(boundaryDate, embargoDays);
    return segment.filter((d) => {
      if (d <= cutoff) {
        embargoed.push(d);
        return false;
      }
      return true;
    });
  };

  const t = purge(rawTrain, rawVal[0]);
  const v0 = embargo(rawVal, rawTrain[rawTrain.length - 1]);
  const v = purge(v0, rawCal[0]);
  const c0 = embargo(rawCal, rawVal[rawVal.length - 1]);
  const c = purge(c0, rawTest[0]);
  const te = embargo(rawTest, rawCal[rawCal.length - 1]);

  const out: Splits = {
    train: t.kept,
    validation: v.kept,
    calibration: c.kept,
    test: te,
    purgedFromTrain: t.purged,
    purgedFromValidation: v.purged,
    purgedFromCalibration: c.purged,
    embargoed,
    boundaries: {
      trainEnd: rawTrain[rawTrain.length - 1],
      valEnd: rawVal[rawVal.length - 1],
      calEnd: rawCal[rawCal.length - 1],
    },
  };
  for (const [name, seg] of Object.entries({
    train: out.train,
    validation: out.validation,
    calibration: out.calibration,
    test: out.test,
  })) {
    if (seg.length === 0) throw new Error(`segment "${name}" is empty after purge/embargo`);
  }
  return out;
}

/**
 * Date-block bootstrap indices for uncertainty (spec §8: overlapping labels
 * and correlated stocks — resample DATES in contiguous blocks, never rows).
 * Deterministic under the caller-supplied PRNG.
 */
export function dateBlockBootstrap(
  dates: string[],
  blockLen: number,
  draws: number,
  rand: () => number
): string[][] {
  if (blockLen < 1 || dates.length < blockLen) {
    throw new Error("blockLen must be in 1..dates.length");
  }
  const samples: string[][] = [];
  const blocksNeeded = Math.ceil(dates.length / blockLen);
  for (let s = 0; s < draws; s++) {
    const sample: string[] = [];
    for (let b = 0; b < blocksNeeded; b++) {
      const start = Math.floor(rand() * (dates.length - blockLen + 1));
      sample.push(...dates.slice(start, start + blockLen));
    }
    samples.push(sample.slice(0, dates.length));
  }
  return samples;
}
