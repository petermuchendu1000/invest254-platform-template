'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { adminApi } from '@/lib/admin/endpoints';
import type { Paginated } from '@/lib/api/types';
import type { MpesaConfigPatch, GameConfigPatch } from '@/lib/admin/types';
import { useSession } from '@/lib/auth/session';

/** Bearer token for admin calls. */
function useTok() {
  return useSession((s) => s.token) as string;
}

export function useOverview() {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'overview'], queryFn: () => adminApi.overview(t), enabled: !!t });
}
export function useRtp() {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'rtp'], queryFn: () => adminApi.rtp(t), enabled: !!t });
}
export function useRealCashRtp() {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'real-cash-rtp'], queryFn: () => adminApi.realCashRtp(t), enabled: !!t });
}
export function useConfigReview(limit = 50) {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'config-review', limit], queryFn: () => adminApi.configReview(t, limit), enabled: !!t });
}

// ── Users ──
export interface UsersFilter {
  role?: string;
  status?: string;
  q?: string;
  minBalanceCents?: number;
  maxBalanceCents?: number;
  minDepositsCents?: number;
  minWithdrawalsCents?: number;
  minTurnoverCents?: number;
  minBets?: number;
}
export function useUsers(filter: UsersFilter) {
  const t = useTok();
  return useInfiniteQuery({
    queryKey: ['admin', 'users', filter],
    enabled: !!t,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => adminApi.users(t, { cursor: pageParam, ...filter }),
    getNextPageParam: (l: Paginated<unknown>) => l.nextCursor ?? undefined,
  });
}
export function useUser(id: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'user', id], queryFn: () => adminApi.user(t, id as string), enabled: !!t && !!id });
}
export function useUserActivity(id: string | null, kind?: string) {
  const t = useTok();
  return useInfiniteQuery({
    queryKey: ['admin', 'user-activity', id, kind ?? 'all'],
    enabled: !!t && !!id,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => adminApi.userActivity(t, id as string, { cursor: pageParam, kind }),
    getNextPageParam: (l: Paginated<unknown>) => l.nextCursor ?? undefined,
  });
}
export function useSetUserStatus() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: 'suspend' | 'ban' | 'reactivate'; reason?: string }) =>
      adminApi.setUserStatus(t, v.id, v.action, v.reason),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'user', v.id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
export function useSetUserRole() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; role: string }) => adminApi.setUserRole(t, v.id, v.role),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user', v.id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}

/** Soft-delete a user/admin (status='deleted', login-blocked, hidden). Server-guarded. */
export function useDeleteUser() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.deleteUser(t, id),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user', id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}

/** Make / clear this marketer as the brand's default marketer (site-owner commission model, 0104). */
export function useSetDefaultMarketer() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; makeDefault: boolean }) =>
      v.makeDefault ? adminApi.makeDefaultMarketer(t, v.id) : adminApi.clearDefaultMarketer(t, v.id),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user', v.id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}
export function useUpdateUserDetails() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; phone?: string; username?: string }) => {
      const body: { phone?: string; username?: string } = {};
      if (v.phone !== undefined) body.phone = v.phone;
      if (v.username !== undefined) body.username = v.username;
      return adminApi.updateUserDetails(t, v.id, body);
    },
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user', v.id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}
export function useAdjustBalance() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; amountCents: number; reason: string; kind?: 'real' | 'bonus' }) =>
      adminApi.adjustBalance(t, v.id, v.amountCents, v.reason, v.kind),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user', v.id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
export function useClearBalance() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; kind: 'real' | 'bonus' | 'both'; reason: string }) =>
      adminApi.clearBalance(t, v.id, v.kind, v.reason),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user', v.id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
export function useResetBalance() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) => adminApi.resetBalance(t, v.id, v.reason),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user', v.id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
export function useBulkAction() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: import('@/lib/admin/types').BulkActionInput) => adminApi.bulk(t, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
export function useUserOverrides(id: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'overrides', id], queryFn: () => adminApi.userOverrides(t, id as string), enabled: !!t && !!id });
}
export function useSetOverrides(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: import('@/lib/admin/types').UserOverridePatch) => adminApi.setUserOverrides(t, id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'overrides', id] }),
  });
}

// ── Withdrawals ──
export function useWithdrawals(status?: string) {
  const t = useTok();
  return useInfiniteQuery({
    queryKey: ['admin', 'withdrawals', status ?? 'all'],
    enabled: !!t,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => adminApi.withdrawals(t, { cursor: pageParam, status }),
    getNextPageParam: (l: Paginated<unknown>) => l.nextCursor ?? undefined,
  });
}
export function useWithdrawalAction() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject'; password?: string }) =>
      v.action === 'approve' ? adminApi.approveWithdrawal(t, v.id, v.password ?? '') : adminApi.rejectWithdrawal(t, v.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'withdrawals'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}

