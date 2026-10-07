'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Coins, ShieldAlert } from 'lucide-react';
import { getValuation, ValuationRow } from '@/lib/api';
import { Card, Chip } from '@/components/ui';

/**
 * Valuation & quality — the honest "is it cheap?" panel for sub-₹100 names.
 * It is DESCRIPTIVE, not a buy signal, and its real job in this price band is
 * TRAP DETECTION: a cheap name that fails a quality/ownership check is flagged,
 * not praised. The anchor is the DCF margin of safety (assumption-sensitive,
 * labelled). Fundamentals load in the background; names without them are hidden.
 */

const VERDICT_META: Record<string, { label: string; tone: 'emerald' | 'amber' | 'rose' | 'zinc' }> = {
  UNDERVALUED_QUALITY: { label: 'Undervalued + quality', tone: 'emerald' },
  CHEAP_BUT_RISKY: { label: 'Cheap but risky', tone: 'amber' },
  FAIR: { label: 'Fairly valued', tone: 'zinc' },
  EXPENSIVE: { label: 'Expensive', tone: 'zinc' },
  VALUE_TRAP: { label: 'Value trap', tone: 'rose' },
};

function pct(n: number | null): string {
  return n == null ? '—' : `${n > 0 ? '+' : ''}${Math.round(n)}%`;
}
function x(n: number | null): string {
  return n == null ? '—' : n.toFixed(1);
}

function ValRow({ v }: { v: ValuationRow }) {
  const [open, setOpen] = useState(false);
  const meta = VERDICT_META[v.verdict] ?? { label: v.verdict, tone: 'zinc' as const };
  return (
    <div className={clsx('rounded-lg border p-3', v.isValueTrap ? 'border-rose-500/25 bg-rose-500/[0.03]' : 'border-white/10 bg-white/[0.02]')}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-100">{v.symbol}</span>
          <Chip tone={meta.tone} glow={v.verdict === 'UNDERVALUED_QUALITY'}>{meta.label}</Chip>
          {v.isValueTrap && <ShieldAlert className="h-3.5 w-3.5 text-rose-400" aria-hidden />}
        </div>
        <div className="flex items-center gap-4 text-[11px] tabular-nums text-slate-400">
          <span title="DCF base-case margin of safety" className={clsx((v.dcfMarginOfSafetyPct ?? 0) > 0 ? 'text-emerald-300' : 'text-slate-400')}>MoS {pct(v.dcfMarginOfSafetyPct)}</span>
          <span>ROCE {v.roce != null ? `${Math.round(v.roce)}%` : '—'}</span>
          <span>P/E {x(v.pe)}</span>
          <ChevronDown className={clsx('h-4 w-4 text-slate-600 transition', open && 'rotate-180')} aria-hidden />
        </div>
      </button>
      {open && (
        <div className="mt-2 border-t border-white/10 pt-2">
          <div className="grid grid-cols-3 gap-2 text-[11px] sm:grid-cols-6">
            <div><p className="text-slate-600">Price</p><p className="tabular-nums text-slate-300">{v.price != null ? `₹${v.price}` : '—'}</p></div>
            <div><p className="text-slate-600">P/B</p><p className="tabular-nums text-slate-300">{x(v.pb)}</p></div>
            <div><p className="text-slate-600">ROE</p><p className="tabular-nums text-slate-300">{v.roe != null ? `${Math.round(v.roe)}%` : '—'}</p></div>
            <div><p className="text-slate-600">D/E</p><p className="tabular-nums text-slate-300">{x(v.deRatio)}</p></div>
            <div><p className="text-slate-600">Promoter</p><p className="tabular-nums text-slate-300">{v.promoterHolding != null ? `${Math.round(v.promoterHolding)}%` : '—'}</p></div>
            <div><p className="text-slate-600">Prom Δ QoQ</p><p className={clsx('tabular-nums', (v.promoterChangeQoq ?? 0) < 0 ? 'text-rose-300' : 'text-slate-300')}>{v.promoterChangeQoq != null ? `${v.promoterChangeQoq}pp` : '—'}</p></div>
          </div>
          {v.trapFlags.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-rose-300/80">
              {v.trapFlags.map((f, i) => <li key={i}>⚠ {f}</li>)}
            </ul>
          )}
          <p className="mt-1.5 text-[11px] text-slate-600">{v.notes[0]}</p>
        </div>
      )}
    </div>
  );
}

export function ValuationPanel() {
  const { data, isLoading } = useQuery({ queryKey: ['valuation'], queryFn: () => getValuation(), staleTime: 300_000 });
  const rows = (data?.rows ?? []).filter((r) => r.verdict !== 'INSUFFICIENT_DATA');
  const loaded = rows.length;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <Coins className="h-4 w-4 text-amber-400" aria-hidden />
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-200">Valuation &amp; quality — cheap, or a trap?</h2>
      </div>
      <p className="mt-0.5 max-w-3xl text-[11px] text-slate-500">
        Descriptive only, <span className="text-slate-300">never a buy signal</span>. In this price band &quot;cheap&quot; is usually cheap for a reason — the real job here is flagging <span className="text-rose-300">value traps</span>. The anchor is the DCF margin of safety (assumption-sensitive).
      </p>

      {isLoading && <p className="mt-4 text-xs text-slate-500">Loading cached fundamentals…</p>}
      {!isLoading && loaded === 0 && (
        <p className="mt-4 text-xs text-slate-500">
          No fundamentals loaded yet for the sub-₹100 names. The background job fetches them from NSE filings + Screener (~20–30s each). Check back shortly, or an admin can POST <code className="text-slate-400">/api/short-term/refresh-fundamentals</code>.
        </p>
      )}
      {loaded > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-[11px] text-slate-600">{loaded} names with loaded fundamentals, ranked by value score (cheap × quality, trap-penalised).</p>
          {rows.map((v) => <ValRow key={v.ticker} v={v} />)}
        </div>
      )}
    </Card>
  );
}
