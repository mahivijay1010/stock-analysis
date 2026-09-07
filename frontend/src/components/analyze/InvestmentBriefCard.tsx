'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, BookOpenText, Check, Copy, FileText, Info } from 'lucide-react';
import { ApiError, getResearchBrief } from '@/lib/api';
import type { ResearchBrief } from '@/lib/types';
import { pct, signedPct } from '@/lib/format';
import { Button, Card, Chip, Drawer, EmptyState, ErrorState, Skeleton } from '@/components/ui';

/* ------------------------------------------------------------------ */
/* Tone maps — verdict fields arrive as plain strings (spec C3),       */
/* so map known values and fall back to neutral instead of crashing.   */
/* ------------------------------------------------------------------ */

type Tone = 'buy' | 'sell' | 'wait' | 'zinc';

const REC_TONES: Record<string, Tone> = { BUY: 'buy', HOLD: 'wait', AVOID: 'sell' };
const ENTRY_TONES: Record<string, Tone> = { BUY_TODAY: 'buy', WAIT: 'wait', AVOID_ENTRY: 'sell' };
const RISK_TONES: Record<string, Tone> = { LOW: 'buy', MEDIUM: 'wait', HIGH: 'sell' };

function toneOf(map: Record<string, Tone>, key: string | undefined | null): Tone {
  return (key && map[key]) || 'zinc';
}

