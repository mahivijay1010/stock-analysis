/**
 * Sign → semantic accent-token text class (design-system sheet: buy/sell are
 * STATUS colors for signed values, migrated from format.ts's emerald/rose
 * signClass as views are touched). Values are ALWAYS printed as signed text —
 * color never carries the number alone.
 */
export function signTone(value: number): string {
  if (value > 0) return 'text-buy';
  if (value < 0) return 'text-sell';
  return 'text-slate-400';
}
