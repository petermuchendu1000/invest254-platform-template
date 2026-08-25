import { apiFetch } from '@/lib/api/client';
import type { Paginated, MarketerExpensesResponse, MarketerExpenseRow } from '@/lib/api/types';
import type {
  AdjustBalanceResult,
  ResetBalanceResult,
  BulkActionInput,
  BulkActionResult,
  AdminBulkResult,
  AdminAuditRow,
  AdminNotificationRow,
  NotificationInput,
  UserOverrideRow,
  UserOverridePatch,
  AdminDepositRow,
  AdminDepositsReconcile,
  AdminTransactionRow,
  AdminOverview,
  AdminPayoutRow,
  AdminCommissionPayoutRow,
  AdminUserActivityRow,
  AdminUserDetail,
  AdminUserRow,
  AdminWithdrawalRow,
  DailyReportRow,
  AdminDayReport,
  GameConfigPatch,
  GameConfigRow,
  AdminMarketerLedgerRow,
  AdminMarketerRow,
  MarketerWithdrawResult,
  MpesaConfigPatch,
  MpesaConfigRow,
  RtpMonitor,
  RealCashRtp,
  ConfigChangeRow,
  AdminSeedRow,
  SeedRotateResult,
  WithdrawalPoolRow,
  SetUserRoleResult,
  SetUserStatusResult,
  UserReportRow,
} from '@/lib/admin/types';

interface Page {
  cursor?: string | null | undefined;
  limit?: number | undefined;
}

