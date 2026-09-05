'use client';

import { InputHTMLAttributes, ReactNode, forwardRef, useId } from 'react';
import clsx from 'clsx';
import { Search, X } from 'lucide-react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Optional field label rendered above the input. */
  label?: ReactNode;
  /** Optional leading icon — lights up cyan on focus. */
  icon?: ReactNode;
  /** Optional trailing node (clear button, unit chip) inside the field, right-aligned. */
  trailing?: ReactNode;
  /** Error message — turns the border rose and is announced via aria-describedby. */
  error?: string;
  /** Muted helper line under the input (suppressed while `error` is shown). */
  hint?: string;
  /** Class for the outer wrapper (width control); `className` styles the input itself. */
  wrapClassName?: string;
}

/**
 * Glass input with focus glow, optional label, leading icon, trailing slot,
 * hint and error state. Padding defaults keep a comfortable ≥44px touch
 * target; pass `className` to tighten for dense layouts.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, icon, trailing, error, hint, wrapClassName, className, id, ...rest },
  ref,
) {
  const uid = useId();
  const inputId = id ?? `input-${uid}`;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className={wrapClassName}>
      {label != null && (
        <label
          htmlFor={inputId}
          className="mb-1.5 block text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase"
        >
          {label}
        </label>
      )}
      <div className="input-wrap relative">
        {icon != null && (
          <span
            aria-hidden
            className="input-icon pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500 [&>svg]:h-4 [&>svg]:w-4"
          >
            {icon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={clsx(
            'input-glass py-2.5 text-sm',
            icon != null ? 'pl-9' : 'pl-3',
            trailing != null ? 'pr-10' : 'pr-3',
            className,
          )}
          {...rest}
        />
        {trailing != null && <span className="absolute top-1/2 right-2 -translate-y-1/2">{trailing}</span>}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="mt-1.5 text-xs text-sell">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

export interface SearchInputProps extends Omit<InputProps, 'icon' | 'trailing'> {
  /** Renders an ✕ clear button when the input has a value. */
  onClear?: () => void;
}

/**
 * Search variant: magnifier icon, focus glow, and an optional clear button
 * (shown when `onClear` is provided and the input has a value). Escape clears.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { onClear, value, onKeyDown, ...rest },
  ref,
) {
  const showClear = onClear != null && value != null && String(value).length > 0;
  return (
    <Input
      ref={ref}
      icon={<Search />}
      value={value}
      trailing={
        showClear ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={onClear}
            className="touch-target relative rounded-full p-1 text-slate-500 transition-colors hover:text-slate-200 focus-visible:text-cyan-300 focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-cyan-400"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : undefined
      }
      onKeyDown={(e) => {
        if (e.key === 'Escape' && showClear) {
          e.preventDefault();
          onClear();
        }
        onKeyDown?.(e);
      }}
      {...rest}
    />
  );
});
