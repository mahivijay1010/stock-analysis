'use client';

import { BrainCircuit } from 'lucide-react';

const NODES = ['Fundamentals', 'Technicals', 'Events', 'Forecast', 'Risk'];

/** Process visibility only: this intentionally exposes no chain-of-thought. */
export function AIEvidenceProgress() {
  return (
    <div className="ai-evidence-progress" role="status" aria-live="polite">
      <div className="ai-evidence-core"><BrainCircuit aria-hidden /><span>AI review</span></div>
      <div className="ai-evidence-track" aria-hidden>
        {NODES.map((node, index) => (
          <span key={node} style={{ '--evidence-index': index } as React.CSSProperties}>{node}</span>
        ))}
      </div>
      <p>Gathering evidence · checking contradictions · reviewing risk</p>
    </div>
  );
}
