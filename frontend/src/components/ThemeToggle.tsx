'use client';

import { useSyncExternalStore } from 'react';
import { motion } from 'framer-motion';
import { MoonStar, SunMedium } from 'lucide-react';
import clsx from 'clsx';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'stocksense.theme';

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  window.dispatchEvent(new Event('stocksense-themechange'));
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener('stocksense-themechange', onStoreChange);
  return () => window.removeEventListener('stocksense-themechange', onStoreChange);
}

function getThemeSnapshot(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = useSyncExternalStore(subscribe, getThemeSnapshot, () => 'dark');

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Theme still applies for this session when storage is unavailable.
    }
  };

  const isLight = theme === 'light';

  return (
    <button
      type="button"
      onClick={toggle}
      className={clsx('theme-toggle', compact && 'theme-toggle-compact')}
      aria-label={`Switch to ${isLight ? 'dark' : 'light'} theme`}
      title={`Switch to ${isLight ? 'dark' : 'light'} theme`}
    >
      <span className="theme-toggle-icon" aria-hidden>
        <motion.span
          animate={{ rotate: isLight ? 0 : -12, scale: [0.88, 1.08, 1] }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          {isLight ? <SunMedium /> : <MoonStar />}
        </motion.span>
      </span>
      {!compact && <span>{isLight ? 'Ivory' : 'Nocturne'}</span>}
    </button>
  );
}
