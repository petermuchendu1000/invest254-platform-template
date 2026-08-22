import { apiFetch } from '@/lib/api/client';
import type {
  MarketerProfileDto,
  AffiliateEnrollment,
  AffiliateSummary,
  AuthResult,
  CommissionRecord,
  DepositResult,
  GameConfigDto,
  LedgerEntryDto,
  MeDto,
  NotificationDto,
  Paginated,
  PayoutRequestResult,
  ReferralSummaryDto,
  CommissionLineDto,
  CommissionPayoutDto,
  MarketerExpensesResponse,
  PositionDetailDto,
  PositionDto,
  ReferralRecord,
  SecurityQuestionDto,
  TransactionDto,
  TransactionKind,
  WalletDto,
  WithdrawalResult,
} from '@/lib/api/types';
import type { PositionStatus } from '@invest254/shared';

export interface RegisterInput {
  phone: string;
  username: string;
  password: string;
  referral_code?: string;
  /**
   * The brand the player is signing up on (brand slug). One deployment serves many domains, so the
   * shared API cannot infer the brand from its own host — the web sends it explicitly to scope the
   * new account + its token's `site` claim to this brand (injected in useAuthActions from useBrand).
   */
  site?: string;
}

export interface PageParams {
  cursor?: string | null;
  limit?: number;
}

export interface TransactionFilter extends PageParams {
  kind?: TransactionKind;
  status?: string;
}

export interface PositionFilter extends PageParams {
  status?: PositionStatus;
}

