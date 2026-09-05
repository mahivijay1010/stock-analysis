'use client';

import { useEffect, useRef, useState } from 'react';
import { IndianRupee } from 'lucide-react';
import { AMOUNT_MAX, AMOUNT_MIN } from '@/lib/types';
import { plain } from '@/lib/format';

const LS_KEY = 'stocksense.investAmount';

/** Parse a free-form ₹ string; null when empty or outside the spec range (₹100 – ₹10 crore). */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n < AMOUNT_MIN || n > AMOUNT_MAX) return null;
  return Math.round(n);
}

/**
 * Optional "How much do you want to invest?" input. Persists the last value in
 * localStorage and reports the parsed ₹ amount (debounced) via onAmountChange.
 */
export function AmountInput({ onAmountChange, prominent = false }: { onAmountChange: (amount: number | null) => void; prominent?: boolean }) {
  const [raw, setRaw] = useState('');
  const skipFirstDebounce = useRef(true);

  // Load the persisted value once on mount (client-only — avoids hydration mismatch).
  useEffect(() => {
    const stored = window.localStorage.getItem(LS_KEY) ?? '';
    if (stored) {
      setRaw(stored);
      onAmountChange(parseAmount(stored));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced persist + apply so typing does not refire the analysis per keystroke.
  useEffect(() => {
    if (skipFirstDebounce.current) {
      skipFirstDebounce.current = false;
      return;
    }
    const t = setTimeout(() => {
      window.localStorage.setItem(LS_KEY, raw);
      onAmountChange(parseAmount(raw));
    }, 600);
    return () => clearTimeout(t);
  }, [raw, onAmountChange]);

  const parsed = parseAmount(raw);
  const invalid = raw.trim().length > 0 && parsed == null;

  return (
    <div className={prominent ? 'w-full' : 'w-full sm:max-w-64'}>
      <div className="relative">
        <IndianRupee
          className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-500"
          aria-hidden
        />
        <input
          type="text"
          inputMode="numeric"
          aria-label="How much do you want to invest? (optional)"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={() => {
            if (parsed != null) setRaw(plain(parsed, 0));
          }}
          placeholder="How much to invest? (optional)"
          className={prominent ? 'input-glass py-3.5 pr-3 pl-10' : 'input-glass py-2.5 pr-3 pl-10'}
        />
      </div>
      {invalid ? (
        <p className="mt-1 px-1 text-xs text-amber-400">Enter between ₹100 and ₹10,00,00,000.</p>
      ) : parsed != null ? (
        <p className="mt-1 px-1 text-xs text-slate-500">Plan for ₹{plain(parsed, 0)} will be included.</p>
      ) : null}
    </div>
  );
}