/** Deterministic paragraphs — the backend separates them with blank lines. */
function splitParagraphs(thesis: string | undefined | null): string[] {
  return (thesis ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Clean plain-text export (spec C4.2 copy-to-clipboard)               */
/* ------------------------------------------------------------------ */

function briefToPlainText(b: ResearchBrief): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);
  const section = (title: string) => {
    push();
    push(title.toUpperCase());
  };

  push(`INVESTMENT BRIEF — ${b.name ?? b.ticker} (${b.ticker})`);
  push(`Sector: ${b.sector ?? 'n/a'} · Generated: ${b.generatedAt ?? 'n/a'}`);

  const v = b.verdict;
  if (v) {
    section('Verdict');
    push(`${v.recommendation ?? 'n/a'} · Entry: ${v.entryAction ?? 'n/a'} · Risk: ${v.riskLevel ?? 'n/a'}`);
    push(
      `Quant score ${Math.round(v.quantScore ?? 0)}/100 · Master score ${
        v.masterScore != null ? `${Math.round(v.masterScore)}/100` : 'n/a'
      } · Timing ${Math.round(v.timingScore ?? 0)}/100`,
    );
  }

  if (b.thesis) {
    section('Thesis');
    splitParagraphs(b.thesis).forEach((p, i) => {
      if (i > 0) push();
      push(p);
    });
  }

  if (b.bullCase?.length) {
    section('Bull case');
    b.bullCase.forEach((s) => push(`+ ${s}`));
  }
  if (b.bearCase?.length) {
    section('Bear case');
    b.bearCase.forEach((s) => push(`- ${s}`));
  }

  if (b.keyNumbers?.length) {
    section('Key numbers');
    b.keyNumbers.forEach((k) => push(`${k.label}: ${k.value}`));
  }

  if (b.forecast?.length) {
    section('Forecast (80% ranges)');
    b.forecast.forEach((f) =>
      push(
        `${f.horizonDays}d: expected ${signedPct(f.expectedPct)} (range ${signedPct(f.low80Pct)} to ${signedPct(
          f.high80Pct,
        )}), freq(up) ${Math.round((f.pop ?? 0) * 100)}%`,
      ),
    );
  }

  const engine = b.predictionEngine ?? b.modelUsed;
  if (engine) {
    section('Prediction engine');
    push(engine);
  }

  if (b.newsContext) {
    section('News context');
    push(b.newsContext);
  }

  if (b.risks?.length) {
    section('Risks');
    b.risks.forEach((r) => push(`! ${r}`));
  }

  if (b.accuracyContext) {
    section('Accuracy context');
    push(b.accuracyContext);
  }

  if (b.disclaimer) {
    section('Disclaimer');
    push(b.disclaimer);
  }

  return lines.join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Document body                                                       */
/* ------------------------------------------------------------------ */

function BriefHeading({ children }: { children: string }) {
  return (
    <h4 className="font-display text-sm font-semibold tracking-[0.12em] text-slate-300 uppercase">{children}</h4>
  );
}

function CaseColumn({ title, items, tone }: { title: string; items: string[]; tone: 'buy' | 'sell' }) {
  const glyph = tone === 'buy' ? '+' : '−';
  return (
    <div
      className={clsx(
        'rounded-xl border p-4',
        tone === 'buy' ? 'border-buy/20 bg-buy/5' : 'border-sell/20 bg-sell/5',
      )}
    >
      <h4
        className={clsx(
          'font-display text-sm font-semibold tracking-[0.12em] uppercase',
          tone === 'buy' ? 'text-buy' : 'text-sell',
        )}
      >
        {title}
      </h4>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Nothing notable.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-slate-300">
              <span
                aria-hidden
                className={clsx(
                  'mt-px w-3 shrink-0 text-center font-semibold',
                  tone === 'buy' ? 'text-buy' : 'text-sell',
                )}
              >
                {glyph}
              </span>
              <span className="min-w-0">{s}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BriefDocument({ brief }: { brief: ResearchBrief }) {
  const [copied, setCopied] = useState(false);
  const paragraphs = splitParagraphs(brief.thesis);
  const v = brief.verdict;

  async function onCopy() {
    const ok = await copyText(briefToPlainText(brief));
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <article className="space-y-6">
      {/* Document masthead + copy */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold tracking-tight text-slate-100">
            {brief.name ?? brief.ticker}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {brief.ticker}
            {brief.sector ? ` · ${brief.sector}` : ''} · generated from one deterministic analysis — every number is
            real, nothing is invented
          </p>
        </div>
        <button type="button" onClick={onCopy} className="btn-secondary shrink-0 px-3 py-1.5 text-xs" aria-live="polite">
          {copied ? <Check className="h-3.5 w-3.5 text-buy" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy as text'}
        </button>
      </div>

      {/* Verdict strip */}
      {v && (
        <div className="glass-inset flex flex-wrap items-center gap-2.5 px-4 py-3">
          <Chip tone={toneOf(REC_TONES, v.recommendation)} glow>
            {v.recommendation}
          </Chip>
          <Chip tone={toneOf(ENTRY_TONES, v.entryAction)}>{(v.entryAction ?? '').replaceAll('_', ' ')}</Chip>
          <Chip tone={toneOf(RISK_TONES, v.riskLevel)}>{v.riskLevel} RISK</Chip>
          <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400 tabular-nums">
            <span>
              Quant <span className="font-semibold text-slate-200">{Math.round(v.quantScore ?? 0)}</span>/100
            </span>
            <span>
              Master{' '}
              {v.masterScore != null ? (
                <>
                  <span className="font-semibold text-slate-200">{Math.round(v.masterScore)}</span>/100
                </>
              ) : (
                <span className="text-slate-600">n/a</span>
              )}
            </span>
            <span>
              Timing <span className="font-semibold text-slate-200">{Math.round(v.timingScore ?? 0)}</span>/100
            </span>
          </span>
        </div>
      )}

      {/* Thesis */}
      {paragraphs.length > 0 && (
        <section>
          <BriefHeading>Thesis</BriefHeading>
          <div className="mt-2 max-w-prose space-y-3">
            {paragraphs.map((p, i) => (
              <p key={i} className="text-sm leading-7 text-slate-300">
                {p}
              </p>
            ))}
          </div>
        </section>
      )}

      {/* Bull / bear columns */}
      {((brief.bullCase?.length ?? 0) > 0 || (brief.bearCase?.length ?? 0) > 0) && (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CaseColumn title="Bull case" items={brief.bullCase ?? []} tone="buy" />
          <CaseColumn title="Bear case" items={brief.bearCase ?? []} tone="sell" />
        </section>
      )}

      {/* Key numbers grid */}
      {(brief.keyNumbers?.length ?? 0) > 0 && (
        <section>
          <BriefHeading>Key numbers</BriefHeading>
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(brief.keyNumbers ?? []).map((k, i) => (
              <div key={`${k.label}-${i}`} className="glass-inset px-3 py-2">
                <dt className="truncate text-[11px] text-slate-500" title={k.label}>
                  {k.label}
                </dt>
                <dd className="font-display mt-0.5 text-sm font-semibold text-slate-100 tabular-nums">{k.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* Forecast mini-table */}
      {(brief.forecast?.length ?? 0) > 0 && (
        <section>
          <BriefHeading>Forecast</BriefHeading>
          <div className="thin-scroll mt-2 overflow-x-auto rounded-xl border border-white/6">
            <table className="table-premium min-w-[420px]">
              <thead>
                <tr>
                  <th>Horizon</th>
                  <th className="num">Expected</th>
                  <th className="num">80% range</th>
                  <th className="num" title="Scenario frequency / model odds — uncalibrated">freq(up)</th>
                </tr>
              </thead>
              <tbody>
                {(brief.forecast ?? []).map((f) => (
                  <tr key={f.horizonDays}>
                    <td className="font-medium text-slate-100">{f.horizonDays}d</td>
                    <td
                      className={clsx(
                        'num font-medium tabular-nums',
                        f.expectedPct > 0 ? 'text-buy' : f.expectedPct < 0 ? 'text-sell' : 'text-slate-300',
                      )}
                    >
                      {signedPct(f.expectedPct)}
                    </td>
                    <td className="num text-slate-400 tabular-nums">
                      {signedPct(f.low80Pct)} … {signedPct(f.high80Pct)}
                    </td>
                    <td className="num text-slate-200 tabular-nums">{pct((f.pop ?? 0) * 100, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* V7 — prediction engine line (best model, its 90d Brier, blend note) */}
      {(brief.predictionEngine ?? brief.modelUsed) && (
        <section>
          <BriefHeading>Prediction engine</BriefHeading>
          <p className="mt-2 max-w-prose text-sm leading-7 text-slate-300">
            {brief.predictionEngine ?? brief.modelUsed}
          </p>
        </section>
      )}

      {/* News context */}
      {brief.newsContext && (
        <section>
          <BriefHeading>News context</BriefHeading>
          <p className="mt-2 max-w-prose text-sm leading-7 text-slate-300">{brief.newsContext}</p>
        </section>
      )}

      {/* Risks */}
      {(brief.risks?.length ?? 0) > 0 && (
        <section>
          <BriefHeading>Risks</BriefHeading>
          <ul className="mt-2 space-y-1.5">
            {(brief.risks ?? []).map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-slate-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
                <span className="min-w-0">{r}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Accuracy context */}
      {brief.accuracyContext && (
        <section>
          <BriefHeading>Accuracy context</BriefHeading>
          <p className="mt-2 max-w-prose text-sm leading-7 text-slate-400">{brief.accuracyContext}</p>
        </section>
      )}

      {/* Disclaimer */}
      {brief.disclaimer && (
        <div className="flex items-start gap-2 border-t border-white/8 pt-4 text-xs leading-relaxed text-slate-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <p>{brief.disclaimer}</p>
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Drawer trigger card                                                 */
/* ------------------------------------------------------------------ */

/**
 * V6 — "Investment brief" (SPEC_CALIBRATION.md C4.2): a deterministic,
 * document-styled analyst note composed by the backend from one analysis.
 * Now a button-triggered Drawer: the document renders only on demand and the
 * brief is lazily fetched the first time the drawer opens. Mount with
 * key={ticker} so the open state and query never bleed between stocks.
 */
export function InvestmentBriefCard({ ticker }: { ticker: string }) {
  const [open, setOpen] = useState(false);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['research', ticker],
    queryFn: () => getResearchBrief(ticker),
    enabled: open, // lazy — only fetch once the reader opens the drawer
    staleTime: 5 * 60_000,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  const is404 = isError && error instanceof ApiError && error.status === 404;

  return (
    <>
      <Card elevated className="flex flex-wrap items-center gap-3 p-5 sm:gap-4 sm:p-6">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.18)]"
        >
          <FileText className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold tracking-tight text-slate-100">Investment brief</p>
          <p className="text-xs text-slate-500">
            A deterministic analyst-style note built only from this analysis&apos;s real numbers — nothing generated,
            nothing invented.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="shrink-0">
          <BookOpenText className="h-3.5 w-3.5" aria-hidden />
          Read the brief
        </Button>
      </Card>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`Investment brief — ${ticker}`}
        className="sm:max-w-xl lg:max-w-2xl"
      >
        {isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : is404 ? (
          <EmptyState
            title="Research brief not available yet"
            message="This backend hasn't shipped the /api/research endpoint — update the backend to read deterministic briefs."
          />
        ) : isError || !data ? (
          <ErrorState
            compact
            message={error instanceof Error ? error.message : 'Failed to load the research brief'}
            onRetry={() => refetch()}
          />
        ) : (
          <BriefDocument brief={data} />
        )}
      </Drawer>
    </>
  );
}
