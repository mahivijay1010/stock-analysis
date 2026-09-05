'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  BarChart3,
  BriefcaseBusiness,
  ChartNoAxesColumnIncreasing,
  ChevronRight,
  Gauge,
  Layers3,
  Menu,
  Sparkles,
  Trophy,
  WalletCards,
  X,
  type LucideIcon,
} from 'lucide-react';
import { SearchBox } from '@/components/analyze/SearchBox';
import { AmountInput } from '@/components/analyze/AmountInput';
import { ThemeToggle } from '@/components/ThemeToggle';

export type TabId = 'analyze' | 'top' | 'leaders' | 'portfolio' | 'accuracy' | 'stocks' | 'desk';

type NavItem = { id: TabId; label: string; short: string; description: string; icon: LucideIcon };

const NAV: NavItem[] = [
  { id: 'analyze', label: 'Analyze stock', short: 'Analyze', description: 'Full decision workspace', icon: Sparkles },
  { id: 'top', label: 'Top opportunities', short: 'Picks', description: 'Today’s ranked setups', icon: Trophy },
  { id: 'leaders', label: 'Market leaders', short: 'Leaders', description: 'Relative strength board', icon: ChartNoAxesColumnIncreasing },
  { id: 'portfolio', label: 'Portfolio builder', short: 'Portfolio', description: 'Allocate with risk controls', icon: WalletCards },
  { id: 'accuracy', label: 'Model accuracy', short: 'Accuracy', description: 'Measured, not marketed', icon: Gauge },
  { id: 'stocks', label: 'Stock universe', short: 'Universe', description: 'Explore every covered name', icon: Layers3 },
  { id: 'desk', label: 'Trading desk', short: 'Desk', description: 'Plan and review execution', icon: BriefcaseBusiness },
];

const PRIMARY_MOBILE = NAV.slice(0, 4);

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="brand-mark" aria-hidden>
        <BarChart3 className="h-[19px] w-[19px]" />
      </div>
      <div className="leading-none">
        <p className="font-display text-[15px] font-semibold tracking-[-0.02em] text-white">StockSense</p>
        <p className="mt-1 text-[9px] font-semibold tracking-[0.2em] text-slate-500 uppercase">India intelligence</p>
      </div>
    </div>
  );
}

function DesktopNavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={item.label}
      title={item.label}
      className={clsx('sidebar-nav-item group', active && 'sidebar-nav-item-active')}
    >
      {active && (
        <motion.span
          layoutId="desktop-nav-active"
          className="absolute inset-0 rounded-xl border border-white/[0.08] bg-white/[0.055]"
          transition={{ type: 'spring', stiffness: 430, damping: 38 }}
        />
      )}
      <span className={clsx('sidebar-nav-icon relative z-10', active && 'sidebar-nav-icon-active')}>
        <Icon className="h-[17px] w-[17px]" aria-hidden />
      </span>
      <span className="sidebar-nav-tooltip" role="tooltip">
        <strong>{item.label}</strong>
        <small>{item.description}</small>
      </span>
    </button>
  );
}

