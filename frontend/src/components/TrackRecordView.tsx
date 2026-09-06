'use client';

import { ScrollText } from 'lucide-react';
import { Chip, ViewHero } from '@/components/ui';
import { AccuracyView } from '@/components/AccuracyView';

/*
 * v2 upgrade (upgrade-spec §2/§10): the public forecast track record — easy to
 * find, honest about live-vs-backtested provenance, never buried. Wraps the
 * measured accuracy + calibration content; `diagnosticsOpen` deep-links the
 * protected/advanced diagnostics disclosure for the secondary nav entry.
 */
export function TrackRecordView({ diagnosticsOpen = false }: { diagnosticsOpen?: boolean }) {
  return (
    <div className="space-y-5">
      <ViewHero
        eyebrow="Public honesty page"
        title="Forecast Track Record"
        subtitle={
          <>
            <span className="font-medium text-slate-300">Measured, not promised.</span> Walk-forward backtests replay
            past days with zero lookahead and compare every prediction to what actually happened. Historical results:
            direction ≈ a coin flip; the calibrated ranges are the real product. Past accuracy does not guarantee
            future results.
          </>
        }
        right={<Chip tone="zinc"><ScrollText className="h-3.5 w-3.5" aria-hidden /> walk-forward evidence</Chip>}
      />
      <AccuracyView diagnosticsOpen={diagnosticsOpen} />
    </div>
  );
}
