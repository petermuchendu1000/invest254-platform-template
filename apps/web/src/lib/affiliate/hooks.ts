'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/endpoints';
import type { CommissionRecord, MarketerMoneyRange, Paginated, ReferralRecord } from '@/lib/api/types';
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
export function useMarketerLiveSummary(enabled: boolean) {  const token = useSession((s) => s.token);
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

/** The marketer's own profile incl. the simulated (funny-money) wallet balance. */
export function useMarketerProfile(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['marketer', 'me'],
    queryFn: () => api.marketerMe(token as string),
    enabled: !!token && enabled,
    retry: false,
    staleTime: 0,
  });
}

/** Self-service: top the marketer's own demo wallet up to the policy cap (no real cash). */
export function useMarketerDemoTopup() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.marketerDemoTopup(token as string),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['marketer', 'me'] }); },
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

/** Admin-logged expenses attributed to the marketer (transparency). Polled with the live HUD. */
export function useAffiliateExpenses(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['affiliate', 'expenses'],
    queryFn: () => api.affiliateExpenses(token as string),
    enabled: !!token && enabled,
    retry: false,
    refetchInterval: enabled ? 15000 : false,
  });
}

/**
 * The marketer's money statement for one time range (the /dashboard money table).
 *
 * The RANGE IS PART OF THE QUERY KEY. Two filter states must not share one cache entry: without the
 * key, switching to "This month" would render today's figures with a month's label until the refetch
 * landed, and a money figure under the wrong label is worse than a spinner. This is the same reason
 * the Top Traders pane keys on its period (`['siteLeaderboard', brand.slug, period.key]`,
 * components/game/candlestick/TopTradersPane.tsx:36).
 *
 * Polled on the dashboard's 15s cadence (like expenses/advances) so an admin-logged expense or an
 * approved advance shows up without a reload.
 */
export function useMarketerMoney(range: MarketerMoneyRange, enabled: boolean) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['affiliate', 'money', range],
    queryFn: () => api.affiliateMoney(token as string, range),
    enabled: !!token && enabled,
    retry: false,
    refetchInterval: enabled ? 15000 : false,
  });
}

/** The marketer's own advance requests (newest first) — polled so admin decisions surface live. */
export function useMyAdvances(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['affiliate', 'advances'],
    queryFn: () => api.affiliateAdvances(token as string),
    enabled: !!token && enabled,
    retry: false,
    refetchInterval: enabled ? 15000 : false,
  });
}

/** Request a cash advance against future commission (one open request at a time). */
export function useRequestAdvance() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { amountCents: number; reason?: string }) => api.requestAdvance(token as string, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['affiliate', 'advances'] });
      // The money table counts advances, so it must refetch too (every range, hence the prefix key).
      void qc.invalidateQueries({ queryKey: ['affiliate', 'money'] });
    },
  });
}

/** Cancel the marketer's own still-pending advance request. */
export function useCancelAdvance() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelAdvance(token as string, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['affiliate', 'advances'] });
      void qc.invalidateQueries({ queryKey: ['affiliate', 'money'] });
    },
  });
}

// ── Deposit-based referral commissions (0078/0079) — available to every authed user ─────────────
/** The caller's referral code, link and commission balance (players + marketers). */
export function useReferral(enabled = true) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['referral', 'me'],
    queryFn: () => api.myReferral(token as string),
    enabled: !!token && enabled,
    retry: false,
  });
}

/** The caller's commission line-items (newest first). */
export function useMyCommissions(enabled = true) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['referral', 'commissions'],
    queryFn: () => api.myReferralCommissions(token as string),
    enabled: !!token && enabled,
    retry: false,
  });
}

/** Request a commission payout (marketer balance must be >= KES 500). Refreshes the summary. */
export function useRequestCommissionPayout() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.requestCommissionPayout(token as string),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['referral', 'me'] });
      qc.invalidateQueries({ queryKey: ['referral', 'commissions'] });
      // A payout request moves money into `held`, which both the lifetime ladder and the windowed
      // "pending" figure in the money table report.
      qc.invalidateQueries({ queryKey: ['affiliate', 'money'] });
    },
  });
}

// ── Live sessions (docs/55) ─────────────────────────────────────────────────────────────────────
// A marketer marks when they go live; the earnings shown are a REPORT over commissions already
// attributed to them, so nothing here moves money.

/**
 * The brand's live rules, the running session, and recent history.
 *
 * Polled while a session is RUNNING, because the figure it shows is what the session has earned so
 * far and a marketer watching their own stream is watching this number. Idle otherwise — a marketer
 * who is not live has nothing changing.
 */
export function useMarketerLive(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['marketer', 'live'],
    queryFn: () => api.marketerLive(token as string),
    enabled: !!token && enabled,
    retry: false,
    refetchInterval: (q) => (q.state.data?.current?.live ? 15_000 : false),
    refetchIntervalInBackground: false,
  });
}

/** Start / end / extend. Each settles by refetching the one query above, so the UI has one truth. */
export function useLiveSessionActions() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  const settle = { onSettled: () => void qc.invalidateQueries({ queryKey: ['marketer', 'live'] }) };
  return {
    start: useMutation({ mutationFn: (streamUrl?: string) => api.marketerLiveStart(token as string, streamUrl), ...settle }),
    end: useMutation({ mutationFn: () => api.marketerLiveEnd(token as string), ...settle }),
    extend: useMutation({ mutationFn: () => api.marketerLiveExtend(token as string), ...settle }),
  };
}

// ── Community channel (docs/56) ─────────────────────────────────────────────────────────────────

/** The brand's channel. Polled gently: a channel changes when an operator posts, not every second. */
export function useCommunity(enabled: boolean) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['community'],
    queryFn: () => api.community(token as string, 30),
    enabled: !!token && enabled,
    refetchInterval: enabled ? 60_000 : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Vote on a poll.
 *
 * The server returns the whole post with fresh counts, so the cache is written from the SERVER's
 * answer rather than guessed locally — a poll's numbers are the one thing on this screen that
 * several people are changing at once.
 */
export function useCommunityVote() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { postId: string; optionId: string }) => api.communityVote(token as string, v.postId, v.optionId),
    onSuccess: (updated) => {
      qc.setQueryData<{ items: import('@/lib/api/types').CommunityPostDto[] }>(['community'], (old) =>
        old ? { items: old.items.map((p) => (p.id === updated.id ? updated : p)) } : old);
    },
  });
}

/** Admin writes. Each settles by refetching the channel, so the list has one source of truth. */
export function useCommunityAdmin() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  const settle = { onSettled: () => void qc.invalidateQueries({ queryKey: ['community'] }) };
  return {
    post: useMutation({
      mutationFn: (v: { kind?: 'post' | 'poll'; title?: string | null; body: string; options?: string[]; pinned?: boolean }) =>
        api.communityPost(token as string, v),
      ...settle,
    }),
    pin: useMutation({ mutationFn: (v: { id: string; pinned: boolean }) => api.communityPin(token as string, v.id, v.pinned), ...settle }),
    close: useMutation({ mutationFn: (v: { id: string; closed: boolean }) => api.communityClose(token as string, v.id, v.closed), ...settle }),
    remove: useMutation({ mutationFn: (id: string) => api.communityDelete(token as string, id), ...settle }),
  };
}
