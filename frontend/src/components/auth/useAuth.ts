'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAuthStatus } from '@/lib/api';
import type { AuthStatus } from '@/lib/types';

export const AUTH_QUERY_KEY = ['auth', 'me'] as const;

/**
 * Session state for the private views (Watchlist, Holdings).
 * - 'authenticated'  → render the view.
 * - 'unauthenticated'→ render the login screen.
 * - 'unavailable'    → the accounts backend (slice B2) has not shipped:
 *   render the view against the local single-user backend with an honest note
 *   instead of a login wall nobody can pass.
 */
export function useAuth() {
  const qc = useQueryClient();
  const q = useQuery<AuthStatus>({
    queryKey: AUTH_QUERY_KEY,
    queryFn: getAuthStatus,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return {
    loading: q.isPending,
    error: q.isError ? (q.error instanceof Error ? q.error.message : 'Could not check the session.') : null,
    auth: q.data ?? null,
    refresh: () => qc.invalidateQueries({ queryKey: AUTH_QUERY_KEY }),
  };
}
