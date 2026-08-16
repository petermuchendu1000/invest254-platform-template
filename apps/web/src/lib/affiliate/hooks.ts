'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/endpoints';
import type { CommissionRecord, Paginated, ReferralRecord } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';

/** Marketer dashboard summary. Enabled only when the caller is an enrolled marketer. */
export function useAffiliateSummary(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['affiliate', 'summary'],
    queryFn: () => api.affiliateSummary(token as string),
    enabled: !!token && enabled,
    retry: false,
  });
}

/** Realtime marketer performance — same summary, but polled every 5s while the live HUD is open. */
export function useMarketerLiveSummary(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['affiliate', 'summary', 'live'],
    queryFn: () => api.affiliateSummary(token as string),
    enabled: !!token && enabled,
    retry: false,
    refetchInterval: enabled ? 5000 : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

export function useAffiliateReferrals(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useInfiniteQuery({
    queryKey: ['affiliate', 'referrals'],
    enabled: !!token && enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.affiliateReferrals(token as string, { cursor: pageParam }),
    getNextPageParam: (last: Paginated<ReferralRecord>) => last.nextCursor ?? undefined,
  });
}

export function useAffiliateCommissions(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useInfiniteQuery({
    queryKey: ['affiliate', 'commissions'],
    enabled: !!token && enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.affiliateCommissions(token as string, { cursor: pageParam }),
    getNextPageParam: (last: Paginated<CommissionRecord>) => last.nextCursor ?? undefined,
  });
}

/** Enroll the current user as a marketer (idempotent server-side). */
export function useAffiliateEnroll() {
  const token = useSession((s) => s.token);
  const setToken = useSession((s) => s.setToken);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.affiliateEnroll(token as string),
    onSuccess: (data) => {
      // Adopt the reissued marketer token so the marketer-gated dashboard routes succeed.
      if (data.token) setToken(data.token);
      void qc.invalidateQueries({ queryKey: ['affiliate'] });
    },
  });
}

/** Request a payout of all available commission. */
export function useAffiliatePayout() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.affiliateRequestPayout(token as string),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['affiliate', 'summary'] });
      void qc.invalidateQueries({ queryKey: ['affiliate', 'commissions'] });
    },
  });
}