/** Typed admin REST client. One function per route; all admin-gated (bearer token required). */
export const adminApi = {
  overview: (t: string) => apiFetch<AdminOverview>('/admin/overview', { token: t }),
  rtp: (t: string) => apiFetch<RtpMonitor>('/admin/rtp', { token: t }),
  realCashRtp: (t: string) => apiFetch<RealCashRtp>('/admin/real-cash-rtp', { token: t }),
  configReview: (t: string, limit = 50) => apiFetch<ConfigChangeRow[]>(`/admin/config-review?limit=${limit}`, { token: t }),

  // Users
  users: (
    t: string,
    p: Page & {
      role?: string | undefined;
      status?: string | undefined;
      q?: string | undefined;
      minBalanceCents?: number | undefined;
      maxBalanceCents?: number | undefined;
      minDepositsCents?: number | undefined;
      minWithdrawalsCents?: number | undefined;
      minTurnoverCents?: number | undefined;
      minBets?: number | undefined;
    } = {},
  ) =>
    apiFetch<Paginated<AdminUserRow>>('/admin/users', {
      token: t,
      query: {
        cursor: p.cursor ?? undefined,
        limit: p.limit,
        role: p.role,
        status: p.status,
        q: p.q,
        minBalanceCents: p.minBalanceCents,
        maxBalanceCents: p.maxBalanceCents,
        minDepositsCents: p.minDepositsCents,
        minWithdrawalsCents: p.minWithdrawalsCents,
        minTurnoverCents: p.minTurnoverCents,
        minBets: p.minBets,
      },
    }),
  user: (t: string, id: string) => apiFetch<AdminUserDetail>(`/admin/users/${id}`, { token: t }),
  userActivity: (t: string, id: string, p: Page & { kind?: string | undefined } = {}) =>
    apiFetch<Paginated<AdminUserActivityRow>>(`/admin/users/${id}/activity`, {
      token: t,
      query: { cursor: p.cursor ?? undefined, limit: p.limit, kind: p.kind },
    }),
  setUserStatus: (t: string, id: string, action: 'suspend' | 'ban' | 'reactivate', reason?: string) =>
    apiFetch<SetUserStatusResult>(`/admin/users/${id}/${action}`, { method: 'POST', token: t, body: { reason } }),
  setUserRole: (t: string, id: string, role: string) =>
    apiFetch<SetUserRoleResult>(`/admin/users/${id}/role`, { method: 'POST', token: t, body: { role } }),
  // Make / clear this marketer as the brand's default (earns 25% of every deposit) — migration 0104.
  makeDefaultMarketer: (t: string, id: string) =>
    apiFetch<{ ownerUserId: string | null }>(`/admin/marketers/${id}/make-default`, { method: 'POST', token: t }),
  clearDefaultMarketer: (t: string, id: string) =>
    apiFetch<{ ownerUserId: string | null }>(`/admin/marketers/${id}/clear-default`, { method: 'POST', token: t }),
  updateUserDetails: (t: string, id: string, body: { phone?: string; username?: string }) =>
    apiFetch<{ userId: string; phone: string; username: string }>(`/admin/users/${id}/details`, { method: 'POST', token: t, body }),
  adjustBalance: (t: string, id: string, amountCents: number, reason: string, kind?: 'real' | 'bonus') =>
    apiFetch<AdjustBalanceResult>(`/admin/wallets/${id}/adjust`, { method: 'POST', token: t, body: { amountCents, reason, kind } }),
  clearBalance: (t: string, id: string, kind: 'real' | 'bonus' | 'both', reason: string) =>
    apiFetch<{ userId: string; realBalanceCents: number; bonusBalanceCents: number }>(`/admin/wallets/${id}/clear`, { method: 'POST', token: t, body: { kind, reason } }),
  resetBalance: (t: string, id: string, reason: string) =>
    apiFetch<ResetBalanceResult>(`/admin/users/${id}/reset-balance`, { method: 'POST', token: t, body: { reason } }),
  bulk: (t: string, body: BulkActionInput) =>
    apiFetch<BulkActionResult>('/admin/users/bulk', { method: 'POST', token: t, body }),
  userOverrides: (t: string, id: string) =>
    apiFetch<UserOverrideRow>(`/admin/users/${id}/overrides`, { token: t }),
  setUserOverrides: (t: string, id: string, patch: UserOverridePatch) =>
    apiFetch<UserOverrideRow>(`/admin/users/${id}/overrides`, { method: 'POST', token: t, body: patch }),

  // Finance — withdrawals + deposits
  withdrawals: (t: string, p: Page & { status?: string | undefined } = {}) =>
    apiFetch<Paginated<AdminWithdrawalRow>>('/admin/withdrawals', {
      token: t,
      query: { cursor: p.cursor ?? undefined, limit: p.limit, status: p.status },
    }),
  approveWithdrawal: (t: string, id: string) =>
    apiFetch<unknown>(`/admin/withdrawals/${id}/approve`, { method: 'POST', token: t }),
  rejectWithdrawal: (t: string, id: string) =>
    apiFetch<unknown>(`/admin/withdrawals/${id}/reject`, { method: 'POST', token: t }),
  // Bulk withdrawal moderation (partial success per row; approve dispatches M-Pesa B2C each).
  bulkWithdrawals: (t: string, body: { action: 'approve' | 'reject'; txIds: string[] }) =>
    apiFetch<AdminBulkResult>('/admin/withdrawals/bulk', { method: 'POST', token: t, body }),
  // 0067 — per-brand withdrawal kill switch (owner/admin override).
  withdrawalsEnabled: (t: string) =>
    apiFetch<{ enabled: boolean }>('/admin/withdrawals-enabled', { token: t }),
  setWithdrawalsEnabled: (t: string, enabled: boolean) =>
    apiFetch<{ enabled: boolean }>('/admin/withdrawals-enabled', { method: 'PUT', token: t, body: { enabled } }),
  deposits: (t: string, p: Page & { status?: string | undefined } = {}) =>
    apiFetch<Paginated<AdminDepositRow>>('/admin/deposits', {
      token: t,
      query: { cursor: p.cursor ?? undefined, limit: p.limit, status: p.status },
    }),
  depositsReconcile: (t: string, staleMinutes = 15) =>
    apiFetch<AdminDepositsReconcile>('/admin/deposits/reconcile', { token: t, query: { staleMinutes } }),
  transactions: (
    t: string,
    p: Page & { kind?: string | undefined; status?: string | undefined; q?: string | undefined } = {},
  ) =>
    apiFetch<Paginated<AdminTransactionRow>>('/admin/transactions', {
      token: t,
      query: { cursor: p.cursor ?? undefined, limit: p.limit, kind: p.kind, status: p.status, q: p.q },
    }),

  // Affiliates
  affiliatePayouts: (t: string, p: Page & { status?: string | undefined } = {}) =>
    apiFetch<Paginated<AdminPayoutRow>>('/admin/affiliate/payouts', {
      token: t,
      query: { cursor: p.cursor ?? undefined, limit: p.limit, status: p.status },
    }),
  approvePayout: (t: string, id: string) =>
    apiFetch<unknown>(`/admin/affiliate/payouts/${id}/approve`, { method: 'POST', token: t }),
  rejectPayout: (t: string, id: string, reason?: string) =>
    apiFetch<unknown>(`/admin/affiliate/payouts/${id}/reject`, { method: 'POST', token: t, body: reason ? { reason } : {} }),
  // Bulk payout moderation (partial success per row; approve dispatches M-Pesa B2C each).
  bulkPayouts: (t: string, body: { action: 'approve' | 'reject'; payoutIds: string[] }) =>
    apiFetch<AdminBulkResult>('/admin/affiliate/payouts/bulk', { method: 'POST', token: t, body }),
  setCommissionRate: (t: string, id: string, rate: number) =>
    apiFetch<unknown>(`/admin/affiliates/${id}/rate`, { method: 'PATCH', token: t, body: { rate } }),
  // 0068 — marketer expenses (transparency): log a cost against a marketer, and list them.
  addMarketerExpense: (t: string, body: { marketerUserId: string; category: string; amountCents: number; note?: string }) =>
    apiFetch<MarketerExpenseRow>('/admin/affiliate/expenses', { method: 'POST', token: t, body }),
  marketerExpenses: (t: string, marketerUserId: string) =>
    apiFetch<MarketerExpensesResponse>('/admin/affiliate/expenses', { token: t, query: { marketerUserId } }),
  // Deposit-referral commission payouts (0079) — SEPARATE queue from the GGR affiliate payouts.
  commissionPayouts: (t: string, status?: string) =>
    apiFetch<{ items: AdminCommissionPayoutRow[] }>('/admin/commission-payouts', {
      token: t,
      query: { status: status && status !== 'all' ? status : undefined, limit: 200 },
    }),
  approveCommissionPayout: (t: string, id: string) =>
    apiFetch<unknown>(`/admin/commission-payouts/${id}/approve`, { method: 'POST', token: t }),
  markCommissionPayoutPaid: (t: string, id: string, ref?: string) =>
    apiFetch<unknown>(`/admin/commission-payouts/${id}/paid`, { method: 'POST', token: t, body: ref ? { ref } : {} }),
  rejectCommissionPayout: (t: string, id: string, reason?: string) =>
    apiFetch<unknown>(`/admin/commission-payouts/${id}/reject`, { method: 'POST', token: t, body: reason ? { reason } : {} }),

  // Game config / RTP / seeds
  gameConfig: (t: string) => apiFetch<GameConfigRow>('/admin/game-config', { token: t }),
  updateGameConfig: (t: string, patch: GameConfigPatch) =>
    apiFetch<GameConfigRow>('/admin/game-config', { method: 'PATCH', token: t, body: patch }),
  mpesaConfig: (t: string) => apiFetch<MpesaConfigRow>('/admin/mpesa-config', { token: t }),
  updateMpesaConfig: (t: string, patch: MpesaConfigPatch) =>
    apiFetch<MpesaConfigRow>('/admin/mpesa-config', { method: 'PATCH', token: t, body: patch }),
  seeds: (t: string, limit = 30) => apiFetch<{ items: AdminSeedRow[] }>('/admin/seeds', { token: t, query: { limit } }),
  rotateSeed: (t: string, tradeDate: string) =>
    apiFetch<SeedRotateResult>('/admin/seeds/rotate', { method: 'POST', token: t, body: { tradeDate } }),

  // docs/25: daily withdrawal-pool budget (per brand, EAT day). Read = admin; set = superadmin.
  withdrawalPool: (t: string, day?: string) =>
    apiFetch<WithdrawalPoolRow>('/admin/withdrawal-pool', day ? { token: t, query: { day } } : { token: t }),
  setWithdrawalPool: (t: string, body: { amountCents?: number; defaultAmountCents?: number; day?: string }) =>
    apiFetch<WithdrawalPoolRow>('/admin/withdrawal-pool', { method: 'PUT', token: t, body }),

  // Fly.io machine restart (superadmin only)
  flyStatus: (t: string) => apiFetch<{ configured: boolean; apps: string[]; app: string }>('/admin/fly/status', { token: t }),
  flyRestart: (t: string) =>
    apiFetch<{ ok: boolean; apps: Array<{ app: string; machinesRestarted: number; machineIds: string[]; skippedStopped: number; error?: string }>; machinesRestarted: number; by: string; at: string }>(
      '/admin/fly/restart', { method: 'POST', token: t }),

  // Reports + audit
  reportDaily: (t: string, range: { from?: string | undefined; to?: string | undefined } = {}) =>
    apiFetch<{ items: DailyReportRow[] }>('/admin/reports/daily', { token: t, query: { from: range.from, to: range.to } }),
  reportUsers: (t: string, range: { from?: string | undefined; to?: string | undefined } = {}) =>
    apiFetch<{ items: UserReportRow[] }>('/admin/reports/users', { token: t, query: { from: range.from, to: range.to } }),
  reportDay: (t: string, date?: string) =>
    apiFetch<AdminDayReport>('/admin/reports/day', { token: t, query: date ? { date } : {} }),
  audit: (t: string, p: Page = {}) =>
    apiFetch<Paginated<AdminAuditRow>>('/admin/audit', {
      token: t,
      query: { cursor: p.cursor ?? undefined, limit: p.limit },
    }),

  // Marketers — special players who RECEIVE payments; wallet, Fuliza, airtime, PIN, status.
  marketers: (t: string, limit = 100) =>
    apiFetch<AdminMarketerRow[]>('/admin/marketers', { token: t, query: { limit } }),
  marketer: (t: string, id: string) => apiFetch<AdminMarketerRow>(`/admin/marketers/${id}`, { token: t }),
  createMarketer: (t: string, body: { name: string; phone: string }) =>
    apiFetch<AdminMarketerRow>('/admin/marketers', { method: 'POST', token: t, body }),
  updateMarketer: (t: string, id: string, body: { name?: string; phone?: string }) =>
    apiFetch<AdminMarketerRow>(`/admin/marketers/${id}`, { method: 'PATCH', token: t, body }),
  creditMarketer: (t: string, id: string, amountCents: number, ref?: string) =>
    apiFetch<{ balanceCents: number }>(`/admin/marketers/${id}/credit`, { method: 'POST', token: t, body: { amountCents, ref } }),
  withdrawMarketer: (t: string, id: string, amountCents: number, ref?: string, method?: string) =>
    apiFetch<MarketerWithdrawResult>(`/admin/marketers/${id}/withdraw`, { method: 'POST', token: t, body: { amountCents, ref, method } }),
  setMarketerFuliza: (t: string, id: string, amountCents: number) =>
    apiFetch<{ availableFulizaCents: number }>(`/admin/marketers/${id}/fuliza`, { method: 'PATCH', token: t, body: { amountCents } }),
  setMarketerAirtime: (t: string, id: string, amountCents: number) =>
    apiFetch<{ airtimeBalanceCents: number }>(`/admin/marketers/${id}/airtime`, { method: 'PATCH', token: t, body: { amountCents } }),
  marketerStatement: (t: string, id: string, limit = 50) =>
    apiFetch<AdminMarketerLedgerRow[]>(`/admin/marketers/${id}/statement`, { token: t, query: { limit } }),
  setMarketerPin: (t: string, id: string, pin: string) =>
    apiFetch<{ ok: boolean }>(`/admin/marketers/${id}/pin`, { method: 'POST', token: t, body: { pin } }),
  setMarketerStatus: (t: string, id: string, status: 'active' | 'suspended' | 'disabled') =>
    apiFetch<{ status: string }>(`/admin/marketers/${id}/status`, { method: 'PATCH', token: t, body: { status } }),
  // Bulk marketer actions: status change (activate|suspend|disable) or a flat credit to many.
  bulkMarketers: (
    t: string,
    body: { action: 'activate' | 'suspend' | 'disable' | 'credit'; marketerIds: string[]; amountCents?: number; ref?: string },
  ) => apiFetch<AdminBulkResult>('/admin/marketers/bulk', { method: 'POST', token: t, body }),

  // User notifications (J7) — raise a sticky banner for a player; list + resolve.
  userNotifications: (t: string, id: string) =>
    apiFetch<{ items: AdminNotificationRow[] }>(`/admin/users/${id}/notifications`, { token: t }),
  sendNotification: (t: string, id: string, body: NotificationInput) =>
    apiFetch<AdminNotificationRow>(`/admin/users/${id}/notifications`, { method: 'POST', token: t, body }),
  resolveNotification: (t: string, id: number) =>
    apiFetch<{ resolved: boolean }>(`/admin/notifications/${id}/resolve`, { method: 'POST', token: t }),
};
