'use client';

import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download, FileUp, History, Loader2 } from 'lucide-react';
import { createTransaction, isNotFound, listTransactions } from '@/lib/api';
import type { NewTransactionRequest, TransactionRecord } from '@/lib/types';
import { fmtDate, inr, plain } from '@/lib/format';
import { Button, Card, Chip, Collapsible, EmptyState, TableSkeleton } from '@/components/ui';

/* ------------------------------------------------------------------ */
/* CSV — formula-injection-safe export, previewed idempotent import    */
/* ------------------------------------------------------------------ */

const CSV_HEADERS = ['ticker', 'type', 'executedAt', 'qty', 'price', 'grossAmount', 'charges', 'note'] as const;

/** Excel/Sheets treat leading = + - @ as formulas — prefix with ' on export. */
function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv(rows: TransactionRecord[]) {
  const lines = [
    CSV_HEADERS.join(','),
    ...rows.map((r) =>
      [r.ticker, r.type, r.executedAt?.slice(0, 10), r.qty, r.price, r.grossAmount, r.charges, r.note]
        .map(csvCell)
        .join(','),
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stocksense-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Minimal CSV parser (quoted fields, commas, newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

interface ImportRow {
  req: NewTransactionRequest;
  raw: string[];
  error: string | null;
  status: 'pending' | 'sent' | 'ok' | 'failed';
  serverError?: string;
}

/** Deterministic idempotency key from row content — re-importing the same file cannot double-book. */
function rowKey(req: NewTransactionRequest): string {
  const basis = `${req.ticker}|${req.type}|${req.executedAt}|${req.qty ?? ''}|${req.price ?? ''}|${req.grossAmount ?? ''}|${req.charges ?? ''}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return `csv-${h.toString(16)}-${basis.length}`;
}

function toImportRow(cells: string[], header: string[]): ImportRow {
  const at = (name: string) => {
    const idx = header.indexOf(name);
    return idx >= 0 ? (cells[idx] ?? '').trim().replace(/^'/, '') : '';
  };
  const num = (s: string) => {
    if (!s) return undefined;
    const n = Number(s.replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  };
  const type = at('type').toUpperCase();
  const req: NewTransactionRequest = {
    ticker: at('ticker').toUpperCase(),
    type: (type === 'SELL' ? 'SELL' : type === 'DIVIDEND' ? 'DIVIDEND' : 'BUY') as NewTransactionRequest['type'],
    executedAt: at('executedat') || at('date'),
    qty: num(at('qty')),
    price: num(at('price')),
    grossAmount: num(at('grossamount')),
    charges: num(at('charges')),
    note: at('note') || undefined,
  };
  req.idempotencyKey = rowKey(req);
  let error: string | null = null;
  if (!req.ticker) error = 'missing ticker';
  else if (!req.executedAt || !/^\d{4}-\d{2}-\d{2}/.test(req.executedAt)) error = 'executedAt must be YYYY-MM-DD';
  else if (!['BUY', 'SELL', 'DIVIDEND'].includes(type)) error = `unsupported type "${at('type')}"`;
  else if (req.qty == null && req.grossAmount == null) error = 'needs qty or grossAmount';
  else if (req.price == null && req.grossAmount == null) error = 'needs price or grossAmount';
  return { req, raw: cells, error, status: 'pending' };
}

function ImportPanel({ onImported }: { onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [running, setRunning] = useState(false);

  const onFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      setRows([]);
      return;
    }
    const header = parsed[0].map((h) => h.trim().toLowerCase());
    setRows(parsed.slice(1).map((cells) => toImportRow(cells, header)));
  };

  const runImport = async () => {
    if (!rows || running) return;
    setRunning(true);
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      if (next[i].error || next[i].status === 'ok') continue;
      next[i] = { ...next[i], status: 'sent' };
      setRows([...next]);
      try {
        await createTransaction(next[i].req);
        next[i] = { ...next[i], status: 'ok' };
      } catch (err) {
        next[i] = { ...next[i], status: 'failed', serverError: err instanceof Error ? err.message : 'rejected' };
      }
      setRows([...next]);
    }
    setRunning(false);
    onImported();
  };

  const importable = rows?.filter((r) => !r.error && r.status !== 'ok').length ?? 0;

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
        <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
          <FileUp className="h-3.5 w-3.5" aria-hidden /> Choose CSV
        </Button>
        <span className="text-[11px] leading-relaxed text-slate-500">
          Columns: {CSV_HEADERS.join(', ')} (the export format). Each row gets a content-derived idempotency key, so
          re-importing the same file cannot double-book once the backend enforces it.
        </span>
      </div>

      {rows && rows.length === 0 && (
        <p className="text-xs text-amber-300">No data rows found — is the header row present?</p>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className="thin-scroll max-h-72 overflow-auto rounded-xl border border-white/6">
            <table className="table-premium min-w-[640px]">
              <thead>
                <tr>
                  <th>Ticker</th><th>Type</th><th>Date</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Charges</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="font-medium text-slate-100">{r.req.ticker || '—'}</td>
                    <td>{r.req.type}</td>
                    <td>{r.req.executedAt || '—'}</td>
                    <td className="num">{r.req.qty ?? '—'}</td>
                    <td className="num">{r.req.price != null ? inr(r.req.price) : r.req.grossAmount != null ? `${inr(r.req.grossAmount)} gross` : '—'}</td>
                    <td className="num">{r.req.charges != null ? inr(r.req.charges) : 'unknown'}</td>
                    <td>
                      {r.error ? (
                        <span className="text-xs text-sell">{r.error}</span>
                      ) : r.status === 'ok' ? (
                        <span className="text-xs text-buy">imported</span>
                      ) : r.status === 'failed' ? (
                        <span className="text-xs text-sell">{r.serverError}</span>
                      ) : r.status === 'sent' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden />
                      ) : (
                        <span className="text-xs text-slate-500">ready</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="primary" size="sm" onClick={() => void runImport()} disabled={running || importable === 0}>
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Import {importable} row{importable === 1 ? '' : 's'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRows(null)} disabled={running}>Clear</Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Transactions history                                                */
/* ------------------------------------------------------------------ */

function typeTone(t: string): string {
  if (t === 'BUY') return 'text-buy';
  if (t === 'SELL') return 'text-sell';
  return 'text-slate-300';
}

export function TransactionsPanel({ onCorrect }: { onCorrect: (tx: TransactionRecord) => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['transactions'],
    queryFn: listTransactions,
    staleTime: 60_000,
    retry: false,
  });

  const rows = useMemo(
    () => (q.data ?? []).slice().sort((a, b) => String(b.executedAt).localeCompare(String(a.executedAt))),
    [q.data],
  );

  const backendPending = q.isError && isNotFound(q.error);

  return (
    <Card className="p-5">
      <Collapsible
        id="holdings.transactions"
        defaultOpen
        title={
          <span className="flex items-center gap-2">
            <History className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
            Transactions
          </span>
        }
        subtitle="The immutable ledger behind your holdings — corrections supersede, never overwrite."
        right={
          rows.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => exportCsv(rows)}>
              <Download className="h-3.5 w-3.5" aria-hidden /> Export CSV
            </Button>
          ) : undefined
        }
      >
        {q.isPending && <TableSkeleton rows={4} cols={6} />}

        {backendPending && (
          <EmptyState
            glyph="radar"
            title="Transaction storage has not shipped on this backend yet"
            message="The transactions API (upgrade slice B2) is pending on this server. Recording, history, corrections and CSV import will activate without UI changes once it lands."
          />
        )}

        {q.isError && !backendPending && (
          <p className="text-sm text-sell">{q.error instanceof Error ? q.error.message : 'Could not load transactions.'}</p>
        )}

        {q.data && rows.length === 0 && (
          <EmptyState
            glyph="slash"
            title="No transactions yet"
            message="Record a purchase above or import a CSV — every entry is validated, dated and kept immutable."
          />
        )}

        {rows.length > 0 && (
          <div className="thin-scroll max-h-[420px] overflow-auto rounded-xl border border-white/6">
            <table className="table-premium min-w-[720px]">
              <thead>
                <tr>
                  <th>Date</th><th>Stock</th><th>Type</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Charges</th><th>Flags</th><th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const superseded = t.correctedBy != null;
                  return (
                    <tr key={String(t.id)} className={clsx(superseded && 'opacity-50')}>
                      <td className="whitespace-nowrap text-slate-300">{fmtDate(t.executedAt)}</td>
                      <td>
                        <p className="font-medium text-slate-100">{t.ticker}</p>
                        {t.note && <p className="max-w-[220px] truncate text-[11px] text-slate-500">{t.note}</p>}
                      </td>
                      <td className={clsx('font-semibold', typeTone(String(t.type)))}>{String(t.type)}</td>
                      <td className="num text-slate-200">{t.qty != null ? plain(t.qty, 0) : '—'}</td>
                      <td className="num text-slate-200">
                        {t.price != null ? inr(t.price) : t.grossAmount != null ? `${inr(t.grossAmount)} gross` : '—'}
                      </td>
                      <td className="num text-slate-300">{t.charges != null ? inr(t.charges) : <span className="text-amber-400/90">unknown</span>}</td>
                      <td>
                        <span className="flex flex-wrap gap-1">
                          {t.priceEstimated ? <Chip tone="wait" className="px-1.5 py-0.5 text-[9px]">ESTIMATED PRICE</Chip> : null}
                          {superseded ? <Chip tone="zinc" className="px-1.5 py-0.5 text-[9px]">SUPERSEDED</Chip> : null}
                          {t.correctionOf != null ? <Chip tone="cyan" className="px-1.5 py-0.5 text-[9px]">CORRECTION</Chip> : null}
                        </span>
                      </td>
                      <td className="text-right">
                        {!superseded && (
                          <Button variant="ghost" size="sm" onClick={() => onCorrect(t)}>Correct</Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Collapsible
          id="holdings.csv-import"
          defaultOpen={false}
          className="mt-4 border-t border-white/[0.06] pt-3"
          title={<span className="text-xs font-medium text-slate-300">Import transactions from CSV</span>}
          subtitle="Preview first; rows import one by one with idempotency keys and per-row results."
        >
          <ImportPanel onImported={() => { qc.invalidateQueries({ queryKey: ['transactions'] }); qc.invalidateQueries({ queryKey: ['holdings'] }); }} />
        </Collapsible>
      </Collapsible>
    </Card>
  );
}
