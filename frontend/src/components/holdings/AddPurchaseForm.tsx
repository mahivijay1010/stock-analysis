'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ShoppingCart } from 'lucide-react';
import { createTransaction, correctTransaction } from '@/lib/api';
import type { NewTransactionRequest, TransactionRecord } from '@/lib/types';
import { inr } from '@/lib/format';
import { Button, Card, Input } from '@/components/ui';
import { SearchBox } from '@/components/analyze/SearchBox';

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseQty(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function idempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Purchase capture per spec §3: instrument, executed date, quantity, execution
 * price OR gross amount, separately recorded charges. Dependent values are
 * derived; contradictory qty/price/amount combinations are rejected before the
 * request; an unknown execution price requires explicit confirmation before
 * the day's close may be used as an ESTIMATED input.
 */
export function AddPurchaseForm({
  initialTicker,
  correcting,
  onDone,
}: {
  initialTicker?: string | null;
  /** When set, submits POST /api/transactions/:id/correct instead of a new purchase. */
  correcting?: TransactionRecord | null;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [ticker, setTicker] = useState(correcting?.ticker ?? initialTicker ?? '');
  const [side, setSide] = useState<'BUY' | 'SELL'>(
    correcting?.type === 'SELL' ? 'SELL' : 'BUY',
  );
  const [date, setDate] = useState(correcting?.executedAt?.slice(0, 10) ?? todayIso());
  const [qty, setQty] = useState(correcting?.qty != null ? String(correcting.qty) : '');
  const [price, setPrice] = useState(correcting?.price != null ? String(correcting.price) : '');
  // Gross is left BLANK even when correcting: qty × price already determines
  // it, and pre-filling the original gross would go stale (and falsely read
  // as "contradictory inputs") the moment either qty or price is edited.
  const [gross, setGross] = useState('');
  const [charges, setCharges] = useState(correcting?.charges != null ? String(correcting.charges) : '');
  const [note, setNote] = useState(correcting?.note ?? '');
  const [useEstimatedClose, setUseEstimatedClose] = useState(false);
  const [confirmEstimated, setConfirmEstimated] = useState(false);

  useEffect(() => {
    if (initialTicker && !correcting) setTicker(initialTicker);
  }, [initialTicker, correcting]);

  const qtyN = parseQty(qty);
  const priceN = parseMoney(price);
  const grossN = parseMoney(gross);
  const chargesN = parseMoney(charges);

  const validation = useMemo((): { error: string | null; derived: string | null } => {
    if (!ticker.trim()) return { error: 'Pick a stock first.', derived: null };
    if (!date || date > todayIso()) return { error: 'Executed date must be today or earlier (backdated purchases are fine).', derived: null };
    if (qtyN == null && grossN == null) return { error: 'Enter a quantity (or a gross amount with a price).', derived: null };
    if (useEstimatedClose) {
      if (priceN != null) return { error: 'Uncheck the estimated-price option if you know the execution price.', derived: null };
      if (qtyN == null) return { error: 'Estimated-price entries need an explicit quantity.', derived: null };
      return { error: null, derived: null };
    }
    if (priceN == null && grossN == null) {
      return { error: 'Enter the execution price or the gross amount — or tick the estimated-price option.', derived: null };
    }
    // Contradiction check: qty × price must reconcile with gross when all three are present.
    if (qtyN != null && priceN != null && grossN != null) {
      const implied = qtyN * priceN;
      if (Math.abs(implied - grossN) > Math.max(1, implied * 0.005)) {
        return {
          error: `Contradictory inputs: ${qtyN} × ${inr(priceN)} = ${inr(implied)}, but gross amount says ${inr(grossN)}. Fix one of them.`,
          derived: null,
        };
      }
    }
    if (qtyN != null && priceN != null && grossN == null) {
      return { error: null, derived: `Derived gross: ${inr(qtyN * priceN)}${chargesN != null ? ` + charges ${inr(chargesN)}` : ''}` };
    }
    if (qtyN != null && priceN == null && grossN != null) {
      return { error: null, derived: `Derived price: ${inr(grossN / qtyN)} per share` };
    }
    if (qtyN == null && priceN != null && grossN != null) {
      const impliedQty = grossN / priceN;
      if (!Number.isInteger(Number(impliedQty.toFixed(6)))) {
        return { error: `Gross ÷ price gives a fractional quantity (${impliedQty.toFixed(4)}). Ordinary trades need whole shares.`, derived: null };
      }
      return { error: null, derived: `Derived quantity: ${impliedQty} shares` };
    }
    return { error: null, derived: null };
  }, [ticker, date, qtyN, priceN, grossN, chargesN, useEstimatedClose]);

  const chargesUnknown = chargesN == null;

  const mut = useMutation({
    mutationFn: () => {
      const req: NewTransactionRequest = {
        ticker: ticker.trim().toUpperCase(),
        type: side,
        executedAt: date,
        idempotencyKey: idempotencyKey(),
      };
      if (qtyN != null) req.qty = qtyN;
      if (priceN != null && !useEstimatedClose) req.price = priceN;
      if (grossN != null) req.grossAmount = grossN;
      if (chargesN != null) req.charges = chargesN;
      if (useEstimatedClose) req.priceEstimated = true;
      if (note.trim()) req.note = note.trim();
      return correcting ? correctTransaction(correcting.id, req) : createTransaction(req);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holdings'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      setQty('');
      setPrice('');
      setGross('');
      setCharges('');
      setNote('');
      setUseEstimatedClose(false);
      setConfirmEstimated(false);
      onDone?.();
    },
  });

  const needsEstimateConfirm = useEstimatedClose && !confirmEstimated;
  const canSubmit = !validation.error && !mut.isPending && !needsEstimateConfirm;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-slate-100">
          <ShoppingCart className="h-4 w-4 text-cyan-300" aria-hidden />
          {correcting ? `Correct transaction #${correcting.id} (${correcting.ticker})` : 'Add a purchase / sale'}
        </p>
        {correcting && onDone && (
          <Button variant="ghost" size="sm" onClick={onDone}>Cancel correction</Button>
        )}
      </div>
      {correcting && (
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Corrections supersede the original transaction with a linked record — the ledger keeps both, nothing is
          edited in place.
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <span className="mb-1 block text-[11px] font-medium text-slate-500">Stock</span>
          {ticker ? (
            <div className="flex items-center gap-2">
              <span className="input-glass flex-1 px-3 py-2 text-sm text-slate-100">{ticker.toUpperCase()}</span>
              {!correcting && (
                <Button variant="ghost" size="sm" onClick={() => setTicker('')}>Change</Button>
              )}
            </div>
          ) : (
            <SearchBox onSelect={(t) => setTicker(t)} inputId="purchase-ticker-input" className="max-w-none" />
          )}
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium text-slate-500">Type</span>
          <div className="flex gap-2">
            {(['BUY', 'SELL'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                aria-pressed={side === s}
                className={
                  side === s
                    ? s === 'BUY'
                      ? 'flex-1 rounded-xl border border-buy/40 bg-buy/15 px-3 py-2 text-sm font-semibold text-buy'
                      : 'flex-1 rounded-xl border border-sell/40 bg-sell/15 px-3 py-2 text-sm font-semibold text-sell'
                    : 'flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-400 hover:bg-white/8'
                }
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <Input
          id="purchase-date"
          label="Executed date"
          type="date"
          value={date}
          max={todayIso()}
          onChange={(e) => setDate(e.target.value)}
        />
        <Input
          id="purchase-qty"
          label="Quantity (whole shares)"
          type="text"
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="e.g. 10"
        />
        <Input
          id="purchase-price"
          label="Execution price (₹/share)"
          type="text"
          inputMode="decimal"
          value={price}
          disabled={useEstimatedClose}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="e.g. 1322.40"
        />
        <Input
          id="purchase-gross"
          label="or gross amount (₹)"
          type="text"
          inputMode="decimal"
          value={gross}
          disabled={useEstimatedClose}
          onChange={(e) => setGross(e.target.value)}
          placeholder="e.g. 13224"
        />
        <Input
          id="purchase-charges"
          label="Charges (₹, brokerage+taxes)"
          type="text"
          inputMode="decimal"
          value={charges}
          onChange={(e) => setCharges(e.target.value)}
          placeholder="blank = unknown, stays flagged"
        />
        <Input
          id="purchase-note"
          label="Note (optional)"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="broker ref, reason…"
        />
      </div>

      <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-slate-400">
        <input
          type="checkbox"
          checked={useEstimatedClose}
          onChange={(e) => {
            setUseEstimatedClose(e.target.checked);
            setConfirmEstimated(false);
            if (e.target.checked) {
              setPrice('');
              setGross('');
            }
          }}
          className="mt-0.5 h-4 w-4 accent-cyan-400"
        />
        <span>
          I don&apos;t know the execution price — use that day&apos;s official close as an <strong>estimate</strong>.
          The transaction will be permanently labeled <em>estimated input</em>; the close is never substituted
          silently.
        </span>
      </label>

      {needsEstimateConfirm && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-400/8 px-3 py-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <span className="text-xs text-amber-200">
            Confirm: record this {side} with the {date} close as an estimated price?
          </span>
          <Button variant="secondary" size="sm" onClick={() => setConfirmEstimated(true)}>Yes, label it estimated</Button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="md" onClick={() => mut.mutate()} disabled={!canSubmit}>
          {mut.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {correcting ? 'Submit correction' : `Record ${side}`}
        </Button>
        {validation.error && <span className="text-xs text-amber-300">{validation.error}</span>}
        {!validation.error && validation.derived && (
          <span className="text-xs text-slate-500 tabular-nums">{validation.derived}</span>
        )}
        {!validation.error && chargesUnknown && (
          <span className="text-[11px] text-slate-500">Charges left unknown — they will be flagged, not zeroed.</span>
        )}
      </div>

      {mut.isError && (
        <p className="mt-2 text-xs text-sell" role="alert">
          {mut.error instanceof Error ? mut.error.message : 'The transaction was rejected.'}
        </p>
      )}
      {mut.isSuccess && (
        <p className="mt-2 text-xs text-buy">Recorded. Holdings and history refresh automatically.</p>
      )}
    </Card>
  );
}
