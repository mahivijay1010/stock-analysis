'use client';

import { KeyboardEvent, ReactNode, useId, useRef } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * Tab strip with a framer-motion layoutId indicator that glides between tabs.
 * - `underline` — gradient bar under the active label (page-level sections).
 * - `pill`      — glass pill behind the active label (in-card toggles).
 * Roving tabindex + Arrow/Home/End keyboard support per the ARIA tabs pattern
 * (arrows move AND select). Panels live with the caller — pass `getPanelId`
 * to wire aria-controls when panels carry matching ids.
 */
export function Tabs<V extends string = string>({
  items,
  value,
  onChange,
  variant = 'underline',
  ariaLabel,
  className,
  getPanelId,
}: {
  items: Array<TabItem<V>>;
  value: V;
  onChange: (value: V) => void;
  variant?: 'underline' | 'pill';
  ariaLabel?: string;
  className?: string;
  getPanelId?: (value: V) => string;
}) {
  const uid = useId();
  const refs = useRef<Map<V, HTMLButtonElement>>(new Map());

  const enabled = items.filter((t) => !t.disabled);

  const focusAndSelect = (item: TabItem<V>) => {
    refs.current.get(item.value)?.focus();
    onChange(item.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, item: TabItem<V>) => {
    const idx = enabled.findIndex((t) => t.value === item.value);
    if (idx < 0) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusAndSelect(enabled[(idx + 1) % enabled.length]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusAndSelect(enabled[(idx - 1 + enabled.length) % enabled.length]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAndSelect(enabled[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAndSelect(enabled[enabled.length - 1]);
    }
  };

  const isPill = variant === 'pill';

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx(
        isPill ? 'glass-inset inline-flex items-center gap-1 rounded-full p-1' : 'flex gap-1 border-b border-white/8',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              if (el) refs.current.set(item.value, el);
              else refs.current.delete(item.value);
            }}
            type="button"
            role="tab"
            id={`tab-${uid}-${item.value}`}
            aria-selected={active}
            aria-controls={getPanelId?.(item.value)}
            disabled={item.disabled}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => onKeyDown(e, item)}
            className={clsx(
              'font-display relative inline-flex min-h-10 items-center gap-1.5 text-sm font-medium tracking-wide whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-cyan-400/70',
              isPill ? 'rounded-full px-4 py-2' : 'px-3 py-2.5',
              item.disabled
                ? 'cursor-not-allowed text-slate-600'
                : active
                  ? isPill
                    ? 'text-slate-100'
                    : 'text-cyan-400'
                  : 'text-slate-400 hover:text-slate-200',
            )}
          >
            {isPill && active && (
              <motion.span
                layoutId={`tabs-${uid}-pill`}
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                className="absolute inset-0 rounded-full border border-white/15 bg-white/10 shadow-[0_0_14px_rgba(34,211,238,0.15)]"
                aria-hidden
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {item.icon}
              {item.label}
            </span>
            {!isPill && active && (
              <motion.span
                layoutId={`tabs-${uid}-underline`}
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-gradient-to-r from-cyan-400 to-violet-400 shadow-[0_0_10px_rgba(34,211,238,0.6)]"
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
