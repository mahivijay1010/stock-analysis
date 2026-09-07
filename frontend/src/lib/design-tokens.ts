/**
 * Design tokens — TypeScript mirror of the CSS custom properties declared in
 * src/app/globals.css `:root`. Single source of truth is the CSS; keep both
 * in sync. Import these when a token is needed in JS (SVG fills, Recharts
 * props, framer-motion transitions) instead of hardcoding hex values.
 */

/* ------------------------------- color ------------------------------- */

export const COLOR = {
  /** Obsidian page base (`--bg-base`). */
  bgBase: '#0D0B10',
  /** Opaque inner surface for medallions / donut holes (`--surface-solid`). */
  surfaceSolid: '#19141E',
  /** Popover/modal/dropdown surface (`--surface-overlay`). */
  surfaceOverlay: 'rgba(22, 17, 27, 0.96)',

  ink: {
    /** `--ink-primary` — headings, values. */
    primary: '#F7F3ED',
    /** `--ink-secondary` — body copy, captions. */
    secondary: '#B5ACBA',
    /** `--ink-tertiary` — hints, deemphasis. */
    tertiary: '#746B7B',
  },

  accent: {
    /** BUY / gain / live (`--accent-buy`). Tailwind: text-buy, bg-buy/10, border-buy/30. */
    buy: '#46CE9E',
    /** SELL / AVOID / loss (`--accent-sell`). Tailwind: text-sell, bg-sell/10, border-sell/30. */
    sell: '#F07187',
    /** HOLD / WAIT / caution (`--accent-amber`) — same as Tailwind amber-400. */
    amber: '#E4B364',
    /** Info pair A — interactive/selected (`--accent-cyan`) — cyan-400. */
    cyan: '#D9A85F',
    /** Info pair B — highlights (`--accent-violet`) — violet-400. */
    violet: '#A98BE8',
  },

  /** Cyan→violet CTA gradient (`--gradient-info`). */
  gradientInfo: 'linear-gradient(135deg, #D9A85F, #A98BE8)',
} as const;

/* ------------------------------- glass ------------------------------- */

export const GLASS = {
  /** `--glass-bg` */
  bg: 'rgba(24, 19, 28, 0.78)',
  /** `--glass-border` */
  border: 'rgba(255, 255, 255, 0.08)',
  /** `--glass-highlight` — inset top edge */
  highlight: 'rgba(255, 255, 255, 0.08)',
  /** `--glass-blur` */
  blur: '20px',
} as const;

/* ----------------------------- elevation ----------------------------- */

/** `--elev-sm/md/lg/xl` — layered black shadow + faint accent glow.
 *  Tailwind utilities: shadow-elev-sm … shadow-elev-xl; classes .elev-*. */
export const ELEVATION = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.35), 0 2px 8px -4px rgba(0, 0, 0, 0.4), 0 0 12px -8px rgba(34, 211, 238, 0.1)',
  md: '0 2px 6px rgba(0, 0, 0, 0.35), 0 8px 24px -12px rgba(0, 0, 0, 0.55), 0 0 20px -10px rgba(34, 211, 238, 0.12)',
  lg: '0 4px 12px rgba(0, 0, 0, 0.4), 0 16px 44px -16px rgba(0, 0, 0, 0.65), 0 0 32px -12px rgba(124, 58, 237, 0.14)',
  xl: '0 8px 20px rgba(0, 0, 0, 0.45), 0 28px 68px -20px rgba(0, 0, 0, 0.75), 0 0 48px -14px rgba(124, 58, 237, 0.18)',
} as const;

/* ------------------------------ spacing ------------------------------ */

/** 8px grid (`--space-1..8`), values in px. */
export const SPACE = {
  1: 8,
  2: 16,
  3: 24,
  4: 32,
  5: 40,
  6: 48,
  7: 56,
  8: 64,
} as const;

/* ------------------------------- type -------------------------------- */

/** 12→48px modular scale at ratio 1.25, quarter-rem rounded
 *  (`--font-size-xs..3xl`), values in px.
 *  Display sizes also exist as Tailwind utilities:
 *  text-display-sm (30), text-display (38), text-display-lg (48). */
export const FONT_SIZE = {
  xs: 12,
  sm: 15,
  md: 19,
  lg: 24,
  xl: 30,
  '2xl': 38,
  '3xl': 48,
} as const;

export const FONT_FAMILY = {
  /** Body — Inter (var(--font-inter) → --font-sans). */
  sans: 'var(--font-inter)',
  /** Display — Space Grotesk: headings, tab labels, big numbers. */
  display: 'var(--font-space-grotesk)',
  mono: 'var(--font-geist-mono)',
} as const;

/* ------------------------------- radii ------------------------------- */

/** `--radius-sm/md/lg/xl`, values in px. */
export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

/* ------------------------------- motion ------------------------------ */

/** `--duration-fast/base/slow`, in ms. Divide by 1000 for framer-motion. */
export const DURATION = {
  fast: 150,
  base: 300,
  slow: 500,
} as const;

export const EASE = {
  /** `--ease-standard` — everything by default. */
  standard: [0.4, 0, 0.2, 1] as const,
  standardCss: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** `--ease-spring` — settle/overshoot feel (donut sweep, tilt release). */
  spring: [0.22, 1, 0.36, 1] as const,
  springCss: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

/** Named keyframes declared in globals.css (also Tailwind animate-* utilities). */
export const KEYFRAMES = ['fade-in', 'slide-up', 'scale-in', 'pulse-live'] as const;

/* ------------------------------ z-index ------------------------------ */

/** Shared stacking contract (matches component library + existing chrome). */
export const Z_INDEX = {
  backdrop: 0,
  content: 10,
  header: 40,
  dropdown: 50,
  modal: 70,
  tooltip: 80,
} as const;

export const DESIGN_TOKENS = {
  color: COLOR,
  glass: GLASS,
  elevation: ELEVATION,
  space: SPACE,
  fontSize: FONT_SIZE,
  fontFamily: FONT_FAMILY,
  radius: RADIUS,
  duration: DURATION,
  ease: EASE,
  keyframes: KEYFRAMES,
  zIndex: Z_INDEX,
} as const;

export type DesignTokens = typeof DESIGN_TOKENS;
