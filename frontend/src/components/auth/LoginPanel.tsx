'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, LogIn } from 'lucide-react';
import { login } from '@/lib/api';
import { Card, Input } from '@/components/ui';
import { AUTH_QUERY_KEY } from './useAuth';

/**
 * Simple dark login screen gating the private views (Watchlist, Holdings).
 * Public views (Discover, Track Record, Stock Detail) never route here.
 */
export function LoginPanel({ context }: { context: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const mut = useMutation({
    mutationFn: () => login({ email: email.trim(), password }),
    onSuccess: () => {
      setPassword('');
      qc.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    },
  });

  const canSubmit = email.trim().length > 2 && password.length > 0 && !mut.isPending;

  return (
    <div className="login-panel-shell mx-auto flex min-h-[42vh] w-full max-w-3xl items-center">
      <Card elevated className="login-panel-card w-full p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10">
            <KeyRound className="h-5 w-5 text-cyan-300" aria-hidden />
          </span>
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-slate-100">Sign in</h2>
            <p className="text-xs text-slate-500">{context} is private to your account.</p>
          </div>
        </div>

        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) mut.mutate();
          }}
        >
          <Input
            id="login-email"
            label="Email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Input
            id="login-password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          <button type="submit" disabled={!canSubmit} className="btn-primary min-h-11 w-full px-4 py-2 text-sm">
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
            Sign in
          </button>
          {mut.isError && (
            <p className="text-xs leading-relaxed text-sell" role="alert">
              {mut.error instanceof Error ? mut.error.message : 'Sign-in failed.'}
            </p>
          )}
        </form>

        <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed text-slate-500">
          Sessions use a secure cookie set by the backend. Discover, Track Record and Stock Detail stay open without
          signing in.
        </p>
      </Card>
    </div>
  );
}
