'use client';

/**
 * DEV GALLERY — /ui-showcase
 * Renders every component of the StockSense library in all states
 * (data / loading / empty / error) plus the design-token sheet.
 * Every number on this page is FABRICATED sample data for rendering
 * demos only — nothing here is a signal, forecast or measurement,
 * except where explicitly labeled as a measured app statistic.
 */

import { useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowRight, IndianRupee, Shuffle, TrendingUp, Wallet } from 'lucide-react';
import { CHART } from '@/lib/palette';
import { COLOR, DURATION, ELEVATION, FONT_SIZE, SPACE } from '@/lib/design-tokens';
import { inr, inrSmart, plain, signedPct } from '@/lib/format';
import {
  AnimatedNumber,
  Button,
  Card,
  CardSkeleton,
  ChartFrame,
  ChartLegendKey,
  ChartSkeleton,
  ChartTip,
  Chip,
  Collapsible,
  DataStatusChip,
  DataTable,
  type DataTableColumn,
  Drawer,
  EmptyState,
  ErrorState,
  GaugeH,
  GlassCard,
  InfoTip,
  Input,
  Modal,
  ProgressBar,
  RecBadge,
  RiskChip,
  ScoreBar,
  ScoreDonut,
  SearchInput,
  SectionTitle,
  Select,
  Skeleton,
  Sparkline,
  StatTile,
  StatTileSkeleton,
  TableSkeleton,
  Tabs,
  type Tone,
  Tooltip,
  ViewHero,
  EntryChip,
  chartAxisProps,
  chartCursor,
  chartGridProps,
  useChartMotion,
} from '@/components/ui';

/* ------------------------------------------------------------------ */
/* Fabricated sample data (labeled as such on the page)                */
/* ------------------------------------------------------------------ */

interface DemoRow {
  ticker: string;
  name: string;
  price: number;
  changePct: number;
  score: number;
  rec: 'BUY' | 'HOLD' | 'AVOID';
  trend: number[];
}

const DEMO_ROWS: DemoRow[] = [
  { ticker: 'DEMOA', name: 'Demo Alpha Ltd', price: 1245.5, changePct: 1.82, score: 71, rec: 'BUY', trend: [3, 4, 3.6, 5, 5.4, 6, 6.8] },
  { ticker: 'DEMOB', name: 'Demo Beta Industries', price: 342.15, changePct: -0.64, score: 48, rec: 'HOLD', trend: [5, 4.6, 4.9, 4.2, 4.4, 4.1, 4.3] },
  { ticker: 'DEMOC', name: 'Demo Gamma Power', price: 89.9, changePct: -2.31, score: 31, rec: 'AVOID', trend: [6, 5.2, 5.5, 4.6, 4.1, 3.4, 3.0] },
  { ticker: 'DEMOD', name: 'Demo Delta Finserv', price: 2210.0, changePct: 0.4, score: 63, rec: 'BUY', trend: [2, 2.4, 2.2, 2.9, 3.3, 3.1, 3.8] },
];

const DEMO_CHART = Array.from({ length: 24 }, (_, i) => {
  const base = 100 + Math.sin(i / 3.2) * 6 + i * 0.7;
  return {
    x: i,
    close: Math.round(base * 100) / 100,
    band: i >= 16 ? ([base - (i - 15) * 1.6, base + (i - 15) * 1.9] as [number, number]) : null,
    expected: i >= 16 ? Math.round((base + (i - 15) * 0.4) * 100) / 100 : null,
  };
});

const ALL_TONES: Tone[] = ['buy', 'sell', 'wait', 'sky', 'violet', 'zinc', 'emerald', 'rose', 'amber', 'cyan'];

/* ------------------------------------------------------------------ */
/* Page scaffolding                                                    */
/* ------------------------------------------------------------------ */

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="font-display text-xl font-semibold tracking-tight text-slate-100">{title}</h2>
        {note && <p className="text-xs text-slate-500">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Swatch({ name, value, className }: { name: string; value: string; className?: string }) {
  return (
    <div className="glass-inset flex items-center gap-3 p-3">
      <span className={`h-9 w-9 shrink-0 rounded-lg border border-white/10 ${className ?? ''}`} style={!className ? { background: value } : undefined} />
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-slate-200">{name}</span>
        <span className="block truncate font-mono text-[10px] text-slate-500">{value}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chart demo (single-axis, validated CHART palette, glass tooltip)    */
/* ------------------------------------------------------------------ */

function DemoTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: (typeof DEMO_CHART)[number] }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <ChartTip>
      <p className="font-medium text-slate-300">Session {p.x + 1} (sample)</p>
      <p className="mt-1 text-sm font-semibold text-slate-100">{p.close != null ? inr(p.close) : '—'}</p>
      {p.band && (
        <p className="mt-0.5 text-slate-400">
          80% range: {inr(p.band[0])} – {inr(p.band[1])}
        </p>
      )}
    </ChartTip>
  );
}

