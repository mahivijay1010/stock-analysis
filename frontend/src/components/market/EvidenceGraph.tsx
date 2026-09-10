'use client';

import clsx from 'clsx';

export type EvidenceNode = {
  id: string;
  label: string;
  available: boolean;
};

const POSITIONS = [
  [50, 8],
  [78, 22],
  [88, 55],
  [67, 82],
  [33, 82],
  [12, 55],
  [22, 22],
] as const;

/**
 * Pure visual relationship map. Evidence availability and selected state are
 * supplied by the caller; no analysis or recommendation logic lives here.
 */
export function EvidenceGraph({
  ticker,
  nodes,
  selected,
  onSelect,
}: {
  ticker: string;
  nodes: EvidenceNode[];
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  return (
    <section className="evidence-graph" aria-label={`Evidence graph for ${ticker}`}>
      <svg className="evidence-graph-lines" viewBox="0 0 100 100" aria-hidden>
        {nodes.slice(0, 7).map((node, index) => {
          const [x, y] = POSITIONS[index];
          return <line key={node.id} x1="50" y1="50" x2={x} y2={y} className={node.available ? 'evidence-edge-active' : undefined} />;
        })}
        <circle cx="50" cy="50" r="31" />
        <circle cx="50" cy="50" r="19" />
      </svg>
      <div className="evidence-graph-core"><span>Stock</span><strong>{ticker.replace('.NS', '')}</strong></div>
      {nodes.slice(0, 7).map((node, index) => {
        const [x, y] = POSITIONS[index];
        return (
          <button
            key={node.id}
            type="button"
            aria-pressed={selected === node.id}
            onClick={() => onSelect?.(node.id)}
            className={clsx('evidence-graph-node', node.available && 'evidence-node-available', selected === node.id && 'evidence-node-selected')}
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            <i aria-hidden />{node.label}<small>{node.available ? 'evidence' : 'not available'}</small>
          </button>
        );
      })}
    </section>
  );
}
