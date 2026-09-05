'use client';

import {
  ReactNode,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Info } from 'lucide-react';

type Side = 'top' | 'bottom' | 'left' | 'right';

const GAP = 8; // trigger ↔ panel gap (arrow lives inside it)

/**
 * Hover/focus tooltip with open delay and an arrow. Renders in a body portal
 * (fixed position) so transforms, sticky headers and overflow containers can
 * never clip it. Keyboard accessible: opens on focus (no delay), Escape
 * closes; when the trigger is a valid element it receives aria-describedby.
 * For plain-text triggers set `focusable` to add a tab stop.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  delayMs = 250,
  focusable = false,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  /** Hover open delay (focus opens immediately). */
  delayMs?: number;
  /** Add tabIndex=0 to the wrapper for non-interactive triggers. */
  focusable?: boolean;
  className?: string;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number>(0);

  const place = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    if (side === 'top') setPos({ top: r.top - GAP, left: r.left + r.width / 2 });
    else if (side === 'bottom') setPos({ top: r.bottom + GAP, left: r.left + r.width / 2 });
    else if (side === 'left') setPos({ top: r.top + r.height / 2, left: r.left - GAP });
    else setPos({ top: r.top + r.height / 2, left: r.right + GAP });
  };

  const show = (delay: number) => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      place();
      setOpen(true);
    }, delay);
  };

  const hide = () => {
    window.clearTimeout(timerRef.current);
    setOpen(false);
  };

  // Escape + scroll close (fixed position would desync on scroll).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    const onScroll = () => hide();
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const tipId = `tooltip-${uid}`;
  const trigger =
    isValidElement<{ 'aria-describedby'?: string }>(children) && typeof children.type !== 'symbol'
      ? cloneElement(children, { 'aria-describedby': open ? tipId : undefined })
      : children;

  const translate =
    side === 'top'
      ? 'translate(-50%, -100%)'
      : side === 'bottom'
        ? 'translate(-50%, 0)'
        : side === 'left'
          ? 'translate(-100%, -50%)'
          : 'translate(0, -50%)';

  const arrowClass: Record<Side, string> = {
    top: 'bottom-[-4.5px] left-1/2 -translate-x-1/2 border-t-0 border-l-0',
    bottom: 'top-[-4.5px] left-1/2 -translate-x-1/2 border-b-0 border-r-0',
    left: 'right-[-4.5px] top-1/2 -translate-y-1/2 border-b-0 border-l-0',
    right: 'left-[-4.5px] top-1/2 -translate-y-1/2 border-t-0 border-r-0',
  };

  return (
    <span
      ref={wrapRef}
      className={clsx('inline-flex', className)}
      tabIndex={focusable ? 0 : undefined}
      onMouseEnter={() => show(delayMs)}
      onMouseLeave={hide}
      onFocusCapture={() => show(0)}
      onBlurCapture={hide}
    >
      {trigger}
      {open &&
        pos != null &&
        createPortal(
          <span
            id={tipId}
            role="tooltip"
            style={{ position: 'fixed', top: pos.top, left: pos.left, transform: translate }}
            className="animate-scale-in overlay-panel z-[80] block max-w-60 px-3 py-2 text-[11px] leading-relaxed font-normal tracking-normal whitespace-normal text-slate-200 normal-case"
          >
            {content}
            <span
              aria-hidden
              className={clsx(
                'absolute h-2.5 w-2.5 rotate-45 border border-white/10 bg-[var(--surface-overlay)]',
                arrowClass[side],
              )}
            />
          </span>,
          document.body,
        )}
    </span>
  );
}

/**
 * Small ⓘ button that reveals a one-sentence explanation. Accessible:
 * a real button with aria-label + aria-expanded, popover on hover/focus
 * AND on click (touch), Escape closes. The popover renders in a body
 * portal (fixed position) so tilt transforms, sticky table headers and
 * overflow containers can never clip or overpaint it.
 */
export function InfoTip({
  label,
  text,
  align = 'left',
  className,
}: {
  /** aria-label for the button, e.g. "What does 30d hit rate mean?" */
  label: string;
  text: string;
  /** which edge of the icon the popover hugs (avoid running off-viewport) */
  align?: 'left' | 'right';
  className?: string;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: align === 'right' ? r.right : r.left });
  };

  const visible = (open || pinned) && pos != null;

  // Click-away + Escape + scroll close the popover (fixed pos would desync on scroll).
  useEffect(() => {
    if (!open && !pinned) return;
    const close = () => {
      setPinned(false);
      setOpen(false);
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [open, pinned]);

  return (
    <span
      className={clsx('relative inline-flex', className)}
      onMouseEnter={() => {
        place();
        setOpen(true);
      }}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={visible}
        aria-describedby={visible ? `infotip-${uid}` : undefined}
        onClick={() => {
          place();
          setPinned((v) => !v);
        }}
        onFocus={() => {
          place();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        className="touch-target relative rounded-full p-0.5 text-slate-500 transition-colors hover:text-cyan-300 focus-visible:text-cyan-300 focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-cyan-400"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      {visible &&
        createPortal(
          <span
            id={`infotip-${uid}`}
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: align === 'right' ? 'translateX(-100%)' : undefined,
            }}
            className="animate-scale-in overlay-panel z-[80] block w-60 rounded-lg px-3 py-2 text-left text-[11px] leading-relaxed font-normal tracking-normal whitespace-normal text-slate-300 normal-case"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
