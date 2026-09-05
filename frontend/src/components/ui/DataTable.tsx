'use client';

import { Fragment, ReactNode, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { Skeleton } from './Skeleton';

export type SortDir = 'asc' | 'desc';

export interface DataTableColumn<T> {
  /** Stable column id (used for sort state + aria-sort). */
  id: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** Right-aligns and applies tabular numerals (adds the .num class). */
  numeric?: boolean;
  /** Providing a sort accessor makes the column sortable. Nulls sort last. */
  sortValue?: (row: T) => number | string | null | undefined;
  headerClassName?: string;
  cellClassName?: string;
}

/**
 * Premium glass table: sticky blurred header, uppercase micro headers,
 * cyan left-accent row hover, sortable columns with aria-sort, optional
 * expandable detail rows (animated) and built-in loading/empty states.
 * Wrap lives inside the component — horizontal overflow scrolls the table,
 * never the page.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  initialSort = null,
  onRowClick,
  renderExpanded,
  expandLabel = 'Details',
  loading = false,
  loadingRows = 5,
  empty,
  maxHeight,
  className,
  ariaLabel,
}: {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  initialSort?: { id: string; dir: SortDir } | null;
  onRowClick?: (row: T) => void;
  /** When set, each row gets an expand toggle and an animated detail row. */
  renderExpanded?: (row: T) => ReactNode;
  expandLabel?: string;
  /** Renders shimmer rows in place of data. */
  loading?: boolean;
  loadingRows?: number;
  /** Node shown when there are no rows (pass an <EmptyState/>). */
  empty?: ReactNode;
  /** Constrains height so the sticky header earns its keep, e.g. '28rem'. */
  maxHeight?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [sort, setSort] = useState<{ id: string; dir: SortDir } | null>(initialSort);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // nulls last regardless of direction
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') {
        if (Number.isNaN(va) && Number.isNaN(vb)) return 0;
        if (Number.isNaN(va)) return 1;
        if (Number.isNaN(vb)) return -1;
        return (va - vb) * mult;
      }
      return String(va).localeCompare(String(vb)) * mult;
    });
  }, [rows, sort, columns]);

  const toggleSort = (id: string) => {
    setSort((s) => (s?.id === id ? (s.dir === 'asc' ? { id, dir: 'desc' } : null) : { id, dir: 'asc' }));
  };

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const colCount = columns.length + (renderExpanded ? 1 : 0);

  return (
    <div
      className={clsx('thin-scroll overflow-x-auto', maxHeight != null && 'overflow-y-auto', className)}
      style={maxHeight != null ? { maxHeight } : undefined}
    >
      <table className="table-premium" aria-label={ariaLabel}>
        <thead>
          <tr>
            {renderExpanded && (
              <th aria-label={expandLabel} className="w-10">
                <span className="sr-only">{expandLabel}</span>
              </th>
            )}
            {columns.map((col) => {
              const sortable = col.sortValue != null;
              const active = sort?.id === col.id;
              const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th
                  key={col.id}
                  aria-sort={sortable ? (ariaSort ?? 'none') : undefined}
                  className={clsx(col.numeric && 'num', col.headerClassName)}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.id)}
                      className={clsx(
                        'touch-target relative inline-flex items-center gap-1 uppercase transition-colors hover:text-slate-200 focus-visible:text-cyan-300 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-cyan-400',
                        active && 'text-cyan-300',
                      )}
                    >
                      {col.header}
                      {active ? (
                        sort!.dir === 'asc' ? (
                          <ChevronUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ChevronDown className="h-3 w-3" aria-hidden />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 opacity-50" aria-hidden />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: loadingRows }).map((_, r) => (
              <tr key={`skeleton-${r}`}>
                {renderExpanded && <td />}
                {columns.map((col) => (
                  <td key={col.id}>
                    <Skeleton className="h-4 w-full max-w-28" />
                  </td>
                ))}
              </tr>
            ))}

          {!loading && sorted.length === 0 && (
            <tr>
              <td colSpan={colCount} className="py-6">
                {empty ?? <p className="text-center text-sm text-slate-500">No rows to show.</p>}
              </td>
            </tr>
          )}

          {!loading &&
            sorted.map((row, i) => {
              const key = rowKey(row, i);
              const isOpen = expanded.has(key);
              return (
                <Fragment key={key}>
                  <tr
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={clsx(onRowClick && 'cursor-pointer')}
                  >
                    {renderExpanded && (
                      <td className="w-10">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={`${expandLabel}: ${key}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(key);
                          }}
                          className="touch-target relative rounded-full p-1 text-slate-500 transition-colors hover:text-cyan-300 focus-visible:text-cyan-300 focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-cyan-400"
                        >
                          <ChevronDown
                            className={clsx('h-4 w-4 transition-transform duration-200', isOpen && 'rotate-180')}
                            aria-hidden
                          />
                        </button>
                      </td>
                    )}
                    {columns.map((col) => (
                      <td key={col.id} className={clsx(col.numeric && 'num', col.cellClassName)}>
                        {col.cell(row, i)}
                      </td>
                    ))}
                  </tr>
                  {renderExpanded && (
                    <tr className="expanded-row">
                      <td colSpan={colCount}>
                        <AnimatePresence initial={false}>
                          {isOpen && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                              className="overflow-hidden"
                            >
                              <div className="border-b border-white/6 px-4 py-3">{renderExpanded(row)}</div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
