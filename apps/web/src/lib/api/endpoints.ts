import { apiFetch } from '@/lib/api/client';
import type {
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
  PositionDetailDto,
  PositionDto,
  ReferralRecord,
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
  gameConfig: () => apiFetch<GameConfigDto>('/game/config'),


  // Auth & profile
  register: (body: RegisterInput) => apiFetch<AuthResult>('/auth/register', { method: 'POST', body }),
  login: (body: { phone: string; password: string; site?: string }) =>
    apiFetch<AuthResult>('/auth/login', { method: 'POST', body }),
  me: (token: string) => apiFetch<MeDto>('/auth/me', { token }),
  refreshToken: (token: string) => apiFetch<AuthResult>('/auth/refresh', { method: 'POST', token }),
  /** Set a new password from the phone number alone (no OTP). Server-side feature-gated. */
  resetPassword: (body: { phone: string; new_password: string }) =>
    apiFetch<{ reset: boolean }>('/auth/password/reset', { method: 'POST', body }),
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

  // Sticky notifications (J7)
  notifications: (token: string) => apiFetch<{ items: NotificationDto[] }>('/notifications', { token }),
  dismissNotification: (token: string, id: number) =>
    apiFetch<{ dismissed: boolean }>(`/notifications/${id}/dismiss`, { method: 'POST', token }),
};
