'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  ChartCandlestick,
  ChevronRight,
  Compass,
  Eye,
  FlaskConical,
  Gauge,
  Menu,
  Radio,
  ScrollText,
  Settings,
  X,
  type LucideIcon, Zap } from 'lucide-react';
import { getHealth } from '@/lib/api';
import { SearchBox } from '@/components/analyze/SearchBox';
import { AmountInput } from '@/components/analyze/AmountInput';
import { ThemeToggle } from '@/components/ThemeToggle';

export type TabId =
  | 'watchlist'
  | 'discover'
  | 'short-term'
  | 'live'
  | 'track-record'
  | 'evidence'
  | 'stock'
  | 'sandbox'
  | 'diagnostics';

type NavItem = { id: TabId; label: string; short: string; description: string; icon: LucideIcon };

/** The three primary destinations in the simplified product shell. */
const PRIMARY: NavItem[] = [
  { id: 'watchlist', label: 'Watchlist', short: 'Watch', description: 'Positions & live signals', icon: Eye },
  { id: 'discover', label: 'Discover', short: 'Discover', description: 'Opportunity universe', icon: Compass },
  { id: 'short-term', label: 'Short-Term', short: 'Short', description: '1–21 session setups', icon: Zap },
  { id: 'live', label: 'Live', short: 'Live', description: 'Real-time NSE monitoring', icon: Radio },
  { id: 'track-record', label: 'Track Record', short: 'Record', description: 'Measured model evidence', icon: Gauge },
  { id: 'evidence', label: 'Evidence', short: 'Evidence', description: 'Predictions, misses & what changed', icon: ScrollText },
];

/** Secondary destinations (gear menu): the sandbox desk + protected diagnostics. */
const SECONDARY: NavItem[] = [
  { id: 'sandbox', label: 'Sandbox', short: 'Sandbox', description: 'Paper trading desk — practice records, isolated', icon: FlaskConical },
  { id: 'diagnostics', label: 'Diagnostics', short: 'Diag', description: 'Advanced model diagnostics', icon: Settings },
];

const ALL_NAV = [...PRIMARY, ...SECONDARY];

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="brand-mark" aria-hidden>
        <BarChart3 className="h-[19px] w-[19px]" />
      </div>
      <div className="leading-none">
        <p className="font-display text-[15px] font-semibold tracking-[-0.02em] text-white">StockSense</p>
        <p className="mt-1 text-[9px] font-semibold tracking-[0.2em] text-slate-500 uppercase">Market intelligence</p>
      </div>
    </div>
  );
}

function DesktopNavButton({ item, index, active, onClick }: { item: NavItem; index: number; active: boolean; onClick: () => void }) {
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
      <span className="sidebar-nav-copy relative z-10">
        <strong>{item.label}</strong>
        <small>{item.description}</small>
      </span>
      <span className="sidebar-nav-index relative z-10" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
    </button>
  );
}

/** Honest backend status — wired to GET /health, never hardcoded. */
function HealthStatus({ sidebar = false }: { sidebar?: boolean }) {
  const q = useQuery({ queryKey: ['health'], queryFn: getHealth, staleTime: 60_000, retry: false });
  const ok = q.isSuccess && q.data?.status === 'ok';
  if (sidebar) {
    return (
      <div className={clsx('sidebar-engine-status', ok ? 'sidebar-engine-online' : q.isPending ? 'sidebar-engine-checking' : 'sidebar-engine-offline')}>
        <span className="sidebar-engine-icon"><Activity className="h-4 w-4" aria-hidden /></span>
        <span className="min-w-0">
          <strong>Research engine</strong>
          <small>{q.isPending ? 'Checking connection…' : ok ? 'Live data connection' : 'Connection unavailable'}</small>
        </span>
      </div>
    );
  }
  if (q.isPending) return null;
  return (
    <div
      className="flex items-center gap-2 border-l border-white/[0.07] pl-3 text-[10px] text-slate-500"
      title={ok ? 'Backend /health responded ok' : 'Backend /health failed — data may be missing or stale'}
    >
      <Activity className={clsx('h-3.5 w-3.5', ok ? 'text-emerald-400' : 'text-amber-400')} aria-hidden />
      {ok ? 'Backend: ok' : 'Backend unreachable'}
    </div>
  );
}

/** Global context without invented quotes; NIFTY/VIX values remain on scans
 * that actually fetched them. */
function MarketStatusRail() {
  return <div className="market-status-rail" aria-label="Market data and AI status"><span><small>NIFTY</small><strong>ON SCAN</strong></span><span><small>VIX</small><strong>ON SCAN</strong></span><span><small>DATA</small><strong>EOD · FREE</strong></span><span className="market-status-ai"><small>AI</small><strong>FREE-FIRST</strong></span></div>;
}

