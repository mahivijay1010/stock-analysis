'use client';

import { ReactNode, RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { X } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Shared dialog plumbing                                              */
/* ------------------------------------------------------------------ */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focus trap + Escape + body scroll lock + focus restore. */
function useDialog(panelRef: RefObject<HTMLDivElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    const focusables = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent != null) : [];

    const raf = requestAnimationFrame(() => {
      (focusables()[0] ?? panel)?.focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) {
        e.preventDefault();
        panel?.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [open, onClose, panelRef]);
}

/** Portal that only renders after mount (SSR-safe). */
function BodyPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
    >
      {children}
    </motion.div>
  );
}

function DialogHeader({ id, title, onClose }: { id: string; title: ReactNode; onClose: () => void }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <h2 id={id} className="font-display min-w-0 text-lg font-semibold tracking-tight text-slate-100">
        {title}
      </h2>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="touch-target relative -mt-1 -mr-1 shrink-0 rounded-full p-1.5 text-slate-400 transition-colors hover:bg-white/8 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-cyan-400/70"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

const MODAL_WIDTH = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

/**
 * Centered dialog on a blurred backdrop: slide-up + scale entrance, focus
 * trap, Escape / backdrop-click close, body scroll lock, focus restore.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Right-aligned action row (Buttons). */
  footer?: ReactNode;
  size?: keyof typeof MODAL_WIDTH;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, open, onClose);

  return (
    <BodyPortal>
      <AnimatePresence>
        {open && (
          <Overlay onClose={onClose}>
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-title"
              tabIndex={-1}
              initial={{ opacity: 0, y: 24, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.98 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className={clsx(
                'overlay-panel w-full rounded-2xl p-5 outline-none sm:p-6',
                MODAL_WIDTH[size],
                className,
              )}
            >
              <DialogHeader id="modal-title" title={title} onClose={onClose} />
              <div className="thin-scroll max-h-[65vh] overflow-y-auto text-sm text-slate-300">{children}</div>
              {footer != null && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
            </motion.div>
          </Overlay>
        )}
      </AnimatePresence>
    </BodyPortal>
  );
}

/* ------------------------------------------------------------------ */
/* Drawer                                                              */
/* ------------------------------------------------------------------ */

/**
 * Edge-anchored dialog: slides in from the right (or bottom on request),
 * same a11y plumbing as Modal. Good for dense detail panes.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  side = 'right',
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  side?: 'right' | 'bottom';
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, open, onClose);

  const fromRight = side === 'right';

  return (
    <BodyPortal>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
            className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="drawer-title"
              tabIndex={-1}
              initial={fromRight ? { x: '100%' } : { y: '100%' }}
              animate={fromRight ? { x: 0 } : { y: 0 }}
              exit={fromRight ? { x: '100%' } : { y: '100%' }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
              className={clsx(
                'overlay-panel absolute flex flex-col p-5 outline-none sm:p-6',
                fromRight
                  ? 'inset-y-0 right-0 w-full max-w-md rounded-none rounded-l-2xl'
                  : 'inset-x-0 bottom-0 max-h-[85vh] rounded-none rounded-t-2xl',
                className,
              )}
            >
              <DialogHeader id="drawer-title" title={title} onClose={onClose} />
              <div className="thin-scroll min-h-0 flex-1 overflow-y-auto text-sm text-slate-300">{children}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </BodyPortal>
  );
}
