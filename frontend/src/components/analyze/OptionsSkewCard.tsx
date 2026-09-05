'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Radar } from 'lucide-react';
import { ApiError, getOptionsSkew } from '@/lib/api';
import { fmtDateTime, plain, signedPct } from '@/lib/format';
import { Card, Chip, InfoTip, SectionTitle } from '@/components/ui';

const PCR_TIP =
  'Put–call ratio = total put open interest ÷ total call open interest on the nearest expiry. Above 1 the crowd holds more puts (hedging/fear); a spike vs its own 5-day average is the signal, not the level alone.';

const SKEW_TIP =
  'IV skew = mean implied volatility of ~5% OTM puts minus OTM calls. Positive skew means downside protection is being bid up relative to upside bets.';

/**
 * Diverging PCR meter on 0..2+: cyan pole (call-tilt) → neutral 1.0 hairline →
 * rose pole (put-tilt). Needle = current PCR; thin slate tick = 5d average.
 * Values are always printed as text — color never carries the number alone.
 */
function PcrGauge({ pcr, avg }: { pcr: number; avg: number | null }) {
  const pos = Math.max(0, Math.min(100, (pcr / 2) * 100));
  const avgPos = avg != null ? Math.max(0, Math.min(100, (avg / 2) * 100)) : null;
  return (
    <div aria-label={`Put–call ratio ${plain(pcr, 2)}${avg != null ? `, 5-day average ${plain(avg, 2)}` : ''}`}>
      <div className="relative mt-4">
        <div className="h-2 rounded-full bg-gradient-to-r from-cyan-500/45 via-slate-500/25 to-rose-500/45" />
        {/* neutral 1.0 hairline */}
        <div aria-hidden className="absolute top-1/2 left-1/2 h-3.5 w-px -translate-x-1/2 -translate-y-1/2 bg-white/35" />
        {/* 5d average tick */}
        {avgPos != null && (
          <div
            aria-hidden
            title={`5d avg ${plain(avg as number, 2)}`}
            className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-400"
            style={{ left: `${avgPos}%` }}
          />
        )}
        {/* current PCR needle */}
        <div
          aria-hidden
          className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-100 shadow-[0_0_8px_rgba(241,245,249,0.5)]"
          style={{ left: `${pos}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-slate-500">
        <span>0 · call-tilt</span>
        <span>1.0 balanced</span>
        <span>≥2 · put-tilt</span>
      </div>
    </div>
  );
}

/**
 * V8 R3 — NSE option-chain radar (top-30 tickers, probe-first). ENTIRELY
 * hidden when the endpoint 404s, errors, or reports status NOT_AVAILABLE —
 * per spec, no placeholder and nothing fabricated when the source is blocked.
 */
export function OptionsSkewCard({ ticker }: { ticker: string }) {
  const { data, isError } = useQuery({
    queryKey: ['options-skew', ticker],
    queryFn: () => getOptionsSkew(ticker),
    staleTime: 5 * 60_000,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  if (isError || !data) return null; // pending, 404, blocked or failed — no widget
  if (data.status !== 'ok') return null; // NOT_AVAILABLE (probe evidence lives in the API payload)
  if (data.pcr == null && data.ivSkewPct == null) return null;

  const spiking = data.signal === 'HEDGING_SPIKE';

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>Options radar — PCR &amp; IV skew</span>
            <InfoTip label="What does the options radar measure?" text={PCR_TIP} />
          </span>
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          {data.signal && (
            <Chip tone={spiking ? 'rose' : 'zinc'} glow={spiking} title={spiking ? 'PCR > 1.2 and > 1.5× its own 5d average' : undefined}>
              <Radar className="h-3.5 w-3.5" aria-hidden />
              {spiking ? 'HEDGING SPIKE' : 'NEUTRAL'}
            </Chip>
          )}
          {data.expiry && <Chip tone="zinc">expiry {data.expiry}</Chip>}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-5 sm:grid-cols-[1fr_200px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="font-display text-3xl font-semibold tracking-tight text-slate-100 tabular-nums">
              {data.pcr != null ? plain(data.pcr, 2) : '—'}
              <span className="ml-2 text-sm font-medium text-slate-500">put–call ratio (OI)</span>
            </p>
            {data.pcr5dAvg != null && (
              <p className="text-xs text-slate-500 tabular-nums">5d avg {plain(data.pcr5dAvg, 2)}</p>
            )}
          </div>
          {data.pcr != null && <PcrGauge pcr={data.pcr} avg={data.pcr5dAvg} />}
        </div>

        <div className="glass-inset h-fit p-4">
          <p className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            <span>IV skew (puts − calls)</span>
            <InfoTip label="What is IV skew?" text={SKEW_TIP} align="right" />
          </p>
          <p
            className={clsx(
              'font-display mt-1.5 text-2xl font-semibold tracking-tight tabular-nums',
              data.ivSkewPct == null
                ? 'text-slate-500'
                : data.ivSkewPct > 0
                  ? 'text-amber-400'
                  : 'text-slate-100',
            )}
          >
            {data.ivSkewPct != null ? signedPct(data.ivSkewPct, 1) : '—'}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            {data.ivSkewPct == null
              ? 'skew unavailable on this chain'
              : data.ivSkewPct > 0
                ? 'downside protection priced above upside'
                : 'no put-side premium vs calls'}
          </p>
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        {data.note || 'Positioning context from NSE option-chain open interest — not a direction forecast.'}
        {data.asOf ? ` As of ${fmtDateTime(data.asOf)}.` : ''}
      </p>
    </Card>
  );
}
