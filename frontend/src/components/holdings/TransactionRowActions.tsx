'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { removeTransaction } from '@/lib/api';
import type { TransactionRecord } from '@/lib/types';
import { Button } from '@/components/ui';

/**
 * Edit (void + atomic replace with new values) or Remove (void only) a
 * transaction — shared between the Transactions history table and the
 * per-stock "Recent activity" list on the unified Watchlist row, so a
 * mistaken entry is one click away from wherever it was noticed.
 */
export function TransactionRowActions({
  tx,
  onEdit,
  onDone,
}: {
  tx: TransactionRecord;
  onEdit: (tx: TransactionRecord) => void;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const removeMut = useMutation({
    mutationFn: () => removeTransaction(tx.id, 'Removed — recorded in error'),
    onSuccess: onDone,
  });

  if (confirming) {
    return (
      <span className="flex items-center justify-end gap-1.5 whitespace-nowrap text-[11px] text-slate-400">
        Remove this entry?
        <Button variant="secondary" size="sm" className="text-sell" onClick={() => removeMut.mutate()} disabled={removeMut.isPending}>
          {removeMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Yes, remove'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={removeMut.isPending}>Cancel</Button>
      </span>
    );
  }
  return (
    <span className="flex items-center justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={() => onEdit(tx)}>
        <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label={`Remove ${tx.ticker} transaction`}>
        <Trash2 className="h-3.5 w-3.5 text-slate-500" aria-hidden />
      </Button>
      {removeMut.isError && (
        <span className="text-[11px] text-sell">
          {removeMut.error instanceof Error ? removeMut.error.message : 'Could not remove.'}
        </span>
      )}
    </span>
  );
}
