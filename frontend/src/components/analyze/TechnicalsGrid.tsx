'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import type { Quote, Technicals } from '@/lib/types';
import { inr, plain, signedPct } from '@/lib/format';
import { Card, SectionTitle } from '@/components/ui';
import { signTone } from './tone';
import { useMountSweep } from './anim';

function Tile({ label, value, sub, subClass }: { label: string; value: ReactNode; sub?: ReactNode; subClass?: string }) {
  return (
    <div className="glass-inset p-3.5">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="font-display mt-1 text-lg font-semibold tracking-tight text-slate-100 tabular-nums">{value}</p>
      {sub != null && <p className={clsx('mt-0.5 text-xs text-slate-500', subClass)}>{sub}</p>}
    </div>
  );
}

function smaTile(label: string, sma: number | null, price: number) {
  if (sma == null) return <Tile label={label} value="—" sub="not enough history" />;
  const diffPct = ((price - sma) / sma) * 100;
  return (
    <Tile
      label={label}
      value={inr(sma)}
      sub={`price ${signedPct(diffPct, 1)} vs ${label}`}
      subClass={signTone(diffPct)}
    />
  );
}

export function TechnicalsGrid({ technicals, quote }: { technicals: Technicals; quote: Quote }) {
  const t = technicals;
  const week52Sweep = useMountSweep(t.week52 ? Math.max(0, Math.min(100, t.week52.positionPct)) / 100 : 0);

  const rsiZone =
    t.rsi14 == null
      ? undefined
      : t.rsi14 >= 70
        ? 'overbought'
        : t.rsi14 <= 30
          ? 'oversold'
          : t.rsi14 >= 55
            ? 'bullish momentum'
            : t.rsi14 <= 45
              ? 'weak momentum'
              : 'neutral zone';
  const rsiClass =
    t.rsi14 == null
      ? undefined
      : t.rsi14 >= 70
        ? 'text-sell'
        : t.rsi14 <= 30
          ? 'text-amber-400'
          : t.rsi14 >= 55
            ? 'text-buy'
            : undefined;

  return (
    <Card className="p-5">
      <SectionTitle>Technicals</SectionTitle>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        <Tile label="RSI (14)" value={t.rsi14 != null ? plain(t.rsi14, 1) : '—'} sub={rsiZone} subClass={rsiClass} />

        <Tile
          label="MACD histogram"
          value={
            t.macd ? (
              <span className={signTone(t.macd.histogram)}>{`${t.macd.histogram >= 0 ? '+' : ''}${plain(t.macd.histogram, 2)}`}</span>
            ) : (
              '—'
            )
          }
          sub={t.macd ? `line ${plain(t.macd.line, 2)} · signal ${plain(t.macd.signal, 2)}` : undefined}
        />

        {smaTile('SMA 20', t.sma20, quote.price)}
        {smaTile('SMA 50', t.sma50, quote.price)}
        {smaTile('SMA 200', t.sma200, quote.price)}

        <Tile
          label="Bollinger %B"
          value={t.bollinger ? plain(t.bollinger.percentB, 2) : '—'}
          sub={t.bollinger ? `${inr(t.bollinger.lower)} – ${inr(t.bollinger.upper)}` : undefined}
        />

        <Tile label="ATR (14)" value={t.atr14 != null ? inr(t.atr14) : '—'} sub="average true range" />

        <Tile
          label="Annualised volatility"
          value={t.annualVolatilityPct != null ? `${plain(t.annualVolatilityPct, 1)}%` : '—'}
          sub={
            t.annualVolatilityPct != null
              ? t.annualVolatilityPct > 35
                ? 'high'
                : t.annualVolatilityPct >= 20
                  ? 'moderate'
                  : 'low'
              : undefined
          }
        />

        <div className="glass-inset p-3.5">
          <p className="text-xs text-slate-400">52-week position</p>
          {t.week52 ? (
            <>
              <p className="mt-1 text-lg font-semibold text-slate-100 tabular-nums">{plain(t.week52.positionPct, 0)}%</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                <div
                  className="meter-fill h-full w-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-400"
                  style={{ transform: `scaleX(${week52Sweep})` }}
                />
              </div>
              <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
                <span>{inr(t.week52.low, 0)}</span>
                <span>{inr(t.week52.high, 0)}</span>
              </div>
            </>
          ) : (
            <p className="mt-1 text-lg font-semibold text-slate-100">—</p>
          )}
        </div>

        <Tile
          label="Volume vs 20-day avg"
          value={t.volumeRatio20d != null ? `${plain(t.volumeRatio20d, 2)}×` : '—'}
          sub={
            t.volumeRatio20d != null
              ? t.volumeRatio20d >= 1.5
                ? 'unusually heavy'
                : t.volumeRatio20d <= 0.5
                  ? 'unusually light'
                  : 'normal'
              : undefined
          }
        />

        <div className="col-span-2 glass-inset p-3.5 md:col-span-1">
          <p className="text-xs text-slate-400">Returns</p>
          <div className="mt-1 flex gap-5">
            {(
              [
                ['5d', t.returns.r5dPct],
                ['20d', t.returns.r20dPct],
                ['60d', t.returns.r60dPct],
              ] as Array<[string, number | null]>
            ).map(([label, v]) => (
              <div key={label}>
                <p className={clsx('text-lg font-semibold tabular-nums', v != null ? signTone(v) : 'text-slate-100')}>
                  {v != null ? signedPct(v, 1) : '—'}
                </p>
                <p className="text-[11px] text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
