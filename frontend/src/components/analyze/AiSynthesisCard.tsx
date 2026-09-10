'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { BrainCircuit } from 'lucide-react';
import { getAiRoles } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Card, Chip, Collapsible } from '@/components/ui';
import { EvidenceGraph } from '@/components/market/EvidenceGraph';

/*
 * AI synthesis (upgrade Parts 13/16/18): the specialist roles' VALIDATED
 * outputs — technical state synthesis, fundamental assessment, forecast
 * critique — plus the deterministic disagreement measure. Advisory only;
 * derived exclusively from deterministic indicators; can never raise the gate.
 */

interface Technical {
  longTermTrend: string;
  mediumTermState: string;
  shortTermState: string;
  momentum: string;
  participation: string;
  volatilityCharacter: string;
  location: string;
  overallState: string;
  entryImplication: string;
}

interface Fundamental {
  businessTrajectory: string;
  qualityAssessment: string;
  valuationAssessment: string;
  topPositiveEvidence: string[];
  topNegativeEvidence: string[];
  missingEvidence: string[];
  summary: string;
}

interface Critique {
  forecastUsable: boolean;
  confidence: string;
  primaryConcerns: string[];
  recommendedActionCap: string;
  summary: string;
}

function StateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] py-1 last:border-0">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className="text-xs font-semibold text-slate-200">{value.replace(/_/g, ' ')}</span>
    </div>
  );
}

export function AiSynthesisCard({ ticker }: { ticker: string }) {
  const [evidenceFocus, setEvidenceFocus] = useState('risk');
  const q = useQuery({
    queryKey: ['ai-roles', ticker],
    queryFn: () => getAiRoles(ticker),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (q.isPending || q.isError) return null;
  const roles = q.data?.roles ?? {};
  const tech = roles.technical_analyst?.response as unknown as Technical | undefined;
  const fund = roles.fundamental_analyst?.response as unknown as Fundamental | undefined;
  const critic = roles.forecast_critic?.response as unknown as Critique | undefined;
  if (!tech && !fund && !critic) {
    return (
      <Card className="p-4">
        <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <BrainCircuit className="h-4 w-4 text-slate-500" aria-hidden /> AI synthesis
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          No AI role analysis stored yet (runs with the AI pipeline; unavailable without OPENAI_API_KEY). The
          deterministic evidence-gated decision is unaffected.
        </p>
      </Card>
    );
  }

  const graphNodes = [
    { id: 'business', label: 'Business', available: Boolean(fund) },
    { id: 'valuation', label: 'Valuation', available: Boolean(fund) },
    { id: 'technicals', label: 'Technicals', available: Boolean(tech) },
    { id: 'events', label: 'Events', available: Boolean(roles.event_analyst) },
    { id: 'regime', label: 'Regime', available: Boolean(tech) },
    { id: 'forecast', label: 'Forecast', available: Boolean(critic) },
    { id: 'risk', label: 'Risk', available: Boolean(critic) },
  ];
  const focusCopy: Record<string, string> = {
    business: fund?.summary ?? 'Business evidence is not available in this AI review.',
    valuation: fund ? `Valuation state: ${fund.valuationAssessment.replace(/_/g, ' ')}.` : 'Valuation evidence is not available in this AI review.',
    technicals: tech?.overallState ?? 'Technical evidence is not available in this AI review.',
    events: roles.event_analyst ? 'Material-event evidence is available in the Research timeline.' : 'No event-analyst evidence is stored for this review.',
    regime: tech ? `${tech.volatilityCharacter.replace(/_/g, ' ')} volatility; ${tech.location.replace(/_/g, ' ')} location.` : 'Regime evidence is not available in this AI review.',
    forecast: critic?.summary ?? 'Forecast-critic evidence is not available in this AI review.',
    risk: critic ? `Action cap: ${critic.recommendedActionCap.replace(/_/g, ' ')}. ${critic.primaryConcerns[0] ?? critic.summary}` : 'Risk-critic evidence is not available in this AI review.',
  };

  return (
    <Card className="p-4">
      <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <BrainCircuit className="h-4 w-4 text-cyan-300" aria-hidden /> AI synthesis
        <span className="text-[10px] text-slate-600">
          advisory · derived only from deterministic indicators · cap-only, never a boost
          {roles.technical_analyst && ` · ${fmtDateTime(roles.technical_analyst.createdAt)}`}
        </span>
      </p>

      <div className="ai-evidence-map">
        <EvidenceGraph ticker={ticker} nodes={graphNodes} selected={evidenceFocus} onSelect={setEvidenceFocus} />
        <div className="ai-evidence-focus" role="status">
          <span>Focused evidence · {evidenceFocus}</span>
          <p>{focusCopy[evidenceFocus]}</p>
          <small>AI is advisory and cap-only. Quantitative risk and the deterministic gate remain authoritative.</small>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {tech && (
          <div className="glass-inset px-3.5 py-3">
            <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase">Technical state</p>
            <div className="mt-1.5">
              <StateRow label="Long-term trend" value={tech.longTermTrend} />
              <StateRow label="Medium-term" value={tech.mediumTermState} />
              <StateRow label="Short-term" value={tech.shortTermState} />
              <StateRow label="Momentum" value={tech.momentum} />
              <StateRow label="Participation" value={tech.participation} />
              <StateRow label="Volatility" value={tech.volatilityCharacter} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{tech.overallState}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{tech.entryImplication}</p>
          </div>
        )}

        {fund && (
          <div className="glass-inset px-3.5 py-3">
            <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase">Fundamental view</p>
            <div className="mt-1.5">
              <StateRow label="Business trajectory" value={fund.businessTrajectory} />
              <StateRow label="Quality" value={fund.qualityAssessment} />
              <StateRow label="Valuation" value={fund.valuationAssessment} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{fund.summary}</p>
            {fund.missingEvidence.length > 0 && (
              <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                missing: {fund.missingEvidence.slice(0, 3).join(' · ')}
              </p>
            )}
          </div>
        )}

        {critic && (
          <div className="glass-inset px-3.5 py-3">
            <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase">Forecast critic</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Chip tone={critic.forecastUsable ? 'buy' : 'sell'}>
                forecast {critic.forecastUsable ? 'usable' : 'NOT usable'}
              </Chip>
              <Chip tone="zinc">cap: {critic.recommendedActionCap}</Chip>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{critic.summary}</p>
            {critic.primaryConcerns.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {critic.primaryConcerns.slice(0, 3).map((c, i) => (
                  <li key={i} className="text-[10px] leading-relaxed text-slate-500">
                    • {c}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {roles.counterfactual?.response && Array.isArray((roles.counterfactual.response as { conditions?: unknown[] }).conditions) && (
        <Collapsible
          id={`ai-counterfactual-${ticker}`}
          className="mt-3"
          title={<span className="text-xs font-medium text-slate-300">What would make this a BUY? (deterministic conditions, AI-explained)</span>}
        >
          <ul className="space-y-1.5">
            {((roles.counterfactual.response as { conditions: Array<{ conditionId: string; explanation: string }> }).conditions).map(
              (c) => (
                <li key={c.conditionId} className="text-xs leading-relaxed text-slate-400">
                  <span className="text-slate-600">{c.conditionId}</span> — {c.explanation}
                </li>
              )
            )}
          </ul>
        </Collapsible>
      )}
    </Card>
  );
}
