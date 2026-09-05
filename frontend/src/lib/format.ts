// INR / en-IN formatting helpers. All currency in this app is INR.

const inr2 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const inr0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** ₹1,23,456.78 */
export function inr(value: number, decimals: 0 | 2 = 2): string {
  return (decimals === 0 ? inr0 : inr2).format(value);
}

/** 2 decimals under ₹1 lakh, whole rupees above — keeps big tables readable. */
export function inrSmart(value: number): string {
  return Math.abs(value) >= 100_000 ? inr0.format(value) : inr2.format(value);
}

/** Compact crore/lakh for market-scale values: ₹1.24 Cr, ₹3.5 L. */
export function inrCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${plain(abs / 1e7, 2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${plain(abs / 1e5, 2)} L`;
  return inr0.format(value);
}

/** Short milestone label: ₹1K, ₹5K, ₹50K, ₹1L. */
export function inrShort(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e5) return `₹${plain(value / 1e5, abs % 1e5 ? 1 : 0)}L`;
  if (abs >= 1e3) return `₹${plain(value / 1e3, abs % 1e3 ? 1 : 0)}K`;
  return inr0.format(value);
}

/** Signed rupee amount, e.g. +₹1,254 / -₹320.50 */
export function signedInr(value: number): string {
  return `${value >= 0 ? '+' : '-'}${inrSmart(Math.abs(value))}`;
}

/** Plain en-IN number. */
export function plain(value: number, maxDecimals = 2): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxDecimals }).format(value);
}

/** Compact en-IN count (volumes): 1.2Cr, 45.3L, 12K. */
export function compactCount(value: number): string {
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Percentages are always signed: +1.80% / -2.30% */
export function signedPct(value: number, decimals = 2): string {
  return `${value >= 0 ? '+' : '-'}${plain(Math.abs(value), decimals)}%`;
}

/** Unsigned percent, e.g. 61.5% */
export function pct(value: number, decimals = 1): string {
  return `${plain(value, decimals)}%`;
}

/** Tailwind text class by sign — emerald gains, rose losses. */
export function signClass(value: number): string {
  if (value > 0) return 'text-emerald-400';
  if (value < 0) return 'text-rose-400';
  return 'text-slate-400';
}

/** 30 Aug 2026 */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** 30 Aug (chart axes) */
export function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** 30 Aug 2026, 10:15 am */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