/** Per-brand withdrawal kill switch (0067): read the current state. */
export function useWithdrawalsEnabled() {
  const t = useTok();
  return useQuery({
    queryKey: ['admin', 'withdrawals-enabled'],
    enabled: !!t,
    queryFn: () => adminApi.withdrawalsEnabled(t),
  });
}
/** Toggle the per-brand withdrawal kill switch (admin/superadmin). */
export function useSetWithdrawalsEnabled() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => adminApi.setWithdrawalsEnabled(t, enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'withdrawals-enabled'] });
    },
  });
}

/** 0068 — marketer expenses (transparency): list + add. */
export function useMarketerExpenses(marketerUserId: string) {
  const t = useTok();
  return useQuery({
    queryKey: ['admin', 'marketer-expenses', marketerUserId],
    enabled: !!t && !!marketerUserId,
    queryFn: () => adminApi.marketerExpenses(t, marketerUserId),
  });
}
export function useAddMarketerExpense(marketerUserId: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { category: string; amountCents: number; note?: string }) =>
      adminApi.addMarketerExpense(t, { marketerUserId, ...body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'marketer-expenses', marketerUserId] }); },
  });
}

// ── Deposits ──
export function useDeposits(status?: string) {
  const t = useTok();
  return useInfiniteQuery({
    queryKey: ['admin', 'deposits', status ?? 'all'],
    enabled: !!t,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => adminApi.deposits(t, { cursor: pageParam, status }),
    getNextPageParam: (l: Paginated<unknown>) => l.nextCursor ?? undefined,
  });
}
export function useDepositsReconcile(staleMinutes = 15) {
  const t = useTok();
  return useQuery({
    queryKey: ['admin', 'deposits-reconcile', staleMinutes],
    queryFn: () => adminApi.depositsReconcile(t, staleMinutes),
    enabled: !!t,
  });
}

// ── Unified transactions (Finance explorer) ──
export function useTransactions(filter: { kind?: string; status?: string; q?: string }) {
  const t = useTok();
  return useInfiniteQuery({
    queryKey: ['admin', 'transactions', filter],
    enabled: !!t,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => adminApi.transactions(t, { cursor: pageParam, ...filter }),
    getNextPageParam: (l: Paginated<unknown>) => l.nextCursor ?? undefined,
  });
}

// ── Affiliates ──
export function useAffiliatePayouts(status?: string) {
  const t = useTok();
  return useInfiniteQuery({
    queryKey: ['admin', 'payouts', status ?? 'all'],
    enabled: !!t,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => adminApi.affiliatePayouts(t, { cursor: pageParam, status }),
    getNextPageParam: (l: Paginated<unknown>) => l.nextCursor ?? undefined,
  });
}
export function usePayoutAction() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject'; reason?: string }) =>
      v.action === 'approve' ? adminApi.approvePayout(t, v.id) : adminApi.rejectPayout(t, v.id, v.reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
export function useSetCommissionRate() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; rate: number }) => adminApi.setCommissionRate(t, v.id, v.rate),
    onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: ['admin', 'user', v.id] }),
  });
}

// ── Deposit-referral commission payouts (0079) — separate money-out queue from GGR payouts ──
export function useCommissionPayouts(status?: string) {
  const t = useTok();
  return useQuery({
    queryKey: ['admin', 'commission-payouts', status ?? 'all'],
    enabled: !!t,
    queryFn: () => adminApi.commissionPayouts(t, status),
  });
}
export function useCommissionPayoutAction() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'paid' | 'reject'; ref?: string; reason?: string; password?: string }) =>
      v.action === 'approve'
        ? adminApi.approveCommissionPayout(t, v.id, v.password ?? '')
        : v.action === 'paid'
          ? adminApi.markCommissionPayoutPaid(t, v.id, v.ref, v.password ?? '')
          : adminApi.rejectCommissionPayout(t, v.id, v.reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'commission-payouts'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}

// ── Game config / seeds ──
export function useGameConfig() {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'game-config'], queryFn: () => adminApi.gameConfig(t), enabled: !!t });
}
export function useUpdateGameConfig() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: GameConfigPatch) => adminApi.updateGameConfig(t, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'game-config'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'rtp'] });
    },
  });
}

// ── M-Pesa config ──
export function useMpesaConfig() {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'mpesa-config'], queryFn: () => adminApi.mpesaConfig(t), enabled: !!t });
}
export function useUpdateMpesaConfig() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: MpesaConfigPatch) => adminApi.updateMpesaConfig(t, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'mpesa-config'] }),
  });
}
export function useSeeds() {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'seeds'], queryFn: () => adminApi.seeds(t), enabled: !!t });
}

// ── docs/25: daily withdrawal-pool budget ──
export function useWithdrawalPool(day?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'withdrawal-pool', day ?? 'today'], queryFn: () => adminApi.withdrawalPool(t, day), enabled: !!t });
}
export function useSetWithdrawalPool() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { amountCents?: number; defaultAmountCents?: number; day?: string }) => adminApi.setWithdrawalPool(t, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'withdrawal-pool'] }),
  });
}
export function useRotateSeed() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tradeDate: string) => adminApi.rotateSeed(t, tradeDate),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'seeds'] }),
  });
}