/** Typed endpoint functions. One per route; grouped by domain. */
export const api = {
  health: () => apiFetch<{ status: string; time: string }>('/health'),
  // Brand-aware: the shared API serves many brand domains, so pass this brand's ref (slug) to get
  // ITS live economy (site_game_config) — the same limits/cap the engine enforces. Omitting it
  // falls back to the default brand server-side.
  gameConfig: (site?: string) => apiFetch<GameConfigDto>('/game/config', site ? { query: { site } } : {}),


  // Auth & profile
  register: (body: RegisterInput) => apiFetch<AuthResult>('/auth/register', { method: 'POST', body }),
  login: (body: { phone: string; password: string; site?: string }) =>
    apiFetch<AuthResult>('/auth/login', { method: 'POST', body }),
  me: (token: string) => apiFetch<MeDto>('/auth/me', { token }),
  refreshToken: (token: string) => apiFetch<AuthResult>('/auth/refresh', { method: 'POST', token }),
  /**
   * Set a new password (0097). For a PRIVILEGED account (admin/superadmin/platform_superadmin) the
   * three security `answers` are REQUIRED and verified server-side; for a player they are ignored and
   * the flow is server-side feature-gated (unchanged). `site` scopes it to the caller's brand.
   */
  resetPassword: (body: {
    phone: string;
    new_password: string;
    answers?: Array<{ key: string; answer: string }>;
    site?: string;
  }) => apiFetch<{ reset: boolean }>('/auth/password/reset', { method: 'POST', body }),
  /** Public catalog of selectable security questions (labels shown in setup + reset UI) (0097). */
  securityQuestionsCatalog: () =>
    apiFetch<{ questions: SecurityQuestionDto[] }>('/auth/security-questions/catalog'),
  /** Reset step 1: which question keys this phone must answer to reset (empty for non-privileged). */
  resetQuestions: (body: { phone: string; site?: string }) =>
    apiFetch<{ keys: string[] }>('/auth/password/reset-questions', { method: 'POST', body }),
  /** Authenticated: set (replace) my three security answers — used by the mandatory setup gate. */
  setSecurityQuestions: (token: string, answers: Array<{ key: string; answer: string }>) =>
    apiFetch<{ set: boolean }>('/auth/security-questions', { method: 'POST', token, body: { answers } }),
  /** Change your own password; requires the current one. Always available when logged in. */
  changePassword: (token: string, body: { current_password: string; new_password: string }) =>
    apiFetch<{ changed: boolean }>('/auth/password/change', { method: 'POST', token, body }),

  // Wallet & history
  wallet: (token: string) => apiFetch<WalletDto>('/wallet', { token }),
  ledger: (token: string, p: PageParams = {}) =>
    apiFetch<Paginated<LedgerEntryDto>>('/wallet/ledger', {
      token,
      query: { cursor: p.cursor ?? undefined, limit: p.limit },
    }),
  transactions: (token: string, p: TransactionFilter = {}) =>
    apiFetch<Paginated<TransactionDto>>('/transactions', {
      token,
      query: { cursor: p.cursor ?? undefined, limit: p.limit, kind: p.kind, status: p.status },
    }),

  // Bet history (positions)
  positions: (token: string, p: PositionFilter = {}) =>
    apiFetch<Paginated<PositionDto>>('/positions', {
      token,
      query: { cursor: p.cursor ?? undefined, limit: p.limit, status: p.status },
    }),
  position: (token: string, id: string) =>
    apiFetch<PositionDetailDto>(`/positions/${id}`, { token }),

  // Payments (amounts are integer cents)
  createDeposit: (token: string, body: { amount: number; phone: string }) =>
    apiFetch<DepositResult>('/deposits', { method: 'POST', token, body }),
  createWithdrawal: (token: string, body: { amount: number; phone: string }) =>
    apiFetch<WithdrawalResult>('/withdrawals', { method: 'POST', token, body }),

  // Affiliate / marketer (M5)
  affiliateEnroll: (token: string) =>
    apiFetch<AffiliateEnrollment>('/affiliate/enroll', { method: 'POST', token }),
  affiliateSummary: (token: string) => apiFetch<AffiliateSummary>('/affiliate/summary', { token }),
  // Marketer self-service (funny-money demo wallet). marketerMe returns the simulated wallet balance;
  // marketerDemoTopup tops it up to the policy cap (no real cash — migration 0102).
  marketerMe: (token: string) => apiFetch<MarketerProfileDto>('/marketers/me', { token }),
  marketerDemoTopup: (token: string) =>
    apiFetch<{ balanceCents: number; capCents: number }>('/marketers/me/demo-topup', { method: 'POST', token }),
  // Public: record a referral-link click from the /r/<code> landing page (fire-and-forget, no auth).
  recordAffiliateClick: (code: string, site?: string) =>
    apiFetch<{ recorded: boolean }>('/affiliate/click', { method: 'POST', body: site ? { code, site } : { code } }),
  affiliateReferrals: (token: string, p: PageParams = {}) =>
    apiFetch<Paginated<ReferralRecord>>('/affiliate/referrals', {
      token,
      query: { cursor: p.cursor ?? undefined, limit: p.limit },
    }),
  affiliateCommissions: (token: string, p: PageParams = {}) =>
    apiFetch<Paginated<CommissionRecord>>('/affiliate/commissions', {
      token,
      query: { cursor: p.cursor ?? undefined, limit: p.limit },
    }),
  affiliateRequestPayout: (token: string) =>
    apiFetch<PayoutRequestResult>('/affiliate/payouts', { method: 'POST', token }),

  // Deposit-based referral commissions (0078/0079) — separate stream from the GGR affiliate payouts.
  myReferral: (token: string) => apiFetch<ReferralSummaryDto>('/me/referral', { token }),
  myReferralCommissions: (token: string) =>
    apiFetch<{ items: CommissionLineDto[] }>('/me/referral/commissions', { token }),
  requestCommissionPayout: (token: string) =>
    apiFetch<CommissionPayoutDto>('/me/referral/payouts', { method: 'POST', token }),
  myCommissionPayouts: (token: string) =>
    apiFetch<{ items: CommissionPayoutDto[] }>('/me/referral/payouts', { token }),
  affiliateExpenses: (token: string) =>
    apiFetch<MarketerExpensesResponse>('/affiliate/expenses', { token }),

  // Sticky notifications (J7)
  notifications: (token: string) => apiFetch<{ items: NotificationDto[] }>('/notifications', { token }),
  dismissNotification: (token: string, id: number) =>
    apiFetch<{ dismissed: boolean }>(`/notifications/${id}/dismiss`, { method: 'POST', token }),
};
