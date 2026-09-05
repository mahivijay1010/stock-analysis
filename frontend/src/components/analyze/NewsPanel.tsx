'use client';

import clsx from 'clsx';
import { ExternalLink } from 'lucide-react';
import type { NewsItem, NewsSummary } from '@/lib/types';
import { fmtDateTime, plain } from '@/lib/format';
import { Card, Chip, EmptyState, SectionTitle } from '@/components/ui';

/** "just now" / "5h ago" / "3d ago" from the decay model's ageHours. */
function relAge(ageHours: number): string {
  if (!Number.isFinite(ageHours) || ageHours < 0) return '';
  if (ageHours < 1) return 'just now';
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  return `${Math.round(ageHours / 24)}d ago`;
}

function sentimentDotClass(s: number): string {
  if (s > 0.05) return 'bg-buy';
  if (s < -0.05) return 'bg-sell';
  return 'bg-slate-500';
}

/** Hype thermometer 0–100 — the gradient (cyan → amber → rose) is fixed to the
 *  track and revealed as the reading heats, so a cool tape shows only cyan. */
function HypeThermometer({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>
          Hype temperature <span className="font-semibold text-slate-300 tabular-nums">{Math.round(v)}/100</span>
        </span>
        <span className="flex items-center gap-3">
          <span>cool 0</span>
          <span>hot 100</span>
        </span>
      </div>
      <div
        className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-white/8"
        role="meter"
        aria-label="Hype temperature"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v)}
      >
        {v > 0 && (
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${v}%`,
              // Fix the full gradient to the track width so it "heats up" as it fills.
              backgroundImage:
                'linear-gradient(90deg, var(--accent-cyan) 0%, var(--accent-amber) 55%, var(--accent-sell) 100%)',
              backgroundSize: `${(100 / v) * 100}% 100%`,
              backgroundRepeat: 'no-repeat',
            }}
          />
        )}
      </div>
    </div>
  );
}

function HeadlineRow({ item }: { item: NewsItem }) {
  return (
    <li
      className="flex items-start gap-2.5 py-2"
      // Older headlines fade with the 48h half-life decay weight (floor 0.45 for readability).
      style={{ opacity: Math.max(0.45, Math.min(1, item.decayWeight)) }}
    >
      <span
        className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', sentimentDotClass(item.sentiment))}
        aria-hidden
        title={`headline sentiment ${item.sentiment >= 0 ? '+' : ''}${item.sentiment.toFixed(2)} (−1..+1)`}
      />
      <div className="min-w-0 flex-1">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline text-sm leading-snug text-slate-200 transition-colors hover:text-cyan-300"
        >
          {item.title}
          <ExternalLink className="mb-0.5 ml-1.5 inline h-3 w-3 text-slate-500 group-hover:text-cyan-400" aria-hidden />
        </a>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {item.source} · {relAge(item.ageHours)}
        </p>
      </div>
    </li>
  );
}

/**
 * V5 — News radar: fresh-headline hype, decay-weighted keyword sentiment and
 * the raw headlines. `news === null` means both free sources failed — the
 * analysis continued on technicals alone, and this panel says so honestly.
 */
export function NewsPanel({ news }: { news: NewsSummary | null }) {
  if (news === null) {
    return (
      <Card className="p-5">
        <SectionTitle>News radar</SectionTitle>
        <EmptyState
          glyph="radar"
          className="mt-3"
          title="Quiet tape — no headlines available"
          message="Neither free news source returned headlines for this stock right now, so the verdict leans on price action and technicals only. No sentiment was fabricated to fill the gap."
        />
      </Card>
    );
  }

  const s = news.sentimentScore;
  const sentimentTone = s >= 15 ? 'buy' : s <= -15 ? 'sell' : 'zinc';

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>News radar</SectionTitle>
        <span className="text-xs text-slate-500">as of {fmtDateTime(news.asOf)}</span>
      </div>

      <div className="mt-4">
        <HypeThermometer value={news.hypeTemperature} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Chip tone={sentimentTone} glow={sentimentTone !== 'zinc'}>
          decay-weighted sentiment {s >= 0 ? '+' : '−'}
          {plain(Math.abs(s), 0)}
        </Chip>
        <Chip tone={news.fresh24hCount > 0 ? 'cyan' : 'zinc'}>
          {plain(news.fresh24hCount, 0)} fresh in 24h
        </Chip>
        <Chip tone="zinc">{plain(news.items.length, 0)} headlines</Chip>
      </div>

      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300">{news.assessment}</p>

      {news.items.length > 0 ? (
        <ul className="mt-3 divide-y divide-white/5 border-t border-white/8">
          {news.items.map((item, i) => (
            <HeadlineRow key={`${item.url}-${i}`} item={item} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 border-t border-white/8 pt-3 text-sm text-slate-500">
          Quiet news tape — no recent headlines. Price action, not narrative, is driving this stock.
        </p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-amber-400/90">{news.caveat}</p>
    </Card>
  );
}
