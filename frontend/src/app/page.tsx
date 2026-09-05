'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Header, type TabId } from '@/components/Header';
import { TabPanel } from '@/components/motion';
import { AnalyzeView } from '@/components/analyze/AnalyzeView';
import { TopPicksView } from '@/components/TopPicksView';
import { LeadersView } from '@/components/LeadersView';
import { PortfolioView } from '@/components/PortfolioView';
import { AccuracyView } from '@/components/AccuracyView';
import { StocksView } from '@/components/StocksView';
import { AdminView } from '@/components/admin/AdminView';
import { ChatWidget } from '@/components/assistant/ChatWidget';

const TAB_IDS: readonly TabId[] = ['analyze', 'top', 'leaders', 'portfolio', 'accuracy', 'stocks', 'desk'];
const TICKER_KEY = 'stocksense.lastTicker';

/** #desk → 'desk'; legacy #admin still lands on the desk; anything else → analyze. */
function tabFromHash(): TabId {
  const raw = window.location.hash.replace(/^#/, '');
  if (raw === 'admin') return 'desk';
  return (TAB_IDS as readonly string[]).includes(raw) ? (raw as TabId) : 'analyze';
}

export default function Home() {
  // URL-hash routing (survives refresh; useSearchParams would force Suspense/prerender pain).
  // First render matches the server (analyze, no ticker); the mount effect
  // restores the real tab + last analyzed ticker before paint settles.
  const [tab, setTab] = useState<TabId>('analyze');
  const [ticker, setTicker] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      setTab(tabFromHash());
      try {
        const linkedTicker = new URLSearchParams(window.location.search).get('ticker');
        const last = linkedTicker || window.sessionStorage.getItem(TICKER_KEY);
        if (last) setTicker(last.toUpperCase());
      } catch {
        /* storage unavailable (private mode etc.) — start clean */
      }
    }, 0);
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.clearTimeout(restore);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const openTab = useCallback((t: TabId) => {
    setTab(t);
    window.history.replaceState(null, '', `#${t}`);
    window.scrollTo({ top: 0 });
  }, []);

  const openAnalyze = useCallback(
    (t: string) => {
      setTicker(t);
      try {
        window.sessionStorage.setItem(TICKER_KEY, t);
      } catch {
        /* non-fatal */
      }
      openTab('analyze');
    },
    [openTab],
  );

  useEffect(() => {
    const onCommand = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openTab('analyze');
        window.setTimeout(() => {
          const input = window.innerWidth >= 1024
            ? document.getElementById('stock-command-input-desktop')
            : document.getElementById('stock-command-input-mobile') ?? document.getElementById('stock-command-input-launchpad');
          input?.focus();
        }, 80);
      }
    };
    window.addEventListener('keydown', onCommand);
    return () => window.removeEventListener('keydown', onCommand);
  }, [openTab]);

  return (
    <div className="min-h-screen">
      <Header tab={tab} onTabChange={openTab} onAnalyze={openAnalyze} onAmountChange={setAmount} />
      <main className="w-full px-4 pt-24 pb-28 sm:px-6 lg:ml-[84px] lg:w-[calc(100%-84px)] lg:px-8 lg:pt-[88px] lg:pb-14">
        <AnimatePresence mode="wait" initial={false}>
          <TabPanel key={tab} className="mx-auto w-full max-w-[1480px]">
            {tab === 'analyze' && (
              <AnalyzeView ticker={ticker} amount={amount} onAnalyze={openAnalyze} onAmountChange={setAmount} onGoToAccuracy={() => openTab('accuracy')} />
            )}
            {tab === 'top' && <TopPicksView onAnalyze={openAnalyze} />}
            {tab === 'leaders' && <LeadersView onAnalyze={openAnalyze} />}
            {tab === 'portfolio' && <PortfolioView onAnalyze={openAnalyze} />}
            {tab === 'accuracy' && <AccuracyView />}
            {tab === 'stocks' && <StocksView onAnalyze={openAnalyze} />}
            {tab === 'desk' && <AdminView onAnalyze={openAnalyze} />}
          </TabPanel>
        </AnimatePresence>
      </main>
      {/* Sensei — global stocks-only chat assistant (all tabs) */}
      <ChatWidget />
    </div>
  );
}
