'use client';

import { ButtonHTMLAttributes, MouseEvent, ReactNode, forwardRef } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
};

/* Every size meets the 44px touch minimum natively (the button host is
   overflow:hidden for ripple containment, which would clip a pseudo-element
   hit-area extender) — `sm` differs by density, not height. */
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-3 py-1.5 text-xs',
  md: 'min-h-11 px-4 py-2.5 text-sm',
  lg: 'min-h-12 px-5 py-3 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
  children?: ReactNode;
}

/**
 * Button — primary (cyan→violet gradient, hover sheen, click ripple),
 * secondary (glass) and ghost. The ripple is spawned as a plain DOM node and
 * self-removes on animationend; it is skipped entirely under
 * prefers-reduced-motion (and the CSS hides it as a second guard).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, children, className, onClick, type = 'button', ...rest },
  ref,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    spawnRipple(e);
    onClick?.(e);
  };

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={handleClick}
      className={clsx(VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

function spawnRipple(e: MouseEvent<HTMLButtonElement>) {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const host = e.currentTarget;
  const rect = host.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const d = Math.max(rect.width, rect.height);
  // Keyboard "clicks" report (0,0)-ish coordinates — center the ripple instead.
  const fromKeyboard = e.clientX === 0 && e.clientY === 0;
  const x = fromKeyboard ? rect.width / 2 : e.clientX - rect.left;
  const y = fromKeyboard ? rect.height / 2 : e.clientY - rect.top;
  const span = document.createElement('span');
  span.className = 'btn-ripple';
  span.style.width = `${d}px`;
  span.style.height = `${d}px`;
  span.style.left = `${x - d / 2}px`;
  span.style.top = `${y - d / 2}px`;
  span.setAttribute('aria-hidden', 'true');
  span.addEventListener('animationend', () => span.remove());
  host.appendChild(span);
}