/** Small gear popover with the secondary destinations. */
function SecondaryMenu({ tab, onChoose }: { tab: TabId; onChoose: (id: TabId) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const secondaryActive = SECONDARY.some((s) => s.id === tab);

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More destinations (Sandbox, Diagnostics)"
        title="Sandbox & Diagnostics"
        className={clsx('sidebar-nav-item group', secondaryActive && 'sidebar-nav-item-active')}
      >
        <span className={clsx('sidebar-nav-icon relative z-10', secondaryActive && 'sidebar-nav-icon-active')}>
          <Settings className="h-[17px] w-[17px]" aria-hidden />
        </span>
        <span className="sidebar-nav-copy relative z-10">
          <strong>More tools</strong>
          <small>Sandbox & diagnostics</small>
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Secondary destinations"
            className="overlay-panel absolute bottom-0 left-[calc(100%+10px)] z-[70] w-64 py-1"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            transition={{ duration: 0.15 }}
          >
            {SECONDARY.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onChoose(item.id);
                  }}
                  className={clsx(
                    'flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-white/5',
                    tab === item.id && 'bg-cyan-400/10',
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-slate-200">{item.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">{item.description}</span>
                  </span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Header({
  tab,
  stockLabel,
  onTabChange,
  onOpenStock,
  onAmountChange,
}: {
  tab: TabId;
  /** Ticker shown in the breadcrumb when the Stock Detail drill-down is open. */
  stockLabel?: string | null;
  onTabChange: (tab: TabId) => void;
  onOpenStock: (ticker: string) => void;
  onAmountChange: (amount: number | null) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const active = ALL_NAV.find((item) => item.id === tab) ?? null;

  const choose = (id: TabId) => {
    setMoreOpen(false);
    onTabChange(id);
  };

  return (
    <>
      <aside className="app-sidebar fixed inset-y-0 left-0 z-50 hidden w-[248px] flex-col lg:flex">
        <div className="desktop-sidebar-brand flex h-[84px] items-center px-5">
          <Brand />
        </div>

        <div className="px-5 pt-5">
          <p className="sidebar-section-label">Workspace</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1.5 overflow-visible px-3 pt-2" aria-label="Primary navigation">
          {PRIMARY.map((item, index) => (
            <div key={item.id} className="w-full">
              <DesktopNavButton item={item} index={index} active={tab === item.id} onClick={() => choose(item.id)} />
            </div>
          ))}
        </nav>

        {/* Secondary destinations live behind the small gear menu. */}
        <div className="mb-5 flex flex-col gap-2 px-3" aria-label="Secondary navigation">
          <HealthStatus sidebar />
          <div className="w-full border-t border-white/[0.07] pt-4">
            <SecondaryMenu tab={tab} onChoose={choose} />
          </div>
        </div>
      </aside>

      <header className="workspace-topbar fixed top-0 right-0 left-[248px] z-40 hidden h-[72px] items-center justify-between px-8 lg:flex">
        <div className="flex items-center gap-2 text-xs">
          <span className="topbar-product-label">Market observatory</span>
          <ChevronRight className="h-3 w-3 text-slate-700" aria-hidden />
          {tab === 'stock' ? (
            <span className="flex items-center gap-1.5 font-medium text-slate-300">
              <ChartCandlestick className="h-3.5 w-3.5 text-slate-500" aria-hidden />
              {stockLabel ? `Stock detail · ${stockLabel}` : 'Stock detail'}
            </span>
          ) : (
            <span className="font-medium text-slate-300">{active?.label ?? 'Watchlist'}</span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2.5">
          <MarketStatusRail />
          <div className="topbar-stock-search"><SearchBox onSelect={onOpenStock} inputId="stock-command-input-desktop" className="max-w-none" /></div>
          {tab === 'stock' && <div className="topbar-capital hidden xl:block"><AmountInput onAmountChange={onAmountChange} /></div>}
          <ThemeToggle />
          <HealthStatus />
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
        {PRIMARY.map((item) => {
          const Icon = item.icon;
          const selected = tab === item.id;
          return (
            <button key={item.id} type="button" onClick={() => choose(item.id)} className={clsx('mobile-nav-item', selected && 'mobile-nav-item-active')}>
              <Icon className="h-[18px] w-[18px]" aria-hidden /><span>{item.short}</span>
            </button>
          );
        })}
        <button type="button" onClick={() => setMoreOpen(true)} className={clsx('mobile-nav-item', ['sandbox', 'diagnostics', 'stock'].includes(tab) && 'mobile-nav-item-active')}>
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
                <div><p className="font-display text-sm font-semibold text-white">Where next?</p><p className="mt-1 text-[10px] text-slate-500">Watchlist · Discover · Track Record — plus the sandbox desk</p></div>
                <button type="button" onClick={() => setMoreOpen(false)} className="icon-button" aria-label="Close navigation"><X className="h-4 w-4" aria-hidden /></button>
              </div>
              <div className="mb-3 px-1">
                <SearchBox onSelect={(t) => { setMoreOpen(false); onOpenStock(t); }} inputId="stock-command-input-mobile-sheet" className="max-w-none" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {ALL_NAV.map((item) => {
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
