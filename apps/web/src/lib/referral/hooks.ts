'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';
import type { Paginated, CommissionEventDto } from '@/lib/api/types';

/** The caller's referral code/link + headline commission earnings. Any logged-in user. */
export function useMeReferral() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['referral', 'me'],
    queryFn: () => api.meReferral(token as string),
    enabled: !!token,
    retry: false,
  });
}

/** Per-referred-player breakdown (deposited vs played vs unplayed + your commission). */
export function useMeReferralReferred() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['referral', 'referred'],
    queryFn: () => api.meReferralReferred(token as string),
    enabled: !!token,
    retry: false,
  });
}

/** Paginated instant-commission feed (newest first). */
export function useMeReferralCommissions() {
  const token = useSession((s) => s.token);
  return useInfiniteQuery({
    queryKey: ['referral', 'commissions'],
    enabled: !!token,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.meReferralCommissions(token as string, { cursor: pageParam }),
    getNextPageParam: (last: Paginated<CommissionEventDto>) => last.nextCursor ?? undefined,
  });
}
