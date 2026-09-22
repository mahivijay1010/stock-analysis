'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, ExternalLink, Pause, Play, RefreshCw } from 'lucide-react';
import {
  getLiveRows,
  getLiveStatus,
  getUpstoxAuthStatus,
  isUnauthorized,
  startLiveFeed,
  stopLiveFeed,
} from '@/lib/api';
import type { LiveFeedRow, LiveFeedStatus, UpstoxAuthStatus } from '@/lib/types';
import { ForecastGrid } from '@/components/live/ForecastGrid';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5101';
const POLL_MS = 5000;

/**
 * Intraday monitoring surface (docs/intraday-study-notes.md §4 item 7).
 *
 * Deliberately a MONITORING tab, not a signal tab. It shows what the live feed
 * actually knows — price, session range, freshness, tick counts — and refuses
 * to imply more. Three honesty rules are load-bearing here:
 *
 *  1. The SEBI base rate is displayed permanently, not tucked away: 71% of
 *     individual intraday traders lost money in FY23, rising to 80% for those
 *     trading >500 times a year, and losers paid 57% of their losses again in
 *     costs. A surface that hides that is a tips channel.
 *  2. Every row carries its own freshness. A stale row is greyed and labelled,
 *     never shown as if it were current.
 *  3. No entry/exit calls appear here. The system's own out-of-sample study
 *     found 0/12 setups with a positive edge, so there is nothing honest to
 *     recommend — intraday signals must earn tier authority through the shadow
 *     pipeline first.
 */
