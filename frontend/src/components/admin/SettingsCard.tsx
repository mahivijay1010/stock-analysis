'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Settings2 } from 'lucide-react';
import { updateAdminSettings } from '@/lib/api';
import type { AdminSettingsRequest, GoalTracker } from '@/lib/types';
import { inrSmart, plain } from '@/lib/format';
import { Card, Collapsible, Input } from '@/components/ui';

function parseNum(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Dynamic challenge settings: start capital (₹1,000 was only the reference),
 * target amount and days — all editable. Changing capital resets the paper
 * challenge (erases trade history), so it double-confirms first. Collapsed by
 * default — it is configuration, not a daily action.
 */
export function SettingsCard({ startCapital, goals }: { startCapital: number; goals: GoalTracker }) {
  const qc = useQueryClient();
  const lastMilestone = goals.milestones[goals.milestones.length - 1];

  const [capital, setCapital] = useState('');
  const [target, setTarget] = useState('');
  const [days, setDays] = useState('');
  const [confirming, setConfirming] = useState(false);

  const mut = useMutation({
    mutationFn: (req: AdminSettingsRequest) => updateAdminSettings(req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin'] });
      setCapital('');
      setTarget('');
      setDays('');
      setConfirming(false);
    },
  });

  const capitalNum = parseNum(capital);
  const targetNum = parseNum(target);
  const daysNum = parseNum(days);
  const wantsReset = capitalNum != null;
  const hasAnyChange = capitalNum != null || targetNum != null || daysNum != null;

  const submit = () => {
    const req: AdminSettingsRequest = {};
    if (capitalNum != null) {
      req.startCapital = capitalNum;
      req.confirmReset = true;
    }
    if (targetNum != null) req.targetAmount = targetNum;
    if (daysNum != null) req.targetDays = daysNum;
    mut.mutate(req);
  };

  const onSaveClick = () => {
    if (wantsReset && !confirming) {
      setConfirming(true);
      return;
    }
    submit();
  };

  return (
    <Card className="p-5">
      <Collapsible
        id="desk.settings"
        defaultOpen={false}
        title={
          <span className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
            Challenge settings
          </span>
        }
        subtitle={`current: ${inrSmart(startCapital)} → ${inrSmart(lastMilestone.target)} in ${plain(lastMilestone.day, 0)} days`}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input
            id="set-capital"
            label="Start capital (₹) — resets the challenge"
            type="text"
            inputMode="numeric"
            value={capital}
            onChange={(e) => {
              setCapital(e.target.value);
              setConfirming(false);
            }}
            placeholder={`current ${inrSmart(startCapital)}`}
          />
          <Input
            id="set-target"
            label="Target amount (₹)"
            type="text"
            inputMode="numeric"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={`current ${inrSmart(lastMilestone.target)}`}
          />
          <Input
            id="set-days"
            label="Target days (1–365)"
            type="text"
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            placeholder={`current ${plain(lastMilestone.day, 0)}`}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!hasAnyChange || mut.isPending}
            onClick={onSaveClick}
            className={
              confirming
                ? 'inline-flex min-h-11 items-center gap-2 rounded-xl border border-sell/50 bg-sell/85 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sell disabled:cursor-not-allowed disabled:opacity-50'
                : 'btn-primary min-h-11 px-4 py-2 text-sm'
            }
          >
            {mut.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {confirming ? 'Confirm reset — erases paper trade history' : wantsReset ? 'Save & reset challenge' : 'Save target'}
          </button>
          {confirming && (
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="touch-target relative text-xs font-medium text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline"
            >
              Cancel
            </button>
          )}
          <span className="text-xs text-slate-500">
            Milestones recompute automatically along the new path — the reality check updates with them.
          </span>
        </div>

        {wantsReset && !confirming && (
          <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Changing start capital resets cash to the new amount, restarts the day counter and deletes all paper trades.
          </p>
        )}
        {mut.isError && (
          <p className="mt-2 text-xs text-sell">
            {mut.error instanceof Error ? mut.error.message : 'Settings could not be saved.'}
          </p>
        )}
      </Collapsible>
    </Card>
  );
}