export function Header({ tab, onTabChange, onAnalyze, onAmountChange }: { tab: TabId; onTabChange: (tab: TabId) => void; onAnalyze: (ticker: string) => void; onAmountChange: (amount: number | null) => void }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const active = NAV.find((item) => item.id === tab) ?? NAV[0];

  const choose = (id: TabId) => {
    setMoreOpen(false);
    onTabChange(id);
  };

  return (
    <>
      <aside className="app-sidebar fixed inset-y-0 left-0 z-50 hidden w-[84px] flex-col lg:flex">
        <div className="flex h-[76px] items-center justify-center">
          <div className="brand-mark" aria-label="StockSense" title="StockSense"><BarChart3 className="h-[19px] w-[19px]" /></div>
        </div>

        <nav className="flex flex-1 flex-col items-center gap-2 overflow-visible px-3 pt-5" aria-label="Workspace navigation">
          {NAV.map((item, index) => (
            <div key={item.id} className={clsx('w-full', index === 4 && 'mt-4 border-t border-white/[0.07] pt-6')}>
              <DesktopNavButton item={item} active={tab === item.id} onClick={() => choose(item.id)} />
            </div>
          ))}
        </nav>

        <div className="mb-5 flex justify-center" aria-label="NSE intelligence online" title="NSE intelligence online">
          <span className="rail-market-status"><Activity className="h-4 w-4" aria-hidden /><i /></span>
        </div>
      </aside>

      <header className="workspace-topbar fixed top-0 right-0 left-[84px] z-40 hidden h-[64px] items-center justify-between px-7 lg:flex">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-600">Intelligence workspace</span>
          <ChevronRight className="h-3 w-3 text-slate-700" aria-hidden />
          <span className="font-medium text-slate-300">{active.label}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="topbar-stock-search"><SearchBox onSelect={onAnalyze} inputId="stock-command-input-desktop" className="max-w-none" /></div>
          {tab === 'analyze' && <div className="topbar-capital hidden xl:block"><AmountInput onAmountChange={onAmountChange} /></div>}
          <ThemeToggle />
          <div className="flex items-center gap-2 border-l border-white/[0.07] pl-3 text-[10px] text-slate-500">
            <Activity className="h-3.5 w-3.5 text-emerald-400" aria-hidden />Systems normal
          </div>
        </div>
      </header>

      <header className="mobile-topbar fixed inset-x-0 top-0 z-50 flex h-16 items-center justify-between px-4 lg:hidden">
        <Brand />
        <div className="flex items-center gap-2">
          <ThemeToggle compact />
          <button type="button" onClick={() => setMoreOpen(true)} className="icon-button" aria-label="Open navigation">
            <Menu className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </header>

      <nav className="mobile-bottom-nav fixed inset-x-3 bottom-3 z-50 flex items-center justify-around rounded-2xl p-1.5 lg:hidden" aria-label="Primary navigation">
        {PRIMARY_MOBILE.map((item) => {
          const Icon = item.icon;
          const selected = tab === item.id;
          return (
            <button key={item.id} type="button" onClick={() => choose(item.id)} className={clsx('mobile-nav-item', selected && 'mobile-nav-item-active')}>
              <Icon className="h-[18px] w-[18px]" aria-hidden /><span>{item.short}</span>
            </button>
          );
        })}
        <button type="button" onClick={() => setMoreOpen(true)} className={clsx('mobile-nav-item', ['accuracy', 'stocks', 'desk'].includes(tab) && 'mobile-nav-item-active')}>
          <Menu className="h-[18px] w-[18px]" aria-hidden /><span>More</span>
        </button>
      </nav>

      <AnimatePresence>
        {moreOpen && (
          <motion.div className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              role="dialog" aria-modal="true" aria-label="Navigation" className="mobile-nav-sheet absolute inset-x-3 bottom-3 rounded-[24px] p-4"
              initial={{ opacity: 0, y: 28, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 22, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
            >
              <div className="mb-3 flex items-center justify-between px-1">
                <div><p className="font-display text-sm font-semibold text-white">Everything in one workspace</p><p className="mt-1 text-[10px] text-slate-500">Choose where you want to go next</p></div>
                <button type="button" onClick={() => setMoreOpen(false)} className="icon-button" aria-label="Close navigation"><X className="h-4 w-4" aria-hidden /></button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {NAV.map((item) => {
                  const Icon = item.icon;
                  const selected = tab === item.id;
                  return (
                    <button key={item.id} type="button" onClick={() => choose(item.id)} className={clsx('mobile-sheet-item', selected && 'mobile-sheet-item-active')}>
                      <Icon className="h-4 w-4" aria-hidden />
                      <span className="text-left"><span className="block text-xs font-medium">{item.short}</span><span className="mt-0.5 block text-[9px] text-slate-600">{item.description}</span></span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
