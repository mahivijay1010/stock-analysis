'use client';

import clsx from 'clsx';
import { Activity, Building2, Clock3 } from 'lucide-react';
import type { AnalyzeResponse } from '@/lib/types';
import { compactCount, fmtDateTime, inr, pct, plain, signedInr, signedPct } from '@/lib/format';
import { Card, Chip, DataStatusChip } from '@/components/ui';
import { CountUp } from '@/components/motion';

function readFundamental(data: AnalyzeResponse, key: string): number | null {
  const fundamentals = (data as unknown as Record<string, unknown>).fundamentals;
  if (!fundamentals || typeof fundamentals !== 'object') return null;
  const value = (fundamentals as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function CompanyMonogram({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return <span className="stock-monogram">{letters || <Building2 className="h-5 w-5" aria-hidden />}</span>;
}

function CompactStat({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="stock-compact-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {children}
    </div>
  );
}

function MarketPulse({ bars }: { bars: AnalyzeResponse['chart']['bars'] }) {
  const sample = bars.slice(-36);
  if (sample.length < 2) return null;

  const closes = sample.map((bar) => bar.close);
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const spread = high - low || 1;
  const width = 196;
  const height = 50;
  const points = closes.map((close, index) => {
    const x = (index / (closes.length - 1)) * width;
    const y = height - 4 - ((close - low) / spread) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M ${points.join(' L ')}`;
  const area = `${path} L ${width},${height} L 0,${height} Z`;
  const first = closes[0];
  const latest = closes[closes.length - 1];
  const change = first === 0 ? 0 : ((latest - first) / first) * 100;
  const lastPoint = points[points.length - 1].split(',').map(Number);

  return (
    <div className="market-pulse" aria-hidden>
      <div className="market-pulse-head">
        <span><Activity /> Market pulse</span>
        <strong className={change >= 0 ? 'text-buy' : 'text-sell'}>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="market-pulse-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={change >= 0 ? '#58d6ad' : '#ef7890'} stopOpacity="0.24" />
            <stop offset="100%" stopColor={change >= 0 ? '#58d6ad' : '#ef7890'} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="market-pulse-area" d={area} />
        <path className={clsx('market-pulse-line', change >= 0 ? 'market-pulse-up' : 'market-pulse-down')} d={path} pathLength="1" />
        <circle className={clsx('market-pulse-point', change >= 0 ? 'market-pulse-point-up' : 'market-pulse-point-down')} cx={lastPoint[0]} cy={lastPoint[1]} r="3" />
      </svg>
    </div>
  );
}

export function StockHero({ data }: { data: AnalyzeResponse }) {
  const { quote } = data;
  const technicals = data.analysis.technicals;
  const isUp = quote.change >= 0;
  const trailingPE = readFundamental(data, 'trailingPE');
  const roePct = readFundamental(data, 'returnOnEquityPct');

  return (
    <div className="stock-3d-shell">
      <Card className="stock-identity-card overflow-hidden">
      <div className="stock-identity-main">
        <div className="flex min-w-0 items-center gap-3.5">
          <CompanyMonogram name={data.name} />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[clamp(1.35rem,2.2vw,1.8rem)] leading-tight font-semibold tracking-[-0.035em] text-slate-50 sm:truncate">
              {data.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <Chip tone="zinc" className="px-2.5 py-0.5 text-[10px]">{data.ticker}</Chip>
              <Chip tone="cyan" className="px-2.5 py-0.5 text-[10px]">{data.exchange}</Chip>
              <DataStatusChip status={data.dataStatus} />
              <Clock3 className="ml-1 h-3.5 w-3.5" aria-hidden />
              <span>Updated {fmtDateTime(quote.asOf)}</span>
            </div>
          </div>
        </div>

        <MarketPulse bars={data.chart.bars} />

        <div className="stock-price-block">
          <p className="font-display text-[clamp(2rem,3.3vw,3.15rem)] leading-none font-semibold tracking-[-0.045em] text-white tabular-nums">
            <CountUp value={quote.price} format={inr} />
          </p>
          <span className={clsx('stock-change-pill', isUp ? 'stock-change-up' : 'stock-change-down')}>
            {signedInr(quote.change)} · {signedPct(quote.changePercent)}
          </span>
        </div>
      </div>

      <div className="stock-stats-row">
        <CompactStat label="Trailing P/E" value={trailingPE != null ? plain(trailingPE, 1) : '—'} />
        <CompactStat label="ROE" value={roePct != null ? pct(roePct, 1) : '—'} />
        <CompactStat label="52-week range" value={technicals.week52 ? `${Math.round(technicals.week52.positionPct)}%` : '—'}>
          {technicals.week52 && (
            <span className="stock-range-track" aria-label={`${Math.round(technicals.week52.positionPct)} percent through 52-week range`}>
              <i style={{ width: `${Math.min(100, Math.max(0, technicals.week52.positionPct))}%` }} />
            </span>
          )}
        </CompactStat>
        <CompactStat label="Volume" value={quote.volume != null ? compactCount(quote.volume) : '—'} />
      </div>
      </Card>
    </div>
  );
}
