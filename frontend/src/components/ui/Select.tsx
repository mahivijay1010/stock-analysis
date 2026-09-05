'use client';

import { KeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * Glass dropdown select (custom listbox). Slide-in panel, keyboard complete:
 * Arrow keys move the active option, Enter/Space select, Home/End jump,
 * Escape closes and returns focus, click-away closes. Trigger keeps focus and
 * exposes the active option via aria-activedescendant.
 */
export function Select<V extends string = string>({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  label,
  ariaLabel,
  disabled = false,
  className,
  panelClassName,
}: {
  options: Array<SelectOption<V>>;
  value: V | null;
  onChange: (value: V) => void;
  placeholder?: string;
  /** Optional field label rendered above the trigger. */
  label?: ReactNode;
  /** Accessible name when no visible `label` is given. */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  panelClassName?: string;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected = selectedIdx >= 0 ? options[selectedIdx] : null;

  const openPanel = () => {
    if (disabled) return;
    setActiveIdx(selectedIdx >= 0 ? selectedIdx : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };

  const close = () => setOpen(false);

  const commit = (idx: number) => {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    close();
  };

  const move = (from: number, dir: 1 | -1): number => {
    for (let i = 1; i <= options.length; i++) {
      const idx = (from + dir * i + options.length * i) % options.length;
      if (!options[idx]?.disabled) return idx;
    }
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIdx((i) => move(i, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIdx((i) => move(i, -1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIdx(options.findIndex((o) => !o.disabled));
        break;
      case 'End':
        e.preventDefault();
        setActiveIdx(options.length - 1 - [...options].reverse().findIndex((o) => !o.disabled));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIdx);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close();
        break;
    }
  };

  // Click-away closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  // Keep the active option in view while arrowing.
  useEffect(() => {
    if (!open || activeIdx < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`#select-${uid}-opt-${activeIdx}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIdx, uid]);

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      {label != null && (
        <span
          id={`select-${uid}-label`}
          className="mb-1.5 block text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase"
        >
          {label}
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `select-${uid}-list` : undefined}
        aria-labelledby={label != null ? `select-${uid}-label select-${uid}-value` : undefined}
        aria-label={label == null ? ariaLabel : undefined}
        aria-activedescendant={open && activeIdx >= 0 ? `select-${uid}-opt-${activeIdx}` : undefined}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={onKeyDown}
        className={clsx(
          'input-glass flex min-h-11 w-full items-center justify-between gap-2 py-2.5 pr-3 pl-3 text-left text-sm',
          disabled && 'cursor-not-allowed opacity-55',
        )}
      >
        <span id={`select-${uid}-value`} className={clsx('min-w-0 truncate', selected == null && 'text-slate-500')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          aria-hidden
          className={clsx(
            'h-4 w-4 shrink-0 text-slate-500 transition-transform duration-[var(--duration-fast)]',
            open && 'rotate-180',
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            ref={listRef}
            id={`select-${uid}-list`}
            role="listbox"
            aria-labelledby={label != null ? `select-${uid}-label` : undefined}
            aria-label={label == null ? ariaLabel : undefined}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className={clsx(
              'overlay-panel thin-scroll absolute z-50 mt-2 max-h-64 w-full overflow-y-auto py-1',
              panelClassName,
            )}
          >
            {options.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isActive = idx === activeIdx;
              return (
                <li
                  key={opt.value}
                  id={`select-${uid}-opt-${idx}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled || undefined}
                  onMouseEnter={() => !opt.disabled && setActiveIdx(idx)}
                  onClick={() => commit(idx)}
                  className={clsx(
                    'flex min-h-10 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm transition-colors',
                    opt.disabled
                      ? 'cursor-not-allowed text-slate-600'
                      : isActive
                        ? 'bg-white/8 text-slate-100'
                        : 'text-slate-300',
                    isSelected && 'text-cyan-300',
                  )}
                >
                  <span className="min-w-0 truncate">{opt.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden />}
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
