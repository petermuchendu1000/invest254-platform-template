import { apiFetch } from '@/lib/api/client';
import type { C2bConfigRow, C2bConfigPatch } from '@/lib/admin/types';
import type { Paginated, MarketerExpensesResponse, MarketerExpenseRow, AdminAdvanceDto } from '@/lib/api/types';
import type {
  AdjustBalanceResult,
  ResetBalanceResult,
  BulkActionInput,
  BulkActionResult,
  AdminBulkResult,
  AdminAuditRow,
  AdminSystemLogRow,
  AdminNotificationRow,
  NotificationInput,
  NotificationTemplateRow,
  BroadcastAudienceInput,
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
  // Soft-delete a user/admin (status='deleted'; server-guarded). History preserved.
  deleteUser: (t: string, id: string) =>
    apiFetch<{ userId: string; status: string }>(`/admin/users/${id}/delete`, { method: 'POST', token: t }),
  // Approve is gated by the system owner password (Issue 1); the server verifies it before paying out.
  approveWithdrawal: (t: string, id: string, password: string) =>
    apiFetch<unknown>(`/admin/withdrawals/${id}/approve`, { method: 'POST', token: t, body: { password } }),
  rejectWithdrawal: (t: string, id: string) =>
    apiFetch<unknown>(`/admin/withdrawals/${id}/reject`, { method: 'POST', token: t }),
  // Manually finalize a stuck (pending/processing) withdrawal as PAID when the provider result callback
  // never arrived (Mega Pay / Daraja). Same system-owner password gate as approve; the client then shows paid.
  markWithdrawalPaid: (t: string, id: string, password: string) =>
    apiFetch<unknown>(`/admin/withdrawals/${id}/mark-paid`, { method: 'POST', token: t, body: { password } }),
  // Bulk withdrawal moderation (partial success per row; approve dispatches M-Pesa B2C each).
  // A single system owner password authorizes the whole approve batch.
  bulkWithdrawals: (t: string, body: { action: 'approve' | 'reject'; txIds: string[]; password?: string }) =>
    apiFetch<AdminBulkResult>('/admin/withdrawals/bulk', { method: 'POST', token: t, body }),
  // 0067 — per-brand withdrawal kill switch (owner/admin override).
  // docs/42 UI-2: `site` names the brand (required by the API for the system owner; a site admin is pinned).
  withdrawalsEnabled: (t: string, site?: string) =>
    apiFetch<{ enabled: boolean }>('/admin/withdrawals-enabled', { token: t, ...(site ? { query: { site } } : {}) }),
  setWithdrawalsEnabled: (t: string, enabled: boolean, site?: string) =>
    apiFetch<{ enabled: boolean }>('/admin/withdrawals-enabled', { method: 'PUT', token: t, body: { enabled }, ...(site ? { query: { site } } : {}) }),
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
  // docs/42 UI-1: approval dispatches real M-Pesa -> system owner password, like withdrawals.
  approvePayout: (t: string, id: string, password: string) =>
    apiFetch<unknown>(`/admin/affiliate/payouts/${id}/approve`, { method: 'POST', token: t, body: { password } }),
  rejectPayout: (t: string, id: string, reason?: string) =>
    apiFetch<unknown>(`/admin/affiliate/payouts/${id}/reject`, { method: 'POST', token: t, body: reason ? { reason } : {} }),
  // Bulk payout moderation (partial success per row; approve dispatches M-Pesa B2C each).
  bulkPayouts: (t: string, body: { action: 'approve' | 'reject'; payoutIds: string[]; password?: string }) =>
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
  approveCommissionPayout: (t: string, id: string, password: string) =>
    apiFetch<unknown>(`/admin/commission-payouts/${id}/approve`, { method: 'POST', token: t, body: { password } }),
  markCommissionPayoutPaid: (t: string, id: string, ref?: string, password?: string) =>
    apiFetch<unknown>(`/admin/commission-payouts/${id}/paid`, { method: 'POST', token: t, body: { ...(ref ? { ref } : {}), ...(password ? { password } : {}) } }),
  rejectCommissionPayout: (t: string, id: string, reason?: string) =>
    apiFetch<unknown>(`/admin/commission-payouts/${id}/reject`, { method: 'POST', token: t, body: reason ? { reason } : {} }),
  // 0122 — marketer advance requests: queue (optional status filter) + approve/reject (with a note).
  advances: (t: string, status?: string) =>
    apiFetch<{ items: AdminAdvanceDto[] }>('/admin/affiliate/advances', {
      token: t,
      query: { status: status && status !== 'all' ? status : undefined, limit: 200 },
    }),
  approveAdvance: (t: string, id: string, note?: string) =>
    apiFetch<AdminAdvanceDto>(`/admin/affiliate/advances/${id}/approve`, { method: 'POST', token: t, body: note ? { note } : {} }),
  rejectAdvance: (t: string, id: string, note?: string) =>
    apiFetch<AdminAdvanceDto>(`/admin/affiliate/advances/${id}/reject`, { method: 'POST', token: t, body: note ? { note } : {} }),

  // Game config / RTP / seeds
  gameConfig: (t: string, site?: string) => apiFetch<GameConfigRow>('/admin/game-config', { token: t, ...(site ? { query: { site } } : {}) }),
  updateGameConfig: (t: string, patch: GameConfigPatch, site?: string) =>
    apiFetch<GameConfigRow>('/admin/game-config', { method: 'PATCH', token: t, body: patch, ...(site ? { query: { site } } : {}) }),
  mpesaConfig: (t: string) => apiFetch<MpesaConfigRow>('/admin/mpesa-config', { token: t }),
  // PAY-2 (docs/45): C2B Pay Bill settings + Safaricom URL registration (owner tier).
  c2bConfig: (t: string) => apiFetch<C2bConfigRow>('/admin/c2b-config', { token: t }),
  updateC2bConfig: (t: string, patch: C2bConfigPatch) => apiFetch<C2bConfigRow>('/admin/c2b-config', { method: 'PATCH', token: t, body: patch }),
  registerC2b: (t: string) => apiFetch<{ ok: boolean; message: string; config: C2bConfigRow }>('/admin/c2b-config/register', { method: 'POST', token: t }),
  updateMpesaConfig: (t: string, patch: MpesaConfigPatch) =>
    apiFetch<MpesaConfigRow>('/admin/mpesa-config', { method: 'PATCH', token: t, body: patch }),
  seeds: (t: string, limit = 30) => apiFetch<{ items: AdminSeedRow[] }>('/admin/seeds', { token: t, query: { limit } }),
  rotateSeed: (t: string, tradeDate: string) =>
    apiFetch<SeedRotateResult>('/admin/seeds/rotate', { method: 'POST', token: t, body: { tradeDate } }),

  // docs/25: daily withdrawal-pool budget (per brand, EAT day). Read = admin; set = system owner.
  withdrawalPool: (t: string, day?: string, site?: string) =>
    apiFetch<WithdrawalPoolRow>('/admin/withdrawal-pool', { token: t, query: { ...(day ? { day } : {}), ...(site ? { site } : {}) } }),
  setWithdrawalPool: (t: string, body: { amountCents?: number; defaultAmountCents?: number; day?: string }, site?: string) =>
    apiFetch<WithdrawalPoolRow>('/admin/withdrawal-pool', { method: 'PUT', token: t, body, ...(site ? { query: { site } } : {}) }),

  // Fly.io machine restart (system owner only)
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
  // Owner-only System logs (docs/36). Persisted structured log lines with filters.
  systemLogs: (
    t: string,
    p: Page & { app?: string; level?: string; status?: number; q?: string; requestId?: string; sinceMs?: number } = {},
  ) =>
    apiFetch<Paginated<AdminSystemLogRow>>('/admin/logs', {
      token: t,
      query: {
        cursor: p.cursor ?? undefined, limit: p.limit,
        app: p.app || undefined, level: p.level || undefined, status: p.status, q: p.q || undefined,
        requestId: p.requestId || undefined, sinceMs: p.sinceMs,
      },
    }),

  // Marketers — special players who RECEIVE payments; wallet, Fuliza, airtime, PIN, status.
  marketers: (t: string, limit = 100) =>
    apiFetch<AdminMarketerRow[]>('/admin/marketers', { token: t, query: { limit } }),
  marketer: (t: string, id: string) => apiFetch<AdminMarketerRow>(`/admin/marketers/${id}`, { token: t }),
  createMarketer: (t: string, body: { name: string; phone: string }) =>
    apiFetch<AdminMarketerRow>('/admin/marketers', { method: 'POST', token: t, body }),
  updateMarketer: (t: string, id: string, body: { name?: string; phone?: string }) =>
    apiFetch<AdminMarketerRow>(`/admin/marketers/${id}`, { method: 'PATCH', token: t, body }),
  // HARD delete a demo marketer (cascades wallet/ledger/withdrawals). Un-demos the matching person.
  deleteMarketer: (t: string, id: string) =>
    apiFetch<{ deleted: boolean }>(`/admin/marketers/${id}/delete`, { method: 'POST', token: t }),
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

  // Broadcast centre (0106) — template library, live audience count, one-click send, clear category.
  notificationTemplates: (t: string) =>
    apiFetch<{ items: NotificationTemplateRow[] }>('/admin/notification-templates', { token: t }),
  notificationAudienceCount: (t: string, audience: BroadcastAudienceInput) =>
    apiFetch<{ count: number }>('/admin/notifications/audience-count', { method: 'POST', token: t, body: { audience } }),
  notificationBroadcast: (t: string, templateKey: string, audience: BroadcastAudienceInput, text?: { title: string; body: string }) =>
    apiFetch<{ recipients: number }>('/admin/notifications/broadcast', { method: 'POST', token: t, body: { templateKey, audience, ...(text ?? {}) } }),
  notificationResolveCategory: (t: string, category: string) =>
    apiFetch<{ cleared: number }>('/admin/notifications/resolve-category', { method: 'POST', token: t, body: { category } }),
};
