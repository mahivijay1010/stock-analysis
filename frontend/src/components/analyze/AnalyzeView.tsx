'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import clsx from 'clsx';
import {
  ArrowUpRight,
  BrainCircuit,
  ChartSpline,
  CircleDotDashed,
  Crosshair,
  Info,
  Layers3,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { analyzeStock } from '@/lib/api';
import { Card, CardSkeleton, ChartSkeleton, ErrorState, Skeleton } from '@/components/ui';
import { Stagger, StaggerItem, TabPanel } from '@/components/motion';
import { SearchBox } from './SearchBox';
import { AmountInput } from './AmountInput';
import { StockHero } from './StockHero';
import { DecisionSummary } from './DecisionSummary';
import { InvestmentBriefCard } from './InvestmentBriefCard';
import { NewsPanel } from './NewsPanel';
import { MonteCarloCard } from './MonteCarloCard';
import { VolForecastCard } from './VolForecastCard';
import { ForecastChart } from './ForecastChart';
import { ProjectionsTable } from './ProjectionsTable';
import { TechnicalsGrid } from './TechnicalsGrid';
import { AccuracyStrip } from './AccuracyStrip';
import { PriceChartCard } from './PriceChartCard';
import { DailyForecastCard } from './DailyForecastCard';
import { CanonicalDecisionCard } from './CanonicalDecisionCard';
import { ForecastVintageCard } from './ForecastVintageCard';
import { MaterialEventsCard } from './MaterialEventsCard';
import { AiSynthesisCard } from './AiSynthesisCard';
import { CommitteeCard } from './CommitteeCard';
import { FrameworkPanel } from './FrameworkPanel';
import { TradePlanCard } from './TradePlanCard';
import { RecentWindowsPanel } from './RecentWindowsPanel';

const EXAMPLES = [
  { ticker: 'RELIANCE.NS', label: 'Reliance' },
  { ticker: 'TCS.NS', label: 'TCS' },
  { ticker: 'HDFCBANK.NS', label: 'HDFC Bank' },
  { ticker: 'INFY.NS', label: 'Infosys' },
  { ticker: 'TATAMOTORS.NS', label: 'Tata Motors' },
];

type WorkspaceSection = 'overview' | 'forecast' | 'research' | 'technicals';

const SECTIONS: Array<{ id: WorkspaceSection; label: string; description: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Decision', description: 'Verdict, timing & plan', icon: Crosshair },
  { id: 'forecast', label: 'Forecast', description: 'Ranges & scenarios', icon: ChartSpline },
  { id: 'research', label: 'Research', description: 'Models & evidence', icon: BrainCircuit },
  { id: 'technicals', label: 'Deep dive', description: 'Technicals & holdings', icon: Layers3 },
];

function AnalyzeSkeleton() {
  return (
    <div className="space-y-5">
      <Card elevated className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2"><Skeleton className="h-7 w-56" /><Skeleton className="h-4 w-36" /></div>
          <div className="space-y-2 text-right"><Skeleton className="ml-auto h-11 w-44" /><Skeleton className="ml-auto h-5 w-28" /></div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-4 border-t border-white/8 pt-5 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="space-y-2"><Skeleton className="h-3 w-20" /><Skeleton className="h-5 w-16" /></div>)}
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,.75fr)]">
        <Card className="p-5"><ChartSkeleton height={380} /></Card>
        <div className="space-y-5"><CardSkeleton lines={4} /><CardSkeleton lines={3} /></div>
      </div>
    </div>
  );
}

function SignalMap() {
  const nodes = [
    { label: 'Price action', icon: Waves, className: 'signal-node-a' },
    { label: 'Fundamentals', icon: ScanSearch, className: 'signal-node-b' },
    { label: 'Risk', icon: ShieldCheck, className: 'signal-node-c' },
  ];
  return (
    <div className="signal-map" aria-label="StockSense analysis pipeline">
      <div className="signal-orbit signal-orbit-one" aria-hidden />
      <div className="signal-orbit signal-orbit-two" aria-hidden />
      <div className="signal-scan" aria-hidden />
      <motion.div
        className="signal-core"
        animate={{ scale: [1, 1.045, 1] }}
        transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Sparkles className="h-5 w-5" aria-hidden />
        <span>Decision</span>
      </motion.div>
      {nodes.map(({ label, icon: Icon, className }, index) => (
        <motion.div
          key={label}
          className={clsx('signal-node', className)}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.3 + index * 0.15, type: 'spring', stiffness: 300, damping: 24 }}
        >
          <span><Icon className="h-3.5 w-3.5" aria-hidden /></span>{label}
        </motion.div>
      ))}
      <p className="signal-map-caption"><CircleDotDashed className="h-3.5 w-3.5" aria-hidden /> Multiple models, one readable answer</p>
    </div>
  );
}

