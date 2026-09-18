'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Header, type TabId } from '@/components/Header';
import { TabPanel } from '@/components/motion';
import { PortfolioView } from '@/components/portfolio/PortfolioView';
import { DiscoverView } from '@/components/DiscoverView';
import { ShortTermView } from '@/components/shortterm/ShortTermView';
import { LiveView } from '@/components/live/LiveView';
import { EvidenceView } from '@/components/evidence/EvidenceView';
import { TrackRecordView } from '@/components/TrackRecordView';
import { StockDetailView } from '@/components/analyze/AnalyzeView';
import { SandboxView } from '@/components/admin/AdminView';

const TICKER_KEY = 'stocksense.lastTicker';
const PENDING_PURCHASE_KEY = 'stocksense.pendingPurchase';

const CANONICAL_TABS: readonly TabId[] = [
  'watchlist',
  'discover',
  'short-term',
  'live',
  'track-record',
  'evidence',
  'stock',
  'sandbox',
  'diagnostics',
];

/**
 * Hash routing with the v2 redirect map (upgrade-audit §3.1):
 *   #analyze            → #watchlist (or #stock/<ticker> when one is stored)
 *   #top #leaders #stocks #portfolio → #discover
 *   #accuracy           → #track-record
 *   #desk #admin        → #sandbox
 *   unknown             → #watchlist (the new default screen)
 * Stock Detail is a drill-down at #stock/<ticker>.
 */
function routeFromHash(): { tab: TabId; ticker: string | null } {
  const raw = window.location.hash.replace(/^#/, '');
  const [head, ...rest] = raw.split('/');

  if (head === 'stock') {
    const t = rest.join('/').trim();
    if (t) return { tab: 'stock', ticker: decodeURIComponent(t).toUpperCase() };
    return { tab: 'stock', ticker: null };
  }
  if ((CANONICAL_TABS as readonly string[]).includes(head)) return { tab: head as TabId, ticker: null };

  // Legacy redirects.
  // Holdings merged into the unified Watchlist (owner request 2026-09-06).
  if (head === 'holdings') return { tab: 'watchlist', ticker: null };
  if (head === 'analyze') {
    let stored: string | null = null;
    try {
      stored =
        new URLSearchParams(window.location.search).get('ticker') || window.sessionStorage.getItem(TICKER_KEY);
    } catch {
      /* storage unavailable */
    }
    if (stored) return { tab: 'stock', ticker: stored.toUpperCase() };
    return { tab: 'watchlist', ticker: null };
  }
  if (head === 'top' || head === 'leaders' || head === 'stocks' || head === 'portfolio')
    return { tab: 'discover', ticker: null };
  if (head === 'accuracy') return { tab: 'track-record', ticker: null };
  if (head === 'desk' || head === 'admin') return { tab: 'sandbox', ticker: null };
  return { tab: 'watchlist', ticker: null };
}

function hashFor(tab: TabId, ticker: string | null): string {
  if (tab === 'stock' && ticker) return `#stock/${encodeURIComponent(ticker)}`;
  return `#${tab}`;
}

export default function Home() {
  // First render matches the server (watchlist); the mount effect restores the
  // real route before paint settles. Hash routing survives refresh without
  // useSearchParams' Suspense/prerender pain.
  const [tab, setTab] = useState<TabId>('watchlist');
  const [routeReady, setRouteReady] = useState(false);
  const [ticker, setTicker] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [pendingPurchase, setPendingPurchase] = useState<string | null>(null);

  useEffect(() => {
    const applyRoute = (normalize: boolean) => {
      const route = routeFromHash();
      setTab(route.tab);
      if (route.tab === 'stock') {
        const t = route.ticker ?? window.sessionStorage.getItem(TICKER_KEY);
        if (t) setTicker(t.toUpperCase());
      }
      if (normalize) {
        window.history.replaceState(null, '', hashFor(route.tab, route.ticker));
      }
    };
    const restore = window.setTimeout(() => {
      applyRoute(true);
      try {
        const pending = window.sessionStorage.getItem(PENDING_PURCHASE_KEY);
        if (pending) setPendingPurchase(pending.toUpperCase());
      } catch {
        /* storage unavailable */
      }
      setRouteReady(true);
    }, 0);
    const onHashChange = () => applyRoute(false);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.clearTimeout(restore);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const openTab = useCallback(
    (t: TabId) => {
      setTab(t);
      window.history.replaceState(null, '', hashFor(t, ticker));
      window.scrollTo({ top: 0 });
    },
    [ticker],
  );

  /** Drill into Stock Detail from any list row or search result. */
  const openStock = useCallback((t: string) => {
    const up = t.toUpperCase();
    setTicker(up);
    try {
      window.sessionStorage.setItem(TICKER_KEY, up);
    } catch {
      /* non-fatal */
    }
    setTab('stock');
    window.history.replaceState(null, '', hashFor('stock', up));
    window.scrollTo({ top: 0 });
  }, []);

  const consumePendingPurchase = useCallback(() => {
    setPendingPurchase(null);
    try {
      window.sessionStorage.removeItem(PENDING_PURCHASE_KEY);
    } catch {
      /* non-fatal */
    }
  }, []);

  // Cmd/Ctrl-K focuses the stock search.
  useEffect(() => {
    const onCommand = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        window.setTimeout(() => {
          const input =
            window.innerWidth >= 1024
              ? document.getElementById('stock-command-input-desktop')
              : (document.getElementById('stock-command-input-mobile-sheet') ??
                document.getElementById('stock-command-input-launchpad'));
          input?.focus();
        }, 80);
      }
    };
    window.addEventListener('keydown', onCommand);
    return () => window.removeEventListener('keydown', onCommand);
  }, []);

  return (
    <div className="min-h-screen">
      <Header tab={tab} stockLabel={ticker} onTabChange={openTab} onOpenStock={openStock} onAmountChange={setAmount} />
      <main
        className="workspace-main w-full px-4 pt-24 pb-28 sm:px-6 lg:ml-[248px] lg:w-[calc(100%-248px)] lg:px-8 lg:pt-[96px] lg:pb-16 2xl:px-10"
        data-workspace={tab}
      >
        {routeReady && (
          <AnimatePresence mode="wait" initial={false}>
            <TabPanel key={tab} className="workspace-canvas mx-auto w-full max-w-[1520px]">
              {tab === 'watchlist' && (
                <PortfolioView
                  pendingPurchaseTicker={pendingPurchase}
                  onPendingPurchaseConsumed={consumePendingPurchase}
                  onOpenStock={openStock}
                />
              )}
              {tab === 'discover' && <DiscoverView onOpenStock={openStock} />}
              {tab === 'short-term' && <ShortTermView />}
              {tab === 'live' && <LiveView />}
              {tab === 'track-record' && <TrackRecordView />}
              {tab === 'evidence' && <EvidenceView />}
              {tab === 'diagnostics' && <TrackRecordView diagnosticsOpen />}
              {tab === 'stock' && (
                <StockDetailView
                  ticker={ticker}
                  amount={amount}
                  onOpenStock={openStock}
                  onAmountChange={setAmount}
                  onGoToTrackRecord={() => openTab('track-record')}
                />
              )}
              {tab === 'sandbox' && <SandboxView onOpenStock={openStock} />}
            </TabPanel>
          </AnimatePresence>
        )}
      </main>
    </div>
  );
}
