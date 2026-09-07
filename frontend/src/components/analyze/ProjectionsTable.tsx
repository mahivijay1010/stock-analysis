'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { IndianRupee } from 'lucide-react';
import type { HorizonPrediction, ProjectionRow } from '@/lib/types';
import { HORIZONS } from '@/lib/types';
import { inr, inrSmart, plain, signedInr } from '@/lib/format';
import { Card, SectionTitle } from '@/components/ui';
import { signTone } from './tone';

const LS_KEY = 'stocksense.projBase';
const DEFAULT_BASE = 1000;
/** Display cap — rows above ₹10 crore are skipped. */
const MAX_ROW = 10_00_00_000;
const MULTIPLIERS = [1, 10, 100, 1000] as const;

/** Parse a free-form en-IN ₹ string ("2,500", "₹ 5000") → whole rupees, or null. */
function parseBase(rawValue: string): number | null {
  const cleaned = rawValue.replace(/[₹,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 1 || n > MAX_ROW) return null;
  return Math.round(n);
}

function loadBase(): number {
  if (typeof window === 'undefined') return DEFAULT_BASE;
  try {
    const stored = window.localStorage.getItem(LS_KEY);
    const n = stored == null ? NaN : Number(stored);
    return Number.isFinite(n) && n >= 1 && n <= MAX_ROW ? Math.round(n) : DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

function persistBase(v: number) {
  try {
    window.localStorage.setItem(LS_KEY, String(v));
  } catch {
    /* non-fatal */
  }
}

/** Same math the backend uses: value = amt × (1 + pct/100); 80% range from low80Pct/high80Pct. */
function buildRow(amount: number, predictions: HorizonPrediction[]): ProjectionRow {
  return {
    amount,
    byHorizon: predictions.map((p) => {
      const expectedValue = amount * (1 + p.expectedReturnPct / 100);
      return {
        horizonDays: p.horizonDays,
        expectedValue,
        lowValue: amount * (1 + p.low80Pct / 100),
        highValue: amount * (1 + p.high80Pct / 100),
        expectedProfit: expectedValue - amount,
      };
    }),
  };
}

/**
 * "If you invested…" — the ₹ base is editable (default ₹1,000, persisted) and
 * the [base, ×10, ×100, ×1000] ladder is recomputed client-side from the same
 * horizon predictions the backend used. The exact-amount plan row (when an
 * amount was analyzed) stays pinned and highlighted.
 */
export function ProjectionsTable({
  predictions,
  investmentPlanRow,
  highlightAmount,
}: {
  predictions: HorizonPrediction[];
  /** Server-computed row for the exact analyzed amount (kept verbatim + highlighted). */
  investmentPlanRow?: ProjectionRow | null;
  highlightAmount?: number | null;
}) {
  // This card only renders after the analyze query resolves (client-side),
  // so a lazy localStorage initializer carries no hydration risk.
  const [base, setBase] = useState<number>(() => loadBase());
  const [raw, setRaw] = useState<string>(() => plain(loadBase(), 0));

  const parsed = parseBase(raw);
  const invalid = raw.trim().length > 0 && parsed == null;

  const onRawChange = (v: string) => {
    setRaw(v);
    const p = parseBase(v);
    if (p != null) {
      setBase(p);
      persistBase(p);
    }
  };

  const rows = useMemo(() => {
    const ladder = MULTIPLIERS.map((m) => base * m)
      .filter((amt) => amt <= MAX_ROW)
      .map((amt) => buildRow(amt, predictions));
    if (investmentPlanRow) {
      return [investmentPlanRow, ...ladder.filter((r) => r.amount !== investmentPlanRow.amount)];
    }
    return ladder;
  }, [base, predictions, investmentPlanRow]);

  if (!predictions.length && !investmentPlanRow) return null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionTitle>If you invested…</SectionTitle>
          <p className="mt-1 text-xs text-slate-500">
            Expected value of a lump-sum investment at each horizon, with the 80% interval. Estimates, not
            guarantees.
          </p>
        </div>
        <div className="shrink-0">
          <div className="relative w-40">
            <IndianRupee
              className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
              aria-hidden
            />
            <input
              type="text"
              inputMode="numeric"
              aria-label="Base investment amount in rupees"
              value={raw}
              onChange={(e) => onRawChange(e.target.value)}
              onBlur={() => setRaw(plain(base, 0))}
              placeholder={plain(DEFAULT_BASE, 0)}
              className="input-glass py-1.5 pr-3 pl-8 text-sm tabular-nums"
            />
          </div>
          <p className={clsx('mt-1 text-right text-[11px]', invalid ? 'text-amber-400' : 'text-slate-500')}>
            {invalid ? 'Enter ₹1 – ₹10,00,00,000' : `rows: base, ×10, ×100, ×1000`}
          </p>
        </div>
      </div>
      <div className="thin-scroll mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-white/8 text-left text-xs text-slate-400">
              <th className="py-2.5 pr-4 font-medium">Investment</th>
              {HORIZONS.map((h) => (
                <th key={h} className="px-3 py-2.5 font-medium">
                  {h} day{h > 1 ? 's' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.amount}
                className={clsx(
                  'border-b border-white/5 transition-shadow last:border-0 hover:bg-cyan-400/6 hover:shadow-[inset_0_0_20px_rgba(34,211,238,0.06)]',
                  highlightAmount != null && row.amount === highlightAmount && 'bg-cyan-400/5',
                )}
              >
                <th scope="row" className="py-3 pr-4 text-left align-top font-semibold whitespace-nowrap text-slate-100">
                  {inr(row.amount, 0)}
                  {highlightAmount != null && row.amount === highlightAmount && (
                    <span className="mt-0.5 block text-[11px] font-medium text-cyan-400">your amount</span>
                  )}
                </th>
                {HORIZONS.map((h) => {
                  const cell = row.byHorizon.find((c) => c.horizonDays === h);
                  if (!cell) {
                    return (
                      <td key={h} className="px-3 py-3 align-top text-slate-600">
                        —
                      </td>
                    );
                  }
                  return (
                    <td key={h} className="px-3 py-3 align-top">
                      <div className="font-display font-semibold whitespace-nowrap text-slate-100 tabular-nums">
                        {inrSmart(cell.expectedValue)}
                      </div>
                      <div className={clsx('text-xs font-medium whitespace-nowrap tabular-nums', signTone(cell.expectedProfit))}>
                        {signedInr(cell.expectedProfit)}
                      </div>
                      <div className="text-[11px] whitespace-nowrap text-slate-500">
                        range: {inrSmart(cell.lowValue)} – {inrSmart(cell.highValue)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