function DemoChart() {
  const anim = useChartMotion();
  return (
    <ChartFrame
      height={240}
      ariaLabel="Sample price and forecast band chart (fabricated data)"
      title={<SectionTitle>Sample price &amp; band</SectionTitle>}
      legend={
        <>
          <ChartLegendKey kind="line" color={CHART.ink} label="History (sample)" />
          <ChartLegendKey kind="dash" color={CHART.sky} label="Expected" />
          <ChartLegendKey kind="fill" color={CHART.sky} label="80% range" />
        </>
      }
    >
      <ComposedChart data={DEMO_CHART} margin={{ top: 12, right: 16, bottom: 0, left: 4 }}>
        <CartesianGrid {...chartGridProps} />
        <XAxis type="number" dataKey="x" domain={[0, 'dataMax']} ticks={[0, 8, 16, 23]} {...chartAxisProps} />
        <YAxis domain={['auto', 'auto']} width={64} {...chartAxisProps} axisLine={false} tickFormatter={(v: number) => `₹${plain(v, 0)}`} />
        <RechartsTooltip content={<DemoTip />} cursor={chartCursor} />
        <defs>
          <linearGradient id="demo-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART.sky} stopOpacity={0.3} />
            <stop offset="100%" stopColor={CHART.sky} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <Area dataKey="band" stroke="none" fill="url(#demo-band)" {...anim} activeDot={false} />
        <Line dataKey="close" stroke={CHART.ink} strokeWidth={2} dot={false} {...anim} activeDot={{ r: 4, fill: CHART.ink, stroke: CHART.surface, strokeWidth: 2 }} />
        <Line dataKey="expected" stroke={CHART.sky} strokeWidth={2} strokeDasharray="6 4" dot={false} {...anim} activeDot={{ r: 4, fill: CHART.sky, stroke: CHART.surface, strokeWidth: 2 }} />
      </ComposedChart>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Gallery                                                             */
/* ------------------------------------------------------------------ */

export default function UiShowcasePage() {
  const [search, setSearch] = useState('');
  const [amount, setAmount] = useState('1000');
  const [strategy, setStrategy] = useState<'short' | 'long' | 'balanced' | null>('balanced');
  const [tab, setTab] = useState<'overview' | 'signals' | 'history'>('overview');
  const [pill, setPill] = useState<'1d' | '7d' | '30d'>('7d');
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSide, setDrawerSide] = useState<'right' | 'bottom'>('right');
  const [demoValue, setDemoValue] = useState(1_24_560);
  const [replay, setReplay] = useState(0);

  const columns = useMemo<Array<DataTableColumn<DemoRow>>>(
    () => [
      {
        id: 'stock',
        header: 'Stock',
        cell: (r) => (
          <span className="flex items-center gap-2">
            <span className="font-medium text-slate-100">{r.name}</span>
            <Chip tone="zinc" className="px-2 py-0.5">{r.ticker}</Chip>
          </span>
        ),
        sortValue: (r) => r.name,
      },
      { id: 'price', header: 'Price', numeric: true, cell: (r) => inr(r.price), sortValue: (r) => r.price },
      {
        id: 'change',
        header: 'Today',
        numeric: true,
        cell: (r) => (
          <span className={r.changePct >= 0 ? 'text-buy' : 'text-sell'}>{signedPct(r.changePct)}</span>
        ),
        sortValue: (r) => r.changePct,
      },
      {
        id: 'trend',
        header: 'Trend',
        cell: (r) => <Sparkline data={r.trend} tone="auto" width={88} height={26} />,
      },
      {
        id: 'score',
        header: 'Score',
        numeric: true,
        cell: (r) => <ScoreBar score={r.score} rec={r.rec} className="min-w-36" />,
        sortValue: (r) => r.score,
      },
      { id: 'rec', header: 'Verdict', cell: (r) => <RecBadge rec={r.rec} /> },
    ],
    [],
  );

  return (
    <main className="mx-auto w-full max-w-7xl space-y-10 px-4 py-10 sm:px-6">
      {/* Hero + honesty banner */}
      <ViewHero
        eyebrow="Dev gallery"
        title="UI Showcase"
        subtitle="Every component of the StockSense library in every state, rendered on the live design tokens. This is a developer route."
        right={
          <>
            <DataStatusChip status="live" />
            <Chip tone="violet">component library v1</Chip>
          </>
        }
      />
      <Card className="border-amber-400/20 p-4">
        <p className="text-sm leading-relaxed text-amber-300">
          All numbers below are fabricated sample data for component demos — not signals, forecasts or
          measurements. The only measured statistic shown is explicitly labeled (Brier gauge). Charts use the
          validated CHART palette; the buy/sell accents are status colors for chips, text and micro-trends —
          never multi-series chart colors.
        </p>
      </Card>

      {/* ------------------------------------------------------------ */}
      <Section id="tokens" title="Tokens" note="globals.css :root ↔ lib/design-tokens.ts (kept in sync)">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Swatch name="--bg-base" value={COLOR.bgBase} />
          <Swatch name="--ink-primary" value={COLOR.ink.primary} />
          <Swatch name="--ink-secondary" value={COLOR.ink.secondary} />
          <Swatch name="--ink-tertiary" value={COLOR.ink.tertiary} />
          <Swatch name="--accent-buy · text-buy" value={COLOR.accent.buy} />
          <Swatch name="--accent-sell · text-sell" value={COLOR.accent.sell} />
          <Swatch name="--accent-amber" value={COLOR.accent.amber} />
          <Swatch name="--accent-cyan" value={COLOR.accent.cyan} />
          <Swatch name="--accent-violet" value={COLOR.accent.violet} />
          <Swatch name="--gradient-info" value="cyan → violet" className="bg-gradient-to-br from-cyan-500 to-violet-600" />
          <Swatch name="--glass-bg (blur 20px)" value="rgba(255,255,255,0.05)" className="glass !rounded-lg" />
          <Swatch name="--surface-overlay" value={COLOR.surfaceOverlay} />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <SectionTitle>Elevation — elev-sm / md / lg / xl</SectionTitle>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {(Object.keys(ELEVATION) as Array<keyof typeof ELEVATION>).map((k) => (
                <div key={k} className="glass-inset flex h-20 items-center justify-center rounded-xl" style={{ boxShadow: ELEVATION[k] }}>
                  <span className="text-xs text-slate-400">elev-{k}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">Each level layers black depth + a faint accent glow.</p>
          </Card>
          <Card className="p-5">
            <SectionTitle>Spacing — 8px grid</SectionTitle>
            <div className="mt-4 space-y-2">
              {(Object.keys(SPACE) as Array<unknown> as Array<keyof typeof SPACE>).map((k) => (
                <div key={k} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 font-mono text-[10px] text-slate-500">--space-{k} · {SPACE[k]}px</span>
                  <span className="h-2 rounded-full bg-gradient-to-r from-cyan-400/70 to-violet-400/70" style={{ width: SPACE[k] * 3 }} />
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <SectionTitle>Type scale — 12→48px @ 1.25</SectionTitle>
            <div className="mt-4 space-y-2">
              {(Object.keys(FONT_SIZE) as Array<keyof typeof FONT_SIZE>).map((k) => (
                <p key={k} className="truncate text-slate-200" style={{ fontSize: FONT_SIZE[k], lineHeight: 1.25 }}>
                  <span className="font-mono text-[10px] text-slate-500">--font-size-{k} · {FONT_SIZE[k]}px&nbsp;&nbsp;</span>
                  ₹1,23,456.78 measured
                </p>
              ))}
              <p className="pt-2 text-xs text-slate-500">
                Body: <span className="font-medium text-slate-300">Inter</span> (tabular numerals globally) · Display:{' '}
                <span className="font-display font-medium text-slate-300">Space Grotesk</span> · Utilities: text-display-sm / text-display / text-display-lg
              </p>
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center justify-between gap-3">
              <SectionTitle>Motion — durations, ease, keyframes</SectionTitle>
              <Button variant="ghost" size="sm" onClick={() => setReplay((n) => n + 1)}>
                <Shuffle className="h-3.5 w-3.5" aria-hidden /> Replay
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Chip tone="sky">fast {DURATION.fast}ms</Chip>
              <Chip tone="sky">base {DURATION.base}ms</Chip>
              <Chip tone="sky">slow {DURATION.slow}ms</Chip>
              <Chip tone="zinc">cubic-bezier(0.4, 0, 0.2, 1)</Chip>
            </div>
            <div key={replay} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="animate-fade-in glass-inset flex h-16 items-center justify-center text-xs text-slate-400">fade-in</div>
              <div className="animate-slide-up glass-inset flex h-16 items-center justify-center text-xs text-slate-400">slide-up</div>
              <div className="animate-scale-in glass-inset flex h-16 items-center justify-center text-xs text-slate-400">scale-in</div>
              <div className="glass-inset flex h-16 items-center justify-center gap-2 text-xs text-slate-400">
                <span className="animate-pulse-live inline-flex h-2 w-2 rounded-full bg-buy" /> pulse-live
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-500">All decorative animation pauses under prefers-reduced-motion.</p>
          </Card>
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="cards" title="GlassCard" note="variants: base · elevated · interactive (tilt + lift + border-glow)">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <GlassCard className="p-5">
            <SectionTitle>Base</SectionTitle>
            <p className="mt-3 text-sm text-slate-400">Frosted glass, inset top highlight, elev-md shadow.</p>
          </GlassCard>
          <GlassCard variant="elevated" className="p-5">
            <SectionTitle>Elevated</SectionTitle>
            <p className="mt-3 text-sm text-slate-400">1px cyan→violet gradient border for hero content.</p>
          </GlassCard>
          <GlassCard variant="interactive" className="p-5">
            <SectionTitle>Interactive</SectionTitle>
            <p className="mt-3 text-sm text-slate-400">Hover: 3D tilt, lift and border-glow. Transform-only.</p>
          </GlassCard>
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="buttons" title="Button" note="primary (sheen + ripple) · secondary · ghost; loading; 44px targets">
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Button>
              Analyze <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="secondary">
              <Wallet className="h-4 w-4" aria-hidden /> Secondary
            </Button>
            <Button variant="ghost">Ghost</Button>
            <Button loading>Loading</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary">Small (44px hit area)</Button>
            <Button size="md" variant="secondary">Medium</Button>
            <Button size="lg" variant="secondary">Large</Button>
          </div>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="chips" title="Chip & badges" note="semantic tones incl. BUY / SELL / WAIT + legacy aliases">
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            {ALL_TONES.map((t) => (
              <Chip key={t} tone={t}>{t}</Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="buy" glow>BUY</Chip>
            <Chip tone="sell" glow>SELL</Chip>
            <Chip tone="wait" glow>WAIT</Chip>
            <RecBadge rec="BUY" />
            <RecBadge rec="HOLD" />
            <RecBadge rec="AVOID" />
            <RecBadge rec="BUY" size="lg" />
            <RiskChip risk="LOW" />
            <RiskChip risk="MEDIUM" />
            <RiskChip risk="HIGH" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <EntryChip action="BUY_TODAY" />
            <EntryChip action="WAIT" />
            <EntryChip action="AVOID_ENTRY" />
            <DataStatusChip status="live" />
            <DataStatusChip status="cached" />
            <Chip tone="zinc">NOT_AVAILABLE — probed, no free source</Chip>
          </div>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="inputs" title="Input & SearchInput" note="glass, focus glow, icon, error, hint, clear">
        <Card className="grid grid-cols-1 gap-5 p-5 md:grid-cols-2">
          <Input
            label="Amount (INR)"
            icon={<IndianRupee />}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="numeric"
            hint="Projections default to ₹1,000."
          />
          <Input
            label="With error"
            icon={<IndianRupee />}
            defaultValue="₹-50"
            error="Enter an amount between ₹1 and ₹10,00,000."
          />
          <SearchInput
            label="Search stocks"
            placeholder="Ticker or company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch('')}
          />
          <Input label="Disabled" placeholder="Unavailable" disabled />
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="select" title="Select" note="glass listbox, slide-in, full keyboard support">
        <Card className="grid grid-cols-1 gap-5 p-5 md:grid-cols-3">
          <Select
            label="Strategy"
            value={strategy}
            onChange={(v) => setStrategy(v)}
            options={[
              { value: 'short', label: 'Short-term (1–7d)' },
              { value: 'long', label: 'Long-term (15–30d)' },
              { value: 'balanced', label: 'Balanced' },
            ]}
          />
          <Select
            label="With disabled option"
            value={null}
            onChange={() => {}}
            placeholder="Pick a horizon…"
            options={[
              { value: '1', label: '1 day' },
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days (locked)', disabled: true },
            ]}
          />
          <Select label="Disabled" value={null} onChange={() => {}} options={[{ value: 'x', label: 'n/a' }]} disabled />
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="tabs" title="Tabs" note="underline & pill — animated framer-motion layoutId indicator">
        <Card className="space-y-6 p-5">
          <Tabs
            ariaLabel="Demo sections"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'overview', label: 'Overview' },
              { value: 'signals', label: 'Signals' },
              { value: 'history', label: 'History' },
            ]}
          />
          <div className="flex flex-wrap items-center gap-4">
            <Tabs
              variant="pill"
              ariaLabel="Demo horizon"
              value={pill}
              onChange={setPill}
              items={[
                { value: '1d', label: '1d' },
                { value: '7d', label: '7d' },
                { value: '30d', label: '30d' },
              ]}
            />
            <p className="text-xs text-slate-500">selected: {tab} · {pill}</p>
          </div>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="overlay" title="Tooltip, InfoTip, Modal & Drawer" note="portals, focus trap, Escape, backdrop blur">
        <Card className="flex flex-wrap items-center gap-4 p-5">
          <Tooltip content="Tooltips open on hover after a short delay — instantly on keyboard focus." side="top">
            <Button variant="secondary" size="sm">Tooltip top</Button>
          </Tooltip>
          <Tooltip content="Bottom placement." side="bottom">
            <Button variant="secondary" size="sm">bottom</Button>
          </Tooltip>
          <Tooltip content="Right placement." side="right">
            <Button variant="secondary" size="sm">right</Button>
          </Tooltip>
          <Tooltip content="Plain text can be a trigger too — focusable adds a tab stop." focusable>
            <span className="text-sm text-slate-300 underline decoration-dotted underline-offset-4">plain-text trigger</span>
          </Tooltip>
          <span className="inline-flex items-center gap-1 text-sm text-slate-300">
            80% band coverage
            <InfoTip label="What does band coverage mean?" text="How often the actual price landed inside the predicted 80% range — measured out-of-sample, target is 80%." />
          </span>
          <Button onClick={() => setModalOpen(true)}>Open Modal</Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDrawerSide('right');
              setDrawerOpen(true);
            }}
          >
            Drawer right
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDrawerSide('bottom');
              setDrawerOpen(true);
            }}
          >
            Drawer bottom
          </Button>
        </Card>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Confirm paper trade (demo)"
          footer={
            <>
              <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button onClick={() => setModalOpen(false)}>Confirm</Button>
            </>
          }
        >
          <p>
            This is a demo dialog. Focus is trapped, <kbd className="rounded bg-white/10 px-1">Esc</kbd> closes, the
            backdrop blurs, and focus returns to the trigger on close.
          </p>
          <p className="mt-3 text-slate-400">
            Paper fills have zero slippage — live results will be worse by fees + slippage.
          </p>
        </Modal>

        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} side={drawerSide} title="Position details (demo)">
          <div className="space-y-3">
            <StatTile label="Invested (sample)" value={inrSmart(24_910)} sub="20 shares @ ₹1,245.50" />
            <StatTile label="Unrealized P&L (sample)" value={<span className="text-buy">+₹1,254</span>} sub="+5.03%" />
            <EmptyState title="No notes yet" message="Notes you add to a position would appear here." />
          </div>
        </Drawer>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="table" title="DataTable" note="sticky glass header, aria-sort, hover accent, expandable rows">
        <Card className="p-0">
          <DataTable
            ariaLabel="Sample stocks table"
            columns={columns}
            rows={DEMO_ROWS}
            rowKey={(r) => r.ticker}
            initialSort={{ id: 'score', dir: 'desc' }}
            renderExpanded={(r) => (
              <div className="flex flex-wrap items-center gap-4 text-sm text-slate-400">
                <ScoreDonut score={r.score} tone={r.rec} size={56} />
                <p className="max-w-md">
                  Expanded detail row for {r.name} — any content, height-animated. Sample sentence, not a signal.
                </p>
                <Button variant="secondary" size="sm">
                  Full analysis <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            )}
          />
        </Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="p-4">
            <p className="mb-3 text-xs text-slate-500">loading</p>
            <DataTable ariaLabel="Loading table demo" columns={columns} rows={[]} rowKey={(r: DemoRow) => r.ticker} loading loadingRows={3} />
          </Card>
          <Card className="p-4">
            <p className="mb-3 text-xs text-slate-500">empty</p>
            <DataTable
              ariaLabel="Empty table demo"
              columns={columns}
              rows={[]}
              rowKey={(r: DemoRow) => r.ticker}
              empty={<EmptyState glyph="radar" title="No qualifying rows" message="Nothing clears the thresholds — that honesty is the feature." />}
            />
          </Card>
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="meters" title="Meters" note="ProgressBar · ScoreBar · ScoreDonut · GaugeH">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="space-y-5 p-5">
            <ProgressBar label="Buy tone" value={72} tone="buy" />
            <ProgressBar label="Sell tone" value={31} tone="sell" />
            <ProgressBar label="Amber tone" value={55} tone="amber" />
            <ProgressBar label="Info gradient" value={64} />
            <ProgressBar label="Small" value={48} size="sm" />
            <div className="pt-1">
              <p className="mb-2 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">ScoreBar (legacy)</p>
              <ScoreBar score={71} rec="BUY" />
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-6">
              <ScoreDonut score={78} tone="BUY" label="quant" />
              <ScoreDonut score={52} tone="HOLD" label="master" />
              <ScoreDonut score={24} tone="AVOID" label="entry" />
              <ScoreDonut score={64} label="neutral" />
              <ScoreDonut score={64} size={44} />
            </div>
            <div className="mt-6 space-y-5">
              <GaugeH
                label="Brier score (measured, app-wide)"
                value={0.2525}
                min={0.2}
                max={0.3}
                benchmark={0.25}
                benchmarkLabel="coin flip 0.25"
                lowerIsBetter
                format={(v) => plain(v, 4)}
              />
              <p className="-mt-3 text-xs text-slate-500">
                Honest by design: the measured ≈0.2525 sits on the worse side of the coin-flip line, so the fill
                reads sell-side. Lower is better.
              </p>
              <GaugeH
                label="80% band coverage (measured)"
                value={85}
                min={0}
                max={100}
                benchmark={80}
                benchmarkLabel="target 80"
                format={(v) => `${plain(v, 0)}%`}
              />
            </div>
          </Card>
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="chart" title="ChartFrame" note="Recharts shell: token axes/grid, glass tooltip, reduced-motion aware">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <DemoChart />
          </Card>
          <div className="space-y-4">
            <Card className="p-5">
              <p className="mb-3 text-xs text-slate-500">loading</p>
              <ChartSkeleton height={104} />
            </Card>
            <Card className="p-5">
              <p className="mb-3 text-xs text-slate-500">empty</p>
              <EmptyState glyph="radar" title="Not enough history" message="Fewer than 2 sessions of data — nothing honest to draw." />
            </Card>
            <ErrorState compact message="Chart data failed to load (demo)." onRetry={() => {}} />
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="collapsible" title="Collapsible" note="height-animated, chevron, open state persists per id in localStorage">
        <Card className="space-y-2 p-5">
          <Collapsible id="showcase-demo-a" title="Why this verdict?" subtitle="persists as stocksense.collapse.showcase-demo-a" right={<Chip tone="sky">3 reasons</Chip>} defaultOpen>
            <ul className="space-y-1.5 text-sm text-slate-400">
              <li>• Sample reason one — momentum positive over 20 sessions.</li>
              <li>• Sample reason two — volume above the 30-day average.</li>
              <li>• Sample reason three — sector breadth improving.</li>
            </ul>
          </Collapsible>
          <div className="border-t border-white/6 pt-2">
            <Collapsible id="showcase-demo-b" title="Fees & caveats (never hidden by default in real views)">
              <p className="text-sm text-slate-400">
                Indian delivery round trip on ₹1,000 ≈ 2% in fees — small trades need bigger moves to break even.
              </p>
            </Collapsible>
          </div>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="numbers" title="AnimatedNumber & Sparkline" note="rAF tween, tabular numerals · tiny SVG trends">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="p-5">
            <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">Portfolio value (sample)</p>
            <p className="font-display mt-2 text-display-sm font-semibold text-slate-100">
              <AnimatedNumber value={demoValue} format={(v) => inrSmart(v)} />
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-4"
              onClick={() => setDemoValue(80_000 + Math.round(Math.random() * 90_000))}
            >
              <Shuffle className="h-3.5 w-3.5" aria-hidden /> Randomize
            </Button>
          </Card>
          <Card className="flex flex-wrap items-center gap-6 p-5">
            <div>
              <p className="mb-1 text-xs text-slate-500">auto (up)</p>
              <Sparkline data={[2, 3, 2.6, 3.8, 4.2, 5]} tone="auto" />
            </div>
            <div>
              <p className="mb-1 text-xs text-slate-500">auto (down)</p>
              <Sparkline data={[5, 4.4, 4.6, 3.4, 3, 2.2]} tone="auto" />
            </div>
            <div>
              <p className="mb-1 text-xs text-slate-500">info</p>
              <Sparkline data={[3, 3.4, 3.1, 3.9, 3.6, 4.4]} tone="info" />
            </div>
            <div>
              <p className="mb-1 text-xs text-slate-500">no fill</p>
              <Sparkline data={[3, 2.4, 3.3, 2.8, 3.9, 4.1]} tone="buy" fill={false} />
            </div>
            <div>
              <p className="mb-1 text-xs text-slate-500">single point</p>
              <Sparkline data={[3]} tone="info" />
            </div>
          </Card>
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="tiles" title="StatTile & ViewHero" note="tilt option, InfoTip slot, sparkline slot">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Universe" value="151" sub="live-verified NSE tickers" />
          <StatTile
            label="Direction hit rate"
            value="50–51.5%"
            sub="a coin flip — measured, ~39k samples"
            info={<InfoTip label="Why show a coin flip?" text="Because that is the measured truth — no model in the pool beats it. The bands, not direction, are the product." />}
            tilt
          />
          <StatTile label="Equity (sample)" value={inrSmart(1_04_320)} sub={<span className="text-buy">+4.3% this month</span>} spark={[1, 1.4, 1.2, 1.8, 2.1, 2.6]} tilt />
          <StatTileSkeleton />
        </div>
        <Card className="p-6">
          <ViewHero
            eyebrow="Section hero"
            title="Every view opens like this"
            subtitle="Gradient display title, one honest subtitle, live context chips on the right, conic ring behind."
            right={
              <>
                <Chip tone="sky">scanned 151 / 151</Chip>
                <DataStatusChip status="cached" />
              </>
            }
          />
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section id="states" title="Empty, error & loading states" note="honest NOT_AVAILABLE moments — never hidden or shrunk">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="space-y-4 p-5">
            <EmptyState title="No qualifying picks right now" message="Nothing clears the score and risk thresholds today. That honesty is the feature." />
            <EmptyState
              glyph="radar"
              title="Options skew NOT_AVAILABLE"
              message="NSE option-chain endpoints are Akamai-blocked (measured 403). Shown with evidence, never faked."
            />
          </Card>
          <div className="space-y-4">
            <ErrorState message="The backend did not respond (demo). Retry keeps the last good data visible." onRetry={() => {}} compact />
            <Card className="space-y-3 p-5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <CardSkeleton lines={3} />
          <Card className="p-5">
            <p className="mb-3 text-xs text-slate-500">TableSkeleton</p>
            <TableSkeleton rows={3} cols={4} />
          </Card>
          <Card className="p-5">
            <p className="mb-3 text-xs text-slate-500">ChartSkeleton</p>
            <ChartSkeleton height={96} />
          </Card>
        </div>
      </Section>

      <footer className="border-t border-white/6 pt-6 pb-10 text-xs leading-relaxed text-slate-500">
        <p>
          Dev-only gallery at /ui-showcase · sample data throughout · tokens live in globals.css + lib/design-tokens.ts ·
          components in components/ui/* (barrel: @/components/ui).{' '}
          <TrendingUp className="inline h-3.5 w-3.5 text-cyan-400" aria-hidden /> StockSense India.
        </p>
      </footer>
    </main>
  );
}
