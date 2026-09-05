'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Calculator, Loader2 } from 'lucide-react';
import { calculateHolding } from '@/lib/api';
import type { HoldingCalcRequest, HoldingCalcResponse } from '@/lib/types';
import { fmtDate, inr, inrSmart, plain, signedInr, signedPct } from '@/lib/format';
import { Card, Chip, DataStatusChip, RecBadge, SectionTitle } from '@/components/ui';
import { signTone } from '@/components/analyze/tone';

type BuyMode = 'price' | 'date';
type SizeMode = 'quantity' | 'amount';

/** The exact request the user submitted — kept so the result labels itself. */
interface SubmittedInfo {
  ticker: string;
  buyMode: BuyMode;
  sizeMode: SizeMode;
  buyPrice?: number;
  buyDate?: string;
  quantity?: number;
  amount?: number;
}

const inputCls = 'input-glass px-3 py-2';

function ModeToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="inline-flex rounded-lg border border-white/8 bg-white/4 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            value === o.value ? 'bg-cyan-400/15 text-cyan-300' : 'text-slate-500 hover:text-slate-300',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ResultStat({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="glass-inset px-3 py-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={clsx('font-display mt-0.5 text-sm font-semibold text-slate-100 tabular-nums', valueClassName)}>
        {value}
      </p>
      {sub != null && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{sub}</p>}
    </div>
  );
}

/** Chips describing exactly what was submitted, so the result is self-describing. */
function SubmittedChips({ s }: { s: SubmittedInfo }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-slate-500">Your inputs:</span>
      <Chip tone="cyan">{s.ticker}</Chip>
      {s.buyMode === 'price' && s.buyPrice != null && <Chip tone="zinc">buy @ {inr(s.buyPrice)}</Chip>}
      {s.buyMode === 'date' && s.buyDate && <Chip tone="zinc">bought {fmtDate(s.buyDate)}</Chip>}
      {s.sizeMode === 'quantity' && s.quantity != null && (
        <Chip tone="zinc">
          {plain(s.quantity, 0)} share{s.quantity === 1 ? '' : 's'}
        </Chip>
      )}
      {s.sizeMode === 'amount' && s.amount != null && <Chip tone="zinc">₹{plain(s.amount, 0)} invested</Chip>}
    </div>
  );
}

/**
 * qty === 0: the amount cannot buy even one share. Render ONLY an honest
 * amber warning (no ₹0 P&L tiles, no forward table) plus a neutral FYI on the
 * price move itself.
 */
function ZeroQuantityResult({ r, s }: { r: HoldingCalcResponse; s: SubmittedInfo }) {
  const minNeeded = r.buyPrice + r.fees.buy;
  const priceMovePct = r.buyPrice > 0 ? (r.currentPrice / r.buyPrice - 1) * 100 : 0;
  const since =
    s.buyMode === 'date' && (r.buyDateUsed || s.buyDate)
      ? `since ${fmtDate((r.buyDateUsed ?? s.buyDate) as string)}`
      : 'since your buy price';

  return (
    <div className="mt-4 border-t border-white/8 pt-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="text-sm font-semibold text-slate-100">
          {r.name} <span className="font-normal text-slate-500">({r.ticker})</span>
        </p>
        <DataStatusChip status={r.dataStatus} />
      </div>
      <SubmittedChips s={s} />

      <div className="mt-3 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4" role="note">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-amber-400">
              {s.amount != null ? `₹${plain(s.amount, 0)}` : 'This amount'} can&apos;t buy a single share at{' '}
              {inr(r.buyPrice)}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-slate-200">
              Minimum needed ≈ {inr(minNeeded)}
              {r.fees.buy > 0 ? ` (price ${inr(r.buyPrice)} + buy fee ${inr(r.fees.buy)})` : ' plus buy fees'} — so
              there is no position and no P&amp;L to show.
            </p>
          </div>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-400">
        FYI: the price itself moved{' '}
        <span className={clsx('font-semibold', signTone(priceMovePct))}>{signedPct(priceMovePct)}</span> {since} (
        {inr(r.buyPrice)} → {inr(r.currentPrice)}) — that is the stock&apos;s move, not your return.
      </p>
    </div>
  );
}

