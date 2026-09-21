/**
 * Live session monitor — the instrument for verifying the Upstox feed under
 * real load (docs/live-feed-runbook.md).
 *
 * A single /api/live/status call cannot tell you whether the feed DEGRADES:
 * whether coverage decays after twenty minutes, whether the validator starts
 * rejecting ticks mid-session, whether securities go silent one by one. This
 * polls the running server at a fixed interval and appends one JSONL row per
 * sample, so the session can be read back afterwards as a time series.
 *
 * It is a READ-ONLY observer: it polls public status endpoints and writes a
 * log file. It never starts, stops or mutates the feed, and it is not part of
 * the product surface.
 *
 * Usage (backend must already be running and the feed started):
 *   npx ts-node --transpile-only scripts/liveSessionMonitor.ts [minutes] [intervalSeconds]
 *
 * Defaults: run until 15:30 IST, sampling every 60s.
 * Output:   docs/live-sessions/<IST date>.jsonl  (+ a summary on exit)
 */

import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import axios from "axios";

const BASE = process.env.LIVE_MONITOR_BASE ?? "http://localhost:5101";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface Sample {
  at: string;
  istTime: string;
  running: boolean;
  providerState: string | null;
  providerReason: string | null;
  subscribed: number;
  securitiesWithData: number;
  coveragePct: number | null;
  ticksAccepted: number;
  ticksRejected: number;
  /** Ticks accepted since the previous sample — the real liveness signal. */
  ticksDelta: number | null;
  tokenState: string;
  /** Currently receiving data, vs securitiesWithData ("ever received"). */
  securitiesLive: number;
  /** Ms since ANY frame arrived — the signal the 2026-09-21 outage lacked. */
  silentForMs: number | null;
  reconnects: number;
  freshRows: number | null;
  staleRows: number | null;
  silentRows: number | null;
  error?: string;
}

function istParts(ms: number): { date: string; time: string } {
  const d = new Date(ms + IST_OFFSET_MS);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

async function sample(prevAccepted: number | null): Promise<Sample> {
  const now = Date.now();
  const { time } = istParts(now);
  const base: Sample = {
    at: new Date(now).toISOString(),
    istTime: time,
    running: false,
    providerState: null,
    providerReason: null,
    subscribed: 0,
    securitiesWithData: 0,
    securitiesLive: 0,
    silentForMs: null,
    reconnects: 0,
    coveragePct: null,
    ticksAccepted: 0,
    ticksRejected: 0,
    ticksDelta: null,
    tokenState: "UNKNOWN",
    freshRows: null,
    staleRows: null,
    silentRows: null,
  };

  try {
    const status = (await axios.get(`${BASE}/api/live/status`, { timeout: 10_000 })).data?.data;
    base.running = !!status?.running;
    base.providerState = status?.health?.state ?? null;
    base.providerReason = status?.health?.reason ?? null;
    base.subscribed = Number(status?.subscribed ?? 0);
    base.securitiesWithData = Number(status?.securitiesWithData ?? 0);
    base.securitiesLive = Number(status?.securitiesLive ?? 0);
    base.silentForMs = status?.link?.silentForMs ?? null;
    base.reconnects = Number(status?.link?.reconnects ?? 0);
    base.ticksAccepted = Number(status?.ticksAccepted ?? 0);
    base.ticksRejected = Number(status?.ticksRejected ?? 0);
    base.tokenState = String(status?.tokenState ?? "UNKNOWN");
    base.coveragePct = base.subscribed > 0 ? Math.round((base.securitiesWithData / base.subscribed) * 1000) / 10 : null;
    base.ticksDelta = prevAccepted == null ? null : base.ticksAccepted - prevAccepted;

    if (base.running) {
      const rows = (await axios.get(`${BASE}/api/live/rows`, { timeout: 20_000 })).data?.data?.rows ?? [];
      base.freshRows = rows.filter((r: { freshness: string }) => r.freshness === "FRESH").length;
      base.staleRows = rows.filter((r: { freshness: string }) => r.freshness === "STALE").length;
      base.silentRows = rows.filter((r: { price: number | null }) => r.price == null).length;
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
  }
  return base;
}

async function main(): Promise<void> {
  const minutesArg = Number(process.argv[2]);
  const intervalSec = Number(process.argv[3]) || 60;

  const outDir = path.join(__dirname, "..", "docs", "live-sessions");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${istParts(Date.now()).date}.jsonl`);

  // Default: run until 15:30 IST.
  let deadline: number;
  if (Number.isFinite(minutesArg) && minutesArg > 0) {
    deadline = Date.now() + minutesArg * 60_000;
  } else {
    const ist = new Date(Date.now() + IST_OFFSET_MS);
    deadline = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 15, 30) - IST_OFFSET_MS;
    if (deadline <= Date.now()) deadline = Date.now() + 10 * 60_000; // already past close: short run
  }

  console.log(`monitoring ${BASE} every ${intervalSec}s until ${istParts(deadline).time} IST`);
  console.log(`writing ${outFile}`);
  console.log("time      run  state        cover   ticks(+delta)  rej  fresh/stale/silent");

  const samples: Sample[] = [];
  let prevAccepted: number | null = null;

  while (Date.now() < deadline) {
    const s = await sample(prevAccepted);
    prevAccepted = s.ticksAccepted;
    samples.push(s);
    appendFileSync(outFile, JSON.stringify(s) + "\n");

    console.log(
      `${s.istTime}  ${s.running ? "yes" : "no "}  ${String(s.providerState ?? "-").padEnd(12)} ` +
        `${String(s.coveragePct ?? "-").padStart(5)}% live:${String(s.securitiesLive).padStart(3)}  ` +
        `${s.silentForMs != null ? `silent:${Math.round(s.silentForMs / 1000)}s` : "silent:-"}  ` +
        `${String(s.ticksAccepted).padStart(7)}` +
        `${s.ticksDelta != null ? `(+${s.ticksDelta})`.padStart(8) : "".padStart(8)}  ` +
        `${String(s.ticksRejected).padStart(4)}  ${s.freshRows ?? "-"}/${s.staleRows ?? "-"}/${s.silentRows ?? "-"}` +
        (s.error ? `  ERROR ${s.error}` : "")
    );

    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }

  // ── Summary: the questions the session is meant to answer ────────────────
  const live = samples.filter((s) => s.running && !s.error);
  const deltas = live.map((s) => s.ticksDelta).filter((d): d is number => d != null);
  const coverages = live.map((s) => s.coveragePct).filter((c): c is number => c != null);
  const stalled = deltas.filter((d) => d === 0).length;

  console.log("\n── session summary ─────────────────────────────────────────");
  console.log(`samples:            ${samples.length} (${live.length} with the feed running)`);
  console.log(`errors:             ${samples.filter((s) => s.error).length}`);
  if (coverages.length) {
    console.log(`coverage:           min ${Math.min(...coverages)}%  max ${Math.max(...coverages)}%  last ${coverages[coverages.length - 1]}%`);
  }
  if (deltas.length) {
    const total = live.length ? live[live.length - 1].ticksAccepted : 0;
    console.log(`ticks accepted:     ${total} total`);
    console.log(`ticks rejected:     ${live.length ? live[live.length - 1].ticksRejected : 0}`);
    console.log(`stalled intervals:  ${stalled}/${deltas.length} samples saw ZERO new ticks`);
  }
  console.log(`log: ${outFile}`);
  console.log(
    "\nRead this against the runbook's pass criteria — coverage should climb and hold,\n" +
      "ticksDelta should stay > 0 through the session, and rejections should stay near zero.\n" +
      "Anything else is a finding to write up, not a number to explain away."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
