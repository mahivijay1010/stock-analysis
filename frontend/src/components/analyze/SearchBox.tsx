'use client';

import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Loader2, Search } from 'lucide-react';
import { searchStocks } from '@/lib/api';
import { Chip } from '@/components/ui';

export function SearchBox({ onSelect, prominent = false, className, inputId = 'stock-command-input' }: { onSelect: (ticker: string) => void; prominent?: boolean; className?: string; inputId?: string }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  // 300ms debounce
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const enabled = debounced.length >= 2;
  const { data: suggestions, isFetching, isError, error } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => searchStocks(debounced),
    enabled,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  // Close on outside click
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const items = enabled && suggestions ? suggestions : [];
  const showList = open && enabled && (items.length > 0 || isFetching || isError);
  // Clamp instead of resetting in an effect — suggestions can shrink between renders.
  const active = activeIdx >= 0 && activeIdx < items.length ? activeIdx : -1;

  function choose(ticker: string) {
    setOpen(false);
    setQuery('');
    onSelect(ticker);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIdx(items.length ? (active + 1) % items.length : -1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(items.length ? (active <= 0 ? items.length - 1 : active - 1) : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && items[active]) {
        choose(items[active].ticker);
      } else if (query.trim()) {
        // Backend /api/analyze resolves free-text names too
        choose(query.trim());
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={clsx('relative w-full', prominent ? 'max-w-none' : 'max-w-xl', className)}>
      <div className="relative">
        <Search className={clsx('pointer-events-none absolute top-1/2 -translate-y-1/2 text-slate-500', prominent ? 'left-5 h-5 w-5' : 'left-3.5 h-4 w-4')} aria-hidden />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls="stock-search-listbox"
          aria-autocomplete="list"
          // A form-related browser extension injects data-sharkid (and similar
          // tracking attributes) into <input> elements before React hydrates.
          // That's a genuine client-side DOM mutation outside our render, not
          // a bug here — suppress hydration warnings on this one node so it
          // doesn't mask a real mismatch on the input's actual props.
          suppressHydrationWarning
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={prominent ? 'Ask StockSense about any NSE stock…' : 'Search another stock…'}
          className={clsx('input-glass', prominent ? 'analysis-command-input py-4 pr-12 pl-13 text-base' : 'py-2.5 pr-10 pl-10')}
        />
        {isFetching && (
          <Loader2 className={clsx('absolute top-1/2 -translate-y-1/2 animate-spin text-slate-500', prominent ? 'right-5 h-5 w-5' : 'right-3.5 h-4 w-4')} aria-hidden />
        )}
      </div>

      {showList && (
        <ul
          id="stock-search-listbox"
          role="listbox"
          className="overlay-panel absolute z-30 mt-2 max-h-80 w-full overflow-y-auto py-1"
        >
          {items.length === 0 && isFetching && (
            <li className="px-4 py-3 text-sm text-slate-400">Searching…</li>
          )}
          {items.length === 0 && !isFetching && isError && (
            <li className="px-4 py-3 text-sm text-rose-400">
              Search failed{error instanceof Error && error.message ? ` — ${error.message}` : ''}
            </li>
          )}
          {items.map((s, i) => (
            <li key={`${s.ticker}-${i}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s.ticker);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className={clsx(
                  'flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors',
                  i === active ? 'bg-cyan-400/10' : 'hover:bg-white/5',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-100">{s.name}</span>
                  <span className="block text-xs text-slate-500">{s.ticker}</span>
                </span>
                <Chip tone="zinc">{s.exchange}</Chip>
              </button>
            </li>
          ))}
          {items.length === 0 && !isFetching && !isError && (
            <li className="px-4 py-3 text-sm text-slate-400">No Indian stocks match “{debounced}”.</li>
          )}
        </ul>
      )}
    </div>
  );
}