function HoldingResult({ r, s }: { r: HoldingCalcResponse; s: SubmittedInfo }) {
  if (r.quantity === 0) return <ZeroQuantityResult r={r} s={s} />;

  return (
    <div className="mt-4 border-t border-white/8 pt-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="text-sm font-semibold text-slate-100">
          {r.name} <span className="font-normal text-slate-500">({r.ticker})</span>
        </p>
        <RecBadge rec={r.recommendation} />
        <Chip tone="zinc">score {Math.round(r.score)}</Chip>
        <DataStatusChip status={r.dataStatus} />
      </div>

      <SubmittedChips s={s} />

      <p className="mt-2 text-xs text-slate-500">
        Bought {plain(r.quantity, 0)} share{r.quantity === 1 ? '' : 's'} @ {inr(r.buyPrice)}
        {r.buyDateUsed ? ` (close of ${fmtDate(r.buyDateUsed)})` : ''} · current {inr(r.currentPrice)}
        {r.daysHeld != null ? ` · held ${plain(r.daysHeld, 0)} days` : ''}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <ResultStat label="Invested" value={inrSmart(r.invested)} />
        <ResultStat label="Current value" value={inrSmart(r.currentValue)} />
        <ResultStat
          label="Gross P&L"
          value={`${signedInr(r.grossProfit)} (${signedPct(r.grossProfitPct)})`}
          valueClassName={signTone(r.grossProfit)}
        />
        <ResultStat label="Fees (round trip)" value={inr(r.fees.roundTrip)} sub={`buy ${inr(r.fees.buy)} · sell ${inr(r.fees.sell)}`} />
        <ResultStat
          label="Net if you book now"
          value={`${signedInr(r.netProfit)} (${signedPct(r.netProfitPct)})`}
          valueClassName={clsx('text-base', signTone(r.netProfit))}
        />
        <ResultStat
          label={r.annualizedReturnPct != null ? 'Annualized' : 'vs NIFTY 50'}
          value={
            r.annualizedReturnPct != null ? (
              <span className={signTone(r.annualizedReturnPct)}>{signedPct(r.annualizedReturnPct)}</span>
            ) : r.niftyComparison ? (
              <span className={signTone(r.niftyComparison.outperformancePct)}>
                {signedPct(r.niftyComparison.outperformancePct)}
              </span>
            ) : (
              '—'
            )
          }
          sub={
            r.niftyComparison
              ? `NIFTY ${signedPct(r.niftyComparison.returnPct)} over the same period`
              : r.buyDateUsed
                ? undefined
                : 'enter a buy date to compare with NIFTY'
          }
        />
      </div>

      <div className="mt-4">
        <p className="text-xs font-semibold text-slate-300">If you hold instead — same model forecasts, your position</p>
        <div className="thin-scroll mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/8 text-[11px] text-slate-500">
                <th className="py-1.5 pr-3 font-medium">Horizon</th>
                <th className="py-1.5 pr-3 font-medium">Expected value</th>
                <th className="py-1.5 pr-3 font-medium">Expected P&L vs cost</th>
                <th className="py-1.5 font-medium">80% range (value)</th>
              </tr>
            </thead>
            <tbody>
              {r.forwardProjections.map((p) => (
                <tr key={p.horizonDays} className="row-hover border-b border-white/5 last:border-0">
                  <td className="py-1.5 pr-3 text-slate-300">{p.horizonDays}d</td>
                  <td className="py-1.5 pr-3 font-medium text-slate-100">{inrSmart(p.expectedValue)}</td>
                  <td className={clsx('py-1.5 pr-3 font-medium', signTone(p.expectedProfit))}>
                    {signedInr(p.expectedProfit)} ({signedPct(p.expectedProfitPct)})
                  </td>
                  <td className="py-1.5 text-xs text-slate-400">
                    {inrSmart(p.lowValue)} – {inrSmart(p.highValue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-3 glass-inset p-3 text-xs leading-relaxed text-slate-300">{r.note}</p>
    </div>
  );
}

/**
 * "I bought at X — what can I book now?" calculator. Stateless what-if against
 * live prices: buy price (or a date, resolved to that day's real close) +
 * quantity (or ₹ amount) → gross/net P&L after real delivery fees, NIFTY
 * comparison, and hold-vs-book forecasts for the same position.
 */
export function HoldingCalculator({
  defaultTicker = null,
  lockTicker = false,
}: {
  defaultTicker?: string | null;
  lockTicker?: boolean;
}) {
  const [ticker, setTicker] = useState(defaultTicker ?? '');
  const [buyMode, setBuyMode] = useState<BuyMode>('price');
  const [sizeMode, setSizeMode] = useState<SizeMode>('amount');
  const [buyPrice, setBuyPrice] = useState('');
  const [buyDate, setBuyDate] = useState('');
  const [quantity, setQuantity] = useState('');
  const [amount, setAmount] = useState('');
  const [submitted, setSubmitted] = useState<SubmittedInfo | null>(null);

  // When used inside Analyze, follow the analyzed stock.
  const effectiveTicker = lockTicker ? (defaultTicker ?? '') : ticker;

  const calc = useMutation({ mutationFn: (req: HoldingCalcRequest) => calculateHolding(req) });
  const { reset: resetCalc } = calc;

  // Bug fix: a stale result must not survive a ticker/mode change — it would
  // mismatch the inputs. calc.reset() clears calc.data, which hides the result
  // (and its `submitted` label chips, rendered only alongside calc.data).
  useEffect(() => {
    resetCalc();
  }, [buyMode, sizeMode, effectiveTicker, resetCalc]);

  const submit = () => {
    const req: HoldingCalcRequest = { ticker: effectiveTicker.trim() };
    const info: SubmittedInfo = { ticker: effectiveTicker.trim(), buyMode, sizeMode };
    if (buyMode === 'price') {
      req.buyPrice = Number(buyPrice.replace(/[₹,\s]/g, ''));
      info.buyPrice = req.buyPrice;
    } else {
      req.buyDate = buyDate;
      info.buyDate = buyDate;
    }
    if (sizeMode === 'quantity') {
      req.quantity = Number(quantity.replace(/[,\s]/g, ''));
      info.quantity = req.quantity;
    } else {
      req.amount = Number(amount.replace(/[₹,\s]/g, ''));
      info.amount = req.amount;
    }
    setSubmitted(info);
    calc.mutate(req);
  };

  const canSubmit =
    effectiveTicker.trim().length > 0 &&
    (buyMode === 'price' ? buyPrice.trim().length > 0 : buyDate.trim().length > 0) &&
    (sizeMode === 'quantity' ? quantity.trim().length > 0 : amount.trim().length > 0) &&
    !calc.isPending;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-cyan-400" aria-hidden />
          <SectionTitle>Already holding? Profit you can book</SectionTitle>
        </div>
        <p className="text-xs text-slate-500">e.g. bought at ₹10, invested ₹10,000, price now ₹12 → what do I make?</p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!lockTicker && (
          <div>
            <label htmlFor="hc-ticker" className="text-[11px] text-slate-500">
              Stock (name or ticker)
            </label>
            <input
              id="hc-ticker"
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="e.g. SBIN or Suzlon"
              className={clsx(inputCls, 'mt-1')}
            />
          </div>
        )}

        <div>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={buyMode === 'price' ? 'hc-buyprice' : 'hc-buydate'} className="text-[11px] text-slate-500">
              Bought at
            </label>
            <ModeToggle
              value={buyMode}
              onChange={setBuyMode}
              options={[
                { value: 'price', label: '₹ price' },
                { value: 'date', label: 'date' },
              ]}
            />
          </div>
          {buyMode === 'price' ? (
            <input
              id="hc-buyprice"
              type="text"
              inputMode="decimal"
              value={buyPrice}
              onChange={(e) => setBuyPrice(e.target.value)}
              placeholder="buy price, e.g. 10"
              className={clsx(inputCls, 'mt-1')}
            />
          ) : (
            <input
              id="hc-buydate"
              type="date"
              value={buyDate}
              onChange={(e) => setBuyDate(e.target.value)}
              className={clsx(inputCls, 'mt-1 [color-scheme:dark]')}
            />
          )}
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={sizeMode === 'amount' ? 'hc-amount' : 'hc-qty'} className="text-[11px] text-slate-500">
              Position size
            </label>
            <ModeToggle
              value={sizeMode}
              onChange={setSizeMode}
              options={[
                { value: 'amount', label: '₹ invested' },
                { value: 'quantity', label: 'shares' },
              ]}
            />
          </div>
          {sizeMode === 'amount' ? (
            <input
              id="hc-amount"
              type="text"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 10,000"
              className={clsx(inputCls, 'mt-1')}
            />
          ) : (
            <input
              id="hc-qty"
              type="text"
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 1000 shares"
              className={clsx(inputCls, 'mt-1')}
            />
          )}
        </div>

        <div className="flex items-end">
          <button type="button" disabled={!canSubmit} onClick={submit} className="btn-primary w-full px-4 py-2 text-sm">
            {calc.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Calculate profit
          </button>
        </div>
      </div>

      {calc.isError && (
        <p className="mt-3 text-xs text-rose-400">
          {calc.error instanceof Error ? calc.error.message : 'Calculation failed.'}
        </p>
      )}

      {calc.data && submitted && <HoldingResult r={calc.data} s={submitted} />}
    </Card>
  );
}
