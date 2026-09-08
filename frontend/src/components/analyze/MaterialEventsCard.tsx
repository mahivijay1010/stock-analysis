'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { getAiRoles, getStructuredEvents } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Card, Chip } from '@/components/ui';

/*
 * MATERIAL EVENTS (upgrade Part 17) — the structured, source-backed event
 * engine is the PRIMARY research surface; headline keyword sentiment stays
 * available below it as a secondary diagnostic. Each card shows provenance
 * (source + authority tier) and, when the Event Analyst has run, its validated
 * interpretation (materiality / direction / horizon / already-priced).
 */

const TIER_LABEL: Record<number, string> = {
  1: 'exchange filing',
  2: 'IR / exchange data',
  3: 'government',
  4: 'publication',
  5: 'other',
};

interface Interpretation {
  eventId: string;
  materiality: string;
  direction: string;
  timeHorizon: string;
  alreadyPricedProbability: number | null;
  explanation: string;
}

export function MaterialEventsCard({ ticker }: { ticker: string }) {
  const events = useQuery({
    queryKey: ['events', ticker],
    queryFn: () => getStructuredEvents(ticker),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const roles = useQuery({
    queryKey: ['ai-roles', ticker],
    queryFn: () => getAiRoles(ticker),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (events.isPending) return null;
  const rows = events.data?.events ?? [];
  const interp = new Map<string, Interpretation>();
  const eventRole = roles.data?.roles?.event_analyst?.response as
    | { interpretations?: Interpretation[] }
    | undefined;
  for (const it of eventRole?.interpretations ?? []) interp.set(it.eventId.replace(/^evt:/, ''), it);

  return (
    <Card className="p-4">
      <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <CalendarClock className="h-4 w-4 text-cyan-300" aria-hidden /> Material events
        <span className="text-[10px] text-slate-600">
          point-in-time, source-backed (tiers 1–5) — keyword news sentiment is secondary to this
        </span>
      </p>

      {rows.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          No structured events recorded for this instrument yet — event ingestion runs with the nightly decision
          publish. Absence of events is stated, never padded.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.slice(0, 8).map((e) => {
            const it = interp.get(e.id);
            return (
              <li key={e.id} className="glass-inset px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone="zinc">{e.eventType.replace(/_/g, ' ')}</Chip>
                  <span className="text-[11px] text-slate-500 tabular-nums">{e.eventDate}</span>
                  <span className="text-[10px] text-slate-600">
                    {e.source} · tier {e.sourceTier} ({TIER_LABEL[e.sourceTier] ?? 'other'}) · known since{' '}
                    {fmtDateTime(e.announcedAt)}
                  </span>
                  {it && (
                    <>
                      <Chip tone={it.direction === 'POSITIVE' ? 'buy' : it.direction === 'NEGATIVE' ? 'sell' : 'zinc'}>
                        {it.direction.toLowerCase()}
                      </Chip>
                      <Chip tone={it.materiality === 'HIGH' ? 'amber' : 'zinc'}>materiality {it.materiality.toLowerCase()}</Chip>
                      {it.alreadyPricedProbability != null && (
                        <span className="text-[10px] text-slate-500">
                          ~{Math.round(it.alreadyPricedProbability * 100)}% already priced (AI estimate)
                        </span>
                      )}
                    </>
                  )}
                </div>
                {e.headline && <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{e.headline}</p>}
                {it?.explanation && (
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    <span className="text-slate-600">AI interpretation (advisory):</span> {it.explanation}
                  </p>
                )}
                {e.url && (
                  <a href={e.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[10px] text-cyan-400 hover:underline">
                    primary source ↗
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