// ── Reports + audit ──
export function useReportDaily(range: { from?: string; to?: string }) {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'report-daily', range], queryFn: () => adminApi.reportDaily(t, range), enabled: !!t });
}
export function useReportUsers(range: { from?: string; to?: string }) {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'report-users', range], queryFn: () => adminApi.reportUsers(t, range), enabled: !!t });
}
/** Single-day (EAT) comprehensive stats for the calendar day-explorer. */
export function useReportDay(date: string) {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'report-day', date], queryFn: () => adminApi.reportDay(t, date), enabled: !!t });
}
export function useAudit() {
  const t = useTok();
  return useInfiniteQuery({
    queryKey: ['admin', 'audit'],
    enabled: !!t,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => adminApi.audit(t, { cursor: pageParam }),
    getNextPageParam: (l: Paginated<unknown>) => l.nextCursor ?? undefined,
  });
}

// ── User notifications (J7) ──
import type { NotificationInput } from '@/lib/admin/types';

export function useUserNotifications(id: string | null) {
  const t = useTok();
  return useQuery({
    queryKey: ['admin', 'user-notifications', id],
    queryFn: () => adminApi.userNotifications(t, id as string),
    enabled: !!t && !!id,
  });
}
export function useSendNotification(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationInput) => adminApi.sendNotification(t, id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'user-notifications', id] }),
  });
}
export function useResolveNotification(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: number) => adminApi.resolveNotification(t, notificationId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'user-notifications', id] }),
  });
}

// ── Marketers ──
export function useMarketers() {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'marketers'], queryFn: () => adminApi.marketers(t), enabled: !!t });
}
export function useMarketer(id: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'marketer', id], queryFn: () => adminApi.marketer(t, id as string), enabled: !!t && !!id });
}
export function useMarketerStatement(id: string | null) {
  const t = useTok();
  return useQuery({
    queryKey: ['admin', 'marketer-statement', id],
    queryFn: () => adminApi.marketerStatement(t, id as string),
    enabled: !!t && !!id,
  });
}
export function useCreateMarketer() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; phone: string }) => adminApi.createMarketer(t, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
export function useUpdateMarketer() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; name?: string; phone?: string }) => {
      const body: { name?: string; phone?: string } = {};
      if (v.name !== undefined) body.name = v.name;
      if (v.phone !== undefined) body.phone = v.phone;
      return adminApi.updateMarketer(t, v.id, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
    },
  });
}

/** HARD-delete a demo marketer (removes the social-proof account; un-demos the matching person). */
export function useDeleteMarketer() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.deleteMarketer(t, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
export function useMarketerCredit(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { amountCents: number; ref?: string | undefined }) => adminApi.creditMarketer(t, id, v.amountCents, v.ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'marketer', id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'marketer-statement', id] });
    },
  });
}
export function useMarketerWithdraw(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { amountCents: number; ref?: string; method?: string }) =>
      adminApi.withdrawMarketer(t, id, v.amountCents, v.ref, v.method),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'marketer', id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'marketer-statement', id] });
    },
  });
}
export function useMarketerFuliza(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amountCents: number) => adminApi.setMarketerFuliza(t, id, amountCents),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'marketer', id] });
    },
  });
}
export function useMarketerAirtime(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amountCents: number) => adminApi.setMarketerAirtime(t, id, amountCents),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'marketer', id] });
    },
  });
}
export function useMarketerPin(id: string) {
  const t = useTok();
  return useMutation({
    mutationFn: (pin: string) => adminApi.setMarketerPin(t, id, pin),
  });
}
export function useMarketerStatus(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: 'active' | 'suspended' | 'disabled') => adminApi.setMarketerStatus(t, id, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'marketer', id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}

// ── Fly.io machine restart (superadmin only) ──
export function useFlyStatus() {
  const t = useTok();
  return useQuery({ queryKey: ['admin', 'fly-status'], queryFn: () => adminApi.flyStatus(t), enabled: !!t });
}
export function useFlyRestart() {
  const t = useTok();
  return useMutation({
    mutationFn: () => adminApi.flyRestart(t),
  });
}

// ── Bulk actions (finance / affiliate / marketer) ────────────────────────────────────────────
/** Bulk approve/reject withdrawals. Invalidates the withdrawals queue + overview KPIs. */
export function useBulkWithdrawals() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: 'approve' | 'reject'; txIds: string[]; password?: string }) => adminApi.bulkWithdrawals(t, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'withdrawals'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}

/** Bulk approve/reject affiliate payouts. Invalidates the payouts queue + overview KPIs. */
export function useBulkPayouts() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: 'approve' | 'reject'; payoutIds: string[] }) => adminApi.bulkPayouts(t, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}

/** Bulk marketer status change or flat credit. Invalidates the marketers list. */
export function useBulkMarketers() {
  const t = useTok();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: 'activate' | 'suspend' | 'disable' | 'credit'; marketerIds: string[]; amountCents?: number; ref?: string }) =>
      adminApi.bulkMarketers(t, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'marketers'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
