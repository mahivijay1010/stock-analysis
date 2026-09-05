/**
 * StockSense component library — obsidian-aurora glass on the design tokens
 * in globals.css / lib/design-tokens.ts.
 *
 * `@/components/ui` resolves here; the pre-library `ui.tsx` exports (Card,
 * Chip, SectionTitle, ScoreDonut, StatTile, ViewHero, InfoTip, EmptyState,
 * ErrorState, Skeleton, CardSkeleton, RecBadge, RiskChip, EntryChip,
 * DataStatusChip, ScoreBar, ENTRY_META, REC_TONE, RISK_TONE, EmptyGlyph)
 * all live on, API-compatible.
 */

export { GlassCard, Card, type GlassCardVariant } from './GlassCard';
export { SectionTitle } from './SectionTitle';
export { ViewHero } from './ViewHero';
export {
  Chip,
  RecBadge,
  RiskChip,
  EntryChip,
  DataStatusChip,
  ENTRY_META,
  REC_TONE,
  RISK_TONE,
  TONE_CLASSES,
  TONE_GLOW,
  type Tone,
} from './Chip';
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { Input, SearchInput, type InputProps, type SearchInputProps } from './Input';
export { Select, type SelectOption } from './Select';
export { DataTable, type DataTableColumn, type SortDir } from './DataTable';
export { Modal, Drawer } from './Modal';
export { Tooltip, InfoTip } from './Tooltip';
export { Tabs, type TabItem } from './Tabs';
export {
  ProgressBar,
  ScoreBar,
  ScoreDonut,
  GaugeH,
  type MeterTone,
  type DonutTone,
} from './Meters';
export {
  ChartFrame,
  ChartTip,
  ChartLegendKey,
  chartAxisProps,
  chartGridProps,
  chartCursor,
  chartAnimProps,
  useChartMotion,
} from './ChartFrame';
export { Collapsible } from './Collapsible';
export { AnimatedNumber } from './AnimatedNumber';
export { Sparkline, type SparklineTone } from './Sparkline';
export { StatTile } from './StatTile';
export { EmptyState, EmptyGlyph, ErrorState } from './EmptyState';
export { Skeleton, CardSkeleton, TableSkeleton, StatTileSkeleton, ChartSkeleton } from './Skeleton';
