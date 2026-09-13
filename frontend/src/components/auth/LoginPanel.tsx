'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, LogIn, ShieldCheck } from 'lucide-react';
import { login, loginWithPasscode } from '@/lib/api';
import { Card, Input } from '@/components/ui';
import { AUTH_QUERY_KEY } from './useAuth';

/**
 * Simple dark login screen gating the private views (Watchlist, Holdings).
 * Public views (Discover, Track Record, Stock Detail) never route here.
 *
 * Two modes: the full email + password sign-in, and an admin PASSCODE fast-path
 * (the owner enters one code instead of email/password). The passcode is
 * verified server-side against ADMIN_PASSCODE; the same secure session cookie
 * is issued either way.
 */
export function LoginPanel({ context }: { context: string }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'passcode' | 'password'>('passcode');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passcode, setPasscode] = useState('');

  const onSuccess = () => {
    setPassword('');
    setPasscode('');
    qc.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
  };

  const pwMut = useMutation({ mutationFn: () => login({ email: email.trim(), password }), onSuccess });
  const pcMut = useMutation({ mutationFn: () => loginWithPasscode(passcode.trim()), onSuccess });

  const canPassword = email.trim().length > 2 && password.length > 0 && !pwMut.isPending;
  const canPasscode = passcode.trim().length >= 6 && !pcMut.isPending;
  const activeMut = mode === 'passcode' ? pcMut : pwMut;

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

        {/* Mode switch */}
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
          <button
            type="button"
            onClick={() => setMode('passcode')}
            className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-medium transition ${mode === 'passcode' ? 'bg-cyan-300/15 text-cyan-200' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Admin passcode
          </button>
          <button
            type="button"
            onClick={() => setMode('password')}
            className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-medium transition ${mode === 'password' ? 'bg-cyan-300/15 text-cyan-200' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Email &amp; password
          </button>
        </div>

        {mode === 'passcode' ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canPasscode) pcMut.mutate();
            }}
          >
            <Input
              id="login-passcode"
              label="Admin passcode"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="••••••"
            />
            <button type="submit" disabled={!canPasscode} className="btn-primary min-h-11 w-full px-4 py-2 text-sm">
              {pcMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
              Unlock
            </button>
          </form>
        ) : (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canPassword) pwMut.mutate();
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
            <button type="submit" disabled={!canPassword} className="btn-primary min-h-11 w-full px-4 py-2 text-sm">
              {pwMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
              Sign in
            </button>
          </form>
        )}

        {activeMut.isError && (
          <p className="mt-3 text-xs leading-relaxed text-sell" role="alert">
            {activeMut.error instanceof Error ? activeMut.error.message : 'Sign-in failed.'}
          </p>
        )}

        <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed text-slate-500">
          Sessions use a secure cookie set by the backend. Discover, Track Record and Stock Detail stay open without
          signing in.
        </p>
      </Card>
    </div>
  );
}
