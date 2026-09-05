'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarClock, Lock } from 'lucide-react';
import { ApiError, getForecastLocks } from '@/lib/api';
import type { ForecastLockRow, ForecastLockVerdict, LockedForecastHorizon } from '@/lib/types';
import { fmtDate, inr, plain, signedInr, signedPct } from '@/lib/format';
import { Card, CardSkeleton, Chip, Collapsible, EmptyState, ErrorState } from '@/components/ui';
import { signTone } from './desk-ui';

/**
 * Horizontal band visual for one locked horizon: a track spanning
 * lowPrice→highPrice with a tick at expectedPrice and a live-price marker.
 * The rail's domain stretches to include the live price so an out-of-band
 * price visibly sits OUTSIDE the frozen band instead of clamping onto it.
 * Marker tone: buy when live ≥ the lock's anchor close, sell otherwise —
 * always paired with the printed numbers below (never color alone).
 */
function LockedBandRail({
  h,
  baseClose,
  livePrice,
  horizonLabel,
}: {
  h: LockedForecastHorizon;
  baseClose: number;
  livePrice: number | null;
  horizonLabel: string;
}) {
  const lo = Math.min(h.lowPrice, livePrice ?? h.lowPrice);
  const hi = Math.max(h.highPrice, livePrice ?? h.highPrice);
  const span = hi - lo;
  // Degenerate lock (low == high == live) — print the numbers, skip the rail.
  if (!(span > 0)) {
    return (
      <p className="text-xs text-slate-400 tabular-nums">
        {horizonLabel} locked band {inr(h.lowPrice)} – {inr(h.highPrice)} · expected {inr(h.expectedPrice)}
      </p>
    );
  }
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const bandLeft = pos(h.lowPrice);
  const bandWidth = Math.max(pos(h.highPrice) - bandLeft, 0.5);
  const liveUp = livePrice != null && livePrice >= baseClose;

  return (
    <div
      role="img"
      aria-label={`${horizonLabel} locked forecast band: low ${inr(h.lowPrice)}, expected ${inr(h.expectedPrice)}, high ${inr(h.highPrice)}${
        livePrice != null ? `; live price ${inr(livePrice)} (${liveUp ? 'at or above' : 'below'} the anchor close ${inr(baseClose)})` : ''
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">{horizonLabel} locked band</p>
        <p className="text-[11px] text-slate-500 tabular-nums">anchor close {inr(baseClose)}</p>
      </div>
      <div className="relative mt-2 h-6">
        {/* full rail (domain includes an out-of-band live price) */}
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/5" />
        {/* the frozen 80% band */}
        <div
          aria-hidden
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full border border-white/10 bg-gradient-to-r from-sell/25 via-amber-400/15 to-buy/25"
          style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
        />
        {/* expected-price tick */}
        <span
          aria-hidden
          className="absolute top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300 shadow-[0_0_6px_rgba(34,211,238,0.6)]"
          style={{ left: `${pos(h.expectedPrice)}%` }}
        />
        {/* live-price marker */}
        {livePrice != null && (
          <span
            aria-hidden
            className={clsx(
              'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0A0A0F]',
              liveUp ? 'bg-buy shadow-[0_0_10px_rgba(0,212,170,0.6)]' : 'bg-sell shadow-[0_0_10px_rgba(255,77,109,0.6)]',
            )}
            style={{ left: `${pos(livePrice)}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] tabular-nums">
        <span className="text-slate-400">
          {inr(h.lowPrice)} <span className="text-slate-600">low</span>
        </span>
        <span className="text-cyan-300">
          {inr(h.expectedPrice)} <span className="text-cyan-300/60">expected</span>
        </span>
        <span className="text-slate-400">
          <span className="text-slate-600">high</span> {inr(h.highPrice)}
        </span>
      </div>
    </div>
  );
}

/** Verdict chips for one matured horizon — within-band + direction, then the real numbers. */
function VerdictLine({ label, verdict }: { label: string; verdict: ForecastLockVerdict }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <Chip tone="zinc" className="px-2 py-0.5 text-[10px]">
        {label}
      </Chip>
      <Chip tone={verdict.withinBand ? 'buy' : 'sell'} glow className="px-2 py-0.5 text-[10px]">
        {verdict.withinBand ? 'WITHIN BAND' : 'OUTSIDE BAND'}
      </Chip>
      <Chip tone={verdict.directionHit ? 'buy' : 'sell'} className="px-2 py-0.5 text-[10px]">
        {verdict.directionHit ? 'DIRECTION HIT' : 'DIRECTION MISS'}
      </Chip>
      <span className="text-xs text-slate-400 tabular-nums">
        actual {inr(verdict.actualPrice)} on {fmtDate(verdict.actualDate)}, error ±{plain(verdict.errorPct, 2)} pp
      </span>
    </div>
  );
}