export function LiveView() {
  const [status, setStatus] = useState<LiveFeedStatus | null>(null);
  const [rows, setRows] = useState<LiveFeedRow[]>([]);
  const [auth, setAuth] = useState<UpstoxAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([getUpstoxAuthStatus(), getLiveStatus()]);
      setAuth(a);
      setStatus(s);
      if (s.running) {
        const r = await getLiveRows();
        setRows(r.rows);
        setStatus(r.status);
      } else {
        setRows([]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the analysis server');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const onStart = async () => {
    setBusy(true);
    setError(null);
    setNeedsLogin(false);
    try {
      setStatus(await startLiveFeed());
      await refresh();
    } catch (err) {
      if (isUnauthorized(err)) setNeedsLogin(true);
      setError(err instanceof Error ? err.message : 'Could not start the feed');
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      setStatus(await stopLiveFeed());
      setRows([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop the feed');
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const withData = rows.filter((r) => r.price != null);
    const list = q ? withData.filter((r) => r.ticker.includes(q) || r.name.toUpperCase().includes(q)) : withData;
    return [...list].sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999));
  }, [rows, query]);

  const silent = rows.length - rows.filter((r) => r.price != null).length;
  const tokenValid = auth?.tokenState === 'VALID';

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-100">Live Market</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Real-time NSE ticks via Upstox. This is a <strong className="text-slate-300">monitoring</strong> surface —
            it reports what the feed knows and makes no entry or exit calls.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/5"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          {status?.running ? (
            <button
              onClick={() => void onStop()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500/15 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
            >
              <Pause className="h-3.5 w-3.5" /> Stop feed
            </button>
          ) : (
            <button
              onClick={() => void onStart()}
              disabled={busy || !tokenValid}
              title={tokenValid ? undefined : 'Authorize Upstox first'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" /> Start feed
            </button>
          )}
        </div>
      </header>

      {/* The base rate, always visible — never collapsed behind a tooltip. */}
      <section className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="space-y-1.5 text-sm">
            <p className="font-medium text-amber-200">Before you trade intraday, the measured base rate</p>
            <p className="text-slate-300">
              SEBI&apos;s FY2022-23 study of individual intraday equity traders:{' '}
              <strong className="text-amber-200">71% lost money</strong>; that rose to{' '}
              <strong className="text-amber-200">80%</strong> for traders placing more than 500 trades a year.
              Loss-makers spent a further <strong className="text-amber-200">57% of their losses</strong> on trading
              costs. This system&apos;s own out-of-sample study found{' '}
              <strong className="text-amber-200">0 of 12</strong> short-term setups with a positive edge.
            </p>
            <p className="text-xs text-slate-400">
              Frequency and costs are the strongest predictors of losing. Nothing on this screen is a recommendation.
            </p>
          </div>
        </div>
      </section>

      {/* Authorization + feed state. */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Upstox authorization"
          value={auth ? auth.tokenState : '—'}
          tone={tokenValid ? 'good' : 'warn'}
          sub={
            tokenValid && auth?.minutesRemaining != null
              ? `${Math.floor(auth.minutesRemaining / 60)}h ${auth.minutesRemaining % 60}m remaining`
              : auth?.reason
          }
        />
        <StatCard
          label="Feed"
          value={status?.running ? (status.health?.state ?? 'RUNNING') : 'STOPPED'}
          tone={status?.running && status.health?.state === 'CONNECTED' ? 'good' : status?.running ? 'warn' : 'muted'}
          sub={status?.running ? `${status.securitiesWithData}/${status.subscribed} securities with data` : 'not connected'}
        />
        <StatCard
          label="Data mode"
          value={status?.mode ?? 'STREAMING'}
          tone="good"
          sub={`ceiling ${status?.authorityCeiling ?? 'BUY_CANDIDATE'}`}
        />
        <StatCard
          label="Ticks"
          value={status ? status.ticksAccepted.toLocaleString('en-IN') : '0'}
          tone={status && status.ticksRejected > 0 ? 'warn' : 'muted'}
          sub={status && status.ticksRejected > 0 ? `${status.ticksRejected} rejected by the validator` : 'all accepted'}
        />
      </section>

      {!tokenValid && auth && (
        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm">
          <p className="text-slate-300">
            {auth.configured
              ? 'The Upstox token is not active. Tokens expire at 03:30 IST every day and cannot be refreshed automatically.'
              : `Upstox is not configured — missing ${auth.missing.join(', ')} in .env.`}
          </p>
          {auth.configured && (
            <a
              href={`${API_BASE}${auth.loginUrl}`}
              className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-300 hover:underline"
            >
              Authorize Upstox <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </section>
      )}

      {needsLogin && (
        <p className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-4 py-3 text-sm text-rose-200">
          Starting the feed requires a signed-in session. Sign in, then try again.
        </p>
      )}
      {error && !needsLogin && (
        <p className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-4 py-3 text-sm text-rose-200">{error}</p>
      )}

      {status?.unresolved && status.unresolved.length > 0 && (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
          {status.unresolved.length} ticker(s) could not be mapped to an Upstox instrument and are NOT subscribed:{' '}
          {status.unresolved.join(', ')}
        </p>
      )}

      {/* Rows */}
      {status?.running ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by ticker or name…"
              className="w-full max-w-xs rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-emerald-500/40 focus:outline-none"
            />
            <p className="text-xs text-slate-400">
              {filtered.length} with live data
              {silent > 0 && <span className="text-slate-500"> · {silent} subscribed but silent</span>}
            </p>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center">
              <Activity className="mx-auto h-6 w-6 text-slate-500" />
              <p className="mt-2 text-sm text-slate-400">
                No ticks yet. Outside 09:15–15:30 IST the feed stays quiet — that is the market being closed, not a
                fault.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[46rem] text-sm">
                <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-medium">Stock</th>
                    <th className="px-3 py-2.5 text-right font-medium">Price</th>
                    <th className="px-3 py-2.5 text-right font-medium">Change</th>
                    <th className="px-3 py-2.5 text-right font-medium">Session range</th>
                    <th className="px-3 py-2.5 text-right font-medium">Ticks</th>
                    <th className="px-3 py-2.5 text-left font-medium">Freshness</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {filtered.map((r) => (
                    <LiveRow key={r.instrumentKey} row={r} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-500">{status.note}</p>
        </section>
      ) : (
        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center">
          <Activity className="mx-auto h-6 w-6 text-slate-500" />
          <p className="mt-2 text-sm text-slate-400">
            The live feed is stopped. {tokenValid ? 'Start it to stream the universe.' : 'Authorize Upstox first.'}
          </p>
        </section>
      )}

      {/* Forecasts sit BELOW the observed tape, deliberately: what the market
          actually did outranks what a model guesses it will do next. */}
      <ForecastGrid />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone: 'good' | 'warn' | 'muted';
}) {
  const toneClass =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-slate-300';
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 font-display text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function LiveRow({ row }: { row: LiveFeedRow }) {
  const stale = row.freshness !== 'FRESH';
  const up = (row.changePct ?? 0) > 0;
  const down = (row.changePct ?? 0) < 0;
  // A stale row is dimmed so it can never be mistaken for a current price.
  const priceTone = stale ? 'text-slate-500' : up ? 'text-emerald-300' : down ? 'text-rose-300' : 'text-slate-200';
  const joinedMid = row.notes.some((n) => n.includes('NOT the exchange session values'));

  return (
    <tr className={stale ? 'opacity-60' : undefined}>
      <td className="px-3 py-2.5">
        <div className="font-medium text-slate-200">{row.ticker.replace('.NS', '')}</div>
        <div className="truncate text-xs text-slate-500">{row.name}</div>
      </td>
      <td className={`px-3 py-2.5 text-right tabular-nums ${priceTone}`}>
        {row.price != null ? `₹${row.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {row.changePct != null ? (
          <span className={up ? 'text-emerald-300' : down ? 'text-rose-300' : 'text-slate-400'}>
            {up ? '+' : ''}
            {row.changePct.toFixed(2)}%
          </span>
        ) : (
          <span className="text-slate-500" title="No exchange previous close available — withheld rather than derived">
            n/a
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-xs text-slate-400">
        {row.dayLow != null && row.dayHigh != null ? (
          <>
            {row.dayLow.toFixed(2)} – {row.dayHigh.toFixed(2)}
            {joinedMid && (
              <span className="ml-1 text-amber-400" title="We joined mid-session — these are our observed values, not the exchange session range">
                *
              </span>
            )}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-xs text-slate-400">
        {row.tickCount.toLocaleString('en-IN')}
        <span className="text-slate-600"> · {row.completedBars}m</span>
      </td>
      <td className="px-3 py-2.5">
        <span
          className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${
            row.freshness === 'FRESH'
              ? 'bg-emerald-500/15 text-emerald-300'
              : row.freshness === 'STALE'
                ? 'bg-amber-500/15 text-amber-300'
                : 'bg-slate-500/15 text-slate-400'
          }`}
        >
          {row.freshness}
        </span>
        {row.ageSeconds != null && row.ageSeconds > 5 && (
          <span className="ml-1.5 text-[11px] text-slate-500">{row.ageSeconds}s ago</span>
        )}
      </td>
    </tr>
  );
}