function AnalyzeLaunchpad({ onAnalyze, onAmountChange }: { onAnalyze: (ticker: string) => void; onAmountChange: (amount: number | null) => void }) {
  return (
    <section className="analysis-launchpad">
      <div className="launchpad-glow" aria-hidden />
      <div className="relative grid min-h-[calc(100vh-9rem)] items-center gap-10 py-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(390px,.85fr)] lg:py-10">
        <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-cyan-300/[0.13] bg-cyan-300/[0.045] px-3 py-1.5 text-[10px] font-semibold tracking-[0.14em] text-cyan-200/80 uppercase">
            <span className="market-live-dot" aria-hidden /> AI-assisted Indian market intelligence
          </div>
          <h1 className="font-display max-w-3xl text-[clamp(3rem,6.2vw,6.4rem)] leading-[0.92] font-semibold tracking-[-0.065em] text-white">
            See the signal.<br /><span className="launchpad-gradient-text">Understand why.</span>
          </h1>
          <p className="mt-6 max-w-xl text-[15px] leading-7 text-slate-400 sm:text-base">
            Turn live market data, measured models and risk context into one clear decision workspace—without the noise of a trading terminal.
          </p>

          <div className="analysis-command mt-8 max-w-3xl p-2 sm:p-2.5">
            <SearchBox onSelect={onAnalyze} prominent inputId="stock-command-input-launchpad" />
            <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <AmountInput onAmountChange={onAmountChange} prominent />
              <div className="hidden items-center gap-2 px-3 text-[10px] text-slate-600 sm:flex"><kbd className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-1 font-mono text-slate-500">↵</kbd> to analyze</div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[10px] font-medium tracking-wider text-slate-600 uppercase">Explore</span>
            {EXAMPLES.map((example) => (
              <button key={example.ticker} type="button" onClick={() => onAnalyze(example.ticker)} className="example-stock-pill group">
                {example.label}<ArrowUpRight className="h-3 w-3 text-slate-600 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-cyan-300" aria-hidden />
              </button>
            ))}
          </div>

          <div className="mt-10 grid max-w-2xl grid-cols-3 divide-x divide-white/[0.06] border-y border-white/[0.06] py-4">
            {[
              ['Evidence first', 'Real market inputs'],
              ['Risk aware', 'Ranges, not promises'],
              ['Measured', 'Accuracy in context'],
            ].map(([title, subtitle]) => (
              <div key={title} className="px-3 first:pl-0 sm:px-5">
                <p className="text-[11px] font-semibold text-slate-300 sm:text-xs">{title}</p>
                <p className="mt-1 text-[9px] text-slate-600 sm:text-[10px]">{subtitle}</p>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div className="hidden lg:block" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.12, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}>
          <SignalMap />
        </motion.div>
      </div>
    </section>
  );
}

function WorkspaceNav({ active, onChange }: { active: WorkspaceSection; onChange: (section: WorkspaceSection) => void }) {
  return (
    <div className="analysis-workspace-nav" role="tablist" aria-label="Analysis sections">
      {SECTIONS.map((section) => {
        const Icon = section.icon;
        const selected = section.id === active;
        return (
          <button key={section.id} type="button" role="tab" aria-selected={selected} onClick={() => onChange(section.id)} className={clsx('analysis-workspace-tab group', selected && 'analysis-workspace-tab-active')}>
            {selected && <motion.span layoutId="analysis-workspace-active" className="analysis-workspace-active-line" transition={{ type: 'spring', stiffness: 430, damping: 38 }} />}
            <Icon className={clsx('relative h-4 w-4 shrink-0', selected ? 'text-[var(--accent-cyan)]' : 'text-slate-600 group-hover:text-slate-400')} aria-hidden />
            <span className="relative text-xs font-semibold">{section.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AnalyzeView({ ticker, amount, onAnalyze, onAmountChange, onGoToAccuracy }: { ticker: string | null; amount: number | null; onAnalyze: (ticker: string) => void; onAmountChange: (amount: number | null) => void; onGoToAccuracy: () => void }) {
  const [section, setSection] = useState<WorkspaceSection>('overview');
  const reducedMotion = useReducedMotion();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['analyze', ticker, amount], queryFn: () => analyzeStock(ticker as string, amount), enabled: !!ticker, staleTime: 5 * 60_000,
  });
  const investmentPlan = data?.investmentPlan ?? null;

  if (!ticker) return <AnalyzeLaunchpad onAnalyze={onAnalyze} onAmountChange={onAmountChange} />;

  return (
    <div className="analysis-results space-y-4">
      <div className="result-command-bar xl:hidden">
        <div className="grid min-w-0 w-full gap-2 sm:grid-cols-[minmax(0,1fr)_256px]">
          <SearchBox onSelect={onAnalyze} inputId="stock-command-input-mobile" className="sm:max-w-none" />
          <AmountInput onAmountChange={onAmountChange} />
        </div>
      </div>

      {isPending && <AnalyzeSkeleton />}
      {isError && <ErrorState message={error instanceof Error ? error.message : 'Analysis failed'} onRetry={() => refetch()} />}

      {data && (
        <>
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, y: 14, filter: 'blur(5px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
          >
            <StockHero data={data} />
          </motion.div>
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.38, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
          >
            <WorkspaceNav active={section} onChange={setSection} />
          </motion.div>

          <AnimatePresence mode="wait" initial={false}>
            <TabPanel key={section}>
              {section === 'overview' && (
                <Stagger className="space-y-4">
                  <StaggerItem><CanonicalDecisionCard ticker={data.ticker} /></StaggerItem>
                  <StaggerItem><CommitteeCard ticker={data.ticker} /></StaggerItem>
                  <div className="overview-command-grid">
                    <StaggerItem className="overview-command-item overview-decision-item"><DecisionSummary data={data} /></StaggerItem>
                    <StaggerItem className="overview-command-item overview-chart-item"><PriceChartCard key={`chart-${data.ticker}`} ticker={data.ticker} /></StaggerItem>
                  </div>
                  <StaggerItem><RecentWindowsPanel bars={data.chart.bars} currentPrice={data.quote.price} /></StaggerItem>
                  {investmentPlan && data.tradePlan !== undefined && <StaggerItem><TradePlanCard tradePlan={data.tradePlan} investmentPlan={investmentPlan} /></StaggerItem>}
                </Stagger>
              )}

              {section === 'forecast' && (
                <div className="space-y-5">
                  <ForecastVintageCard ticker={data.ticker} />
                  <DailyForecastCard ticker={data.ticker} />
                  <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
                    <ForecastChart bars={data.chart.bars} predictions={data.analysis.predictions} />
                    {data.monteCarlo && <MonteCarloCard forecast={data.monteCarlo} />}
                  </div>
                  <ProjectionsTable predictions={data.analysis.predictions} investmentPlanRow={investmentPlan?.projections ?? null} highlightAmount={investmentPlan?.amount ?? null} />
                  <VolForecastCard ticker={data.ticker} />
                </div>
              )}

              {section === 'research' && (
                <div className="space-y-4">
                  <MaterialEventsCard ticker={data.ticker} />
                  {data.news !== undefined && <NewsPanel news={data.news} />}
                  {data.framework && <FrameworkPanel framework={data.framework} />}
                  <InvestmentBriefCard key={`brief-${data.ticker}`} ticker={data.ticker} />
                  <AccuracyStrip accuracy={data.accuracy} onGoToAccuracy={onGoToAccuracy} />
                </div>
              )}

              {section === 'technicals' && (
                <div className="space-y-4">
                  <AiSynthesisCard ticker={data.ticker} />
                  <TechnicalsGrid technicals={data.analysis.technicals} quote={data.quote} />
                </div>
              )}
            </TabPanel>
          </AnimatePresence>

          <div className="flex items-start gap-2 border-t border-white/[0.06] px-1 pt-4 text-[10px] leading-relaxed text-slate-600">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><p>{data.disclaimer}</p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Stock Detail (v2 upgrade) — the drill-down destination. Wraps the
 * consolidated analysis view; navigation-level names map onto the legacy
 * AnalyzeView props (onOpenStock → onAnalyze, onGoToTrackRecord → onGoToAccuracy).
 */
export function StockDetailView({
  ticker,
  amount,
  onOpenStock,
  onAmountChange,
  onGoToTrackRecord,
}: {
  ticker: string | null;
  amount: number | null;
  onOpenStock: (ticker: string) => void;
  onAmountChange: (amount: number | null) => void;
  onGoToTrackRecord: () => void;
}) {
  return (
    <AnalyzeView
      ticker={ticker}
      amount={amount}
      onAnalyze={onOpenStock}
      onAmountChange={onAmountChange}
      onGoToAccuracy={onGoToTrackRecord}
    />
  );
}