function LockRowItem({ row }: { row: ForecastLockRow }) {
  const lock = row.lock;
  // The 30d band is the headline visual; fall back to 7d if a lock has only h7.
  const bandHorizon = lock?.h30 ?? lock?.h7 ?? null;
  const bandLabel = lock?.h30 ? '30d' : '7d';
  const horizonDays = lock?.h30 ? 30 : 7;
  const livePrice = row.live?.price ?? null;
  const vsBase = row.live?.vsBaseClosePct ?? null;
  const pnl = row.live?.positionPnl ?? null;
  const matured = row.status === 'MATURED';
  const dayN = Math.min(row.daysElapsed ?? 0, horizonDays);

  return (
    <li className="glass-inset p-4">
      {/* identity + status chips */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-display text-sm font-semibold tracking-wide text-slate-100">{row.ticker}</span>
        {row.name && <span className="min-w-0 truncate text-xs text-slate-500">{row.name}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <Chip tone="zinc" className="px-2 py-0.5 text-[10px]">
            qty {plain(row.qty, 0)}
          </Chip>
          <Chip tone="zinc" className="px-2 py-0.5 text-[10px]">
            buy {fmtDate(row.buyDate)} @ {inr(row.buyPrice)}
          </Chip>
          {row.tradeStatus === 'CLOSED' && (
            <Chip tone="zinc" className="px-2 py-0.5 text-[10px]">
              CLOSED
            </Chip>
          )}
          {matured && (
            <Chip tone="wait" glow className="px-2 py-0.5 text-[10px]">
              MATURED
            </Chip>
          )}
        </span>
      </div>

      {/* the frozen band vs the live price */}
      {bandHorizon && (
        <div className="mt-3">
          <LockedBandRail h={bandHorizon} baseClose={lock.baseClose} livePrice={livePrice} horizonLabel={bandLabel} />
        </div>
      )}

      {/* live tracking numbers + progress */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        {livePrice != null ? (
          <span className="text-slate-300 tabular-nums">
            live <span className="font-semibold text-slate-100">{inr(livePrice)}</span>
            {vsBase != null && (
              <>
                {' '}
                <span className={signTone(vsBase)}>({signedPct(vsBase)} vs anchor close)</span>
              </>
            )}
          </span>
        ) : (
          <span className="text-slate-500">live price unavailable</span>
        )}
        {pnl != null && (
          <span className="text-slate-300 tabular-nums">
            position P&L <span className={clsx('font-semibold', signTone(pnl))}>{signedInr(pnl)}</span>
          </span>
        )}
        {!matured && bandHorizon && (
          <span className="flex items-center gap-1.5 text-slate-500 tabular-nums">
            <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            day {plain(dayN, 0)} of {horizonDays} · target {fmtDate(bandHorizon.targetDate)}
          </span>
        )}
      </div>

      {/* reality's grades once a horizon matures */}
      {(row.verdict7 || row.verdict30) && (
        <div className="mt-3 space-y-1.5 border-t border-white/6 pt-3">
          {row.verdict7 && <VerdictLine label="7d" verdict={row.verdict7} />}
          {row.verdict30 && <VerdictLine label="30d" verdict={row.verdict30} />}
        </div>
      )}
    </li>
  );
}

/**
 * Forecast Lock — every desk BUY freezes that day's 7d/30d forecast into the
 * trade; this card tracks live price against the frozen band and shows
 * reality's grade once a horizon matures. Locks are NEVER recomputed. Hides
 * itself entirely on an older backend (404 on /api/admin/forecast-locks).
 */
export function ForecastLockCard() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'forecast-locks'],
    queryFn: getForecastLocks,
    staleTime: 30_000,
    refetchInterval: 60_000, // keep the live-price marker honest
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  // Older backend without the forecast-lock endpoint — hide the card entirely.
  if (isError && error instanceof ApiError && error.status === 404) return null;
  if (isPending) return <CardSkeleton lines={4} />;

  if (isError || !data) {
    return (
      <Card className="p-5">
        <ErrorState
          compact
          message={error instanceof Error ? error.message : 'Could not load the locked forecasts.'}
          onRetry={() => refetch()}
        />
      </Card>
    );
  }

  const rows = data.rows ?? [];

  return (
    <Card className="p-5">
      <Collapsible
        id="desk.forecastLock"
        defaultOpen
        title={
          <span className="flex items-center gap-2">
            <Lock className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
            Forecast Lock — purchase-day predictions vs reality
          </span>
        }
        subtitle="frozen at BUY, tracked against the live price, graded on the real close at the target date"
        right={
          rows.length > 0 ? (
            <Chip tone="zinc">
              {plain(rows.length, 0)} lock{rows.length === 1 ? '' : 's'}
            </Chip>
          ) : undefined
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            glyph="radar"
            title="No locked forecasts yet"
            message="Every BUY you record freezes that day's 7d/30d forecast here, so reality can grade the model."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <LockRowItem key={row.tradeId} row={row} />
            ))}
          </ul>
        )}
      </Collapsible>

      {/* REQUIRED honesty — locks are never recomputed; verdicts use real closes. Always visible. */}
      <p className="mt-4 flex items-start gap-2 border-t border-white/6 pt-3 text-xs leading-relaxed text-slate-500">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {data.note ||
          'Each forecast was frozen the moment you bought and is never recomputed — verdicts use the real close on the target date, separately from your position P&L.'}
      </p>
    </Card>
  );
}
