'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { Compass } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { TabPanel } from '@/components/motion';
import { Chip, ViewHero } from '@/components/ui';
import { TopPicksView } from '@/components/TopPicksView';
import { LeadersView } from '@/components/LeadersView';
import { StocksView } from '@/components/StocksView';
import { MarketLens } from '@/components/market/MarketLens';

/*
 * v2 upgrade (upgrade-spec §2/§10): Discover replaces the three discovery
 * screens (Top 5 / Relative Leaders / Stock universe) behind one destination
 * with an explained sort basis and an honest coverage statement. Rank
 * snapshots remain an EVALUATION record, not a proven alpha claim — the
 * ranking IC is still "collecting", stated on the Leaders section itself.
 */

type Section = 'ranked' | 'top-picks' | 'universe';

const SECTIONS: Array<{ id: Section; label: string; explain: string }> = [
  {
    id: 'ranked',
    label: 'Relative strength',
    explain: 'All covered stocks ranked cross-sectionally: 50% momentum · 30% quality · 20% sentiment. Ranking skill (IC) is still being measured — treat order as descriptive, not predictive.',
  },
  {
    id: 'top-picks',
    label: 'Daily scan',
    explain: 'The daily universe scan ordered by the heuristic quant score, with a budget filter. Measured direction accuracy of the underlying model is ≈ a coin flip — see Track Record.',
  },
  {
    id: 'universe',
    label: 'All covered stocks',
    explain: 'The full supported universe with latest score and entry state. Coverage is this list — not "all NSE".',
  },
];

export function DiscoverView({ onOpenStock }: { onOpenStock: (ticker: string) => void }) {
  const [section, setSection] = useState<Section>('ranked');
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div className="discover-page space-y-5">
      <ViewHero
        eyebrow="Explore the universe"
        title="Discover"
        subtitle={
          <>
            Search, rank and filter the <span className="font-medium text-slate-300">151-stock NSE coverage universe</span>.
            Every ranking states its basis; none of them is a guarantee.
          </>
        }
        visual={<MarketLens variant="discover" />}
        right={<Chip tone="zinc"><Compass className="h-3.5 w-3.5" aria-hidden /> coverage: 151 NSE stocks</Chip>}
      />

      <div>
        <div
          role="radiogroup"
          aria-label="Discover section"
          className="inline-flex flex-wrap gap-1 rounded-xl border border-white/8 bg-white/4 p-1"
        >
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={section === s.id}
              onClick={() => setSection(s.id)}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors sm:text-sm',
                section === s.id ? 'bg-white/10 text-cyan-300' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 max-w-3xl px-1 text-xs leading-relaxed text-slate-500">{active.explain}</p>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <TabPanel key={section}>
          {section === 'ranked' && <LeadersView onAnalyze={onOpenStock} />}
          {section === 'top-picks' && <TopPicksView onAnalyze={onOpenStock} />}
          {section === 'universe' && <StocksView onAnalyze={onOpenStock} />}
        </TabPanel>
      </AnimatePresence>
    </div>
  );
}
