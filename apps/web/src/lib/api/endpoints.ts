import { apiFetch } from '@/lib/api/client';
import type {
  BrandActivityDto,
  CommunityPostDto,
  MarketerLiveDto,
  LiveSessionDto,
  LeaderboardRowDto,
  MarketerProfileDto,
  AffiliateEnrollment,
  AffiliateSummary,
  AuthResult,
  CommissionRecord,
  DepositResult,
  DepositProviderDto,
  DepositMethodDto,
  MegaPayDepositResult,
  DigitHistoryDto,
  GameConfigDto,
  LedgerEntryDto,
  MeDto,
  NotificationDto,
  MarketerAdvanceDto,
  Paginated,
  PayoutRequestResult,
  ReferralSummaryDto,
  CommissionLineDto,
  CommissionPayoutDto,
  MarketerExpensesResponse,
  MarketerMoneyDto,
  MarketerMoneyRange,
  PositionDetailDto,
  PositionDto,
  ReferralRecord,
  SecurityQuestionDto,
  MfaStatusDto,
  MfaEnrollDto,
  StepUpStatusDto,
  StepUpVerifyDto,
  TransactionDto,
  TransactionKind,
  WalletDto,
  WithdrawalResult,
  PaybillInfoDto,
  PaybillClaimDto,
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
  /**
   * The brand's real recent activity (docs/54): settled deposits, paid withdrawals, winning trades.
   * Public — the candlestick screen shows it before login, which is when it matters most.
   */
  siteActivity: (host: string, limit?: number) =>
    apiFetch<{ items: BrandActivityDto[] }>('/site/activity', { query: limit ? { host, limit: String(limit) } : { host } }),
  /** The Top tab's board: real traders ranked by net profit over the chosen window (docs/54). */
  siteLeaderboard: (host: string, period: string) =>
    apiFetch<{ period: string; items: LeaderboardRowDto[] }>('/site/leaderboard', { query: { host, period } }),


  // Auth & profile
  register: (body: RegisterInput) => apiFetch<AuthResult>('/auth/register', { method: 'POST', body }),
  login: (body: { phone: string; password: string; site?: string; totp?: string; recovery_code?: string }) =>
    apiFetch<AuthResult>('/auth/login', { method: 'POST', body }),
  /**
   * Unified operator sign-in (Issue 1). Identity-based (NOT brand-scoped): resolves the account
   * across every brand by phone+password so any admin — including a platform_admin pinned to one
   * brand — can sign in at the shared console on the admin domain. The session binds to the
   * account's own site/platform. `totp`/`recovery_code` cover MFA-enabled operator accounts.
   */
  adminLogin: (body: { phone: string; password: string; totp?: string; recovery_code?: string }) =>
    apiFetch<AuthResult>('/auth/admin/login', { method: 'POST', body }),
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

  // ── MFA / 2FA (TOTP) — privileged accounts; enforced by the mandatory enrolment gate ──
  /** Current 2FA state for the signed-in account. */
  mfaStatus: (token: string) =>
    apiFetch<MfaStatusDto>('/auth/mfa', { token }),
  /** Begin enrolment: returns the secret, otpauth:// URI (for the QR) and one-time recovery codes. */
  mfaEnroll: (token: string) =>
    apiFetch<MfaEnrollDto>('/auth/mfa/enroll', { method: 'POST', token }),
  /** Confirm enrolment with a 6-digit TOTP code — activates 2FA. */
  mfaConfirm: (token: string, code: string) =>
    apiFetch<{ enabled: boolean }>('/auth/mfa/confirm', { method: 'POST', token, body: { code } }),
  /** Disable 2FA — requires a current TOTP or recovery code as possession proof. */
  mfaDisable: (token: string, code: string) =>
    apiFetch<{ enabled: boolean }>('/auth/mfa/disable', { method: 'POST', token, body: { code } }),

  // ── Step-up second factor + real logout (0196) ──
  /** Which factor this session must prove, and whether it currently has. Authoritative: never guess. */
  stepUpStatus: (token: string) => apiFetch<StepUpStatusDto>('/auth/step-up', { token }),
  /**
   * Prove the second factor for THIS session: an authenticator code, a single-use recovery code, or
   * the security answers — whichever `stepUpStatus().factor` asked for.
   */
  stepUpVerify: (
    token: string,
    proof: { code?: string; recovery_code?: string; answers?: Array<{ key: string; answer: string }> },
  ) => apiFetch<StepUpVerifyDto>('/auth/step-up', { method: 'POST', token, body: proof }),
  /**
   * End this operator's session SERVER-SIDE. Logout used to be localStorage-only, so a captured
   * operator token kept working for the rest of its 7 days; this is what actually kills it.
   */
  logout: (token: string) => apiFetch<{ loggedOut: boolean }>('/auth/logout', { method: 'POST', token }),

  // Wallet & history
  wallet: (token: string) => apiFetch<WalletDto>('/wallet', { token }),
  /** DEMO-1: switch the active account (Real / Demo). */
  setAccountMode: (token: string, mode: 'real' | 'demo') =>
    apiFetch<{ mode: 'real' | 'demo'; wallet: WalletDto }>('/wallet/mode', { method: 'POST', token, body: { mode } }),
  /** DEMO-1: refill the demo balance to its starting amount. */
  topupDemo: (token: string) =>
    apiFetch<{ demoBalance: number; wallet: WalletDto }>('/wallet/demo/topup', { method: 'POST', token }),
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
  // Digit contract history (persisted receipts) — docs/34
  digitHistory: (token: string, p: { cursor?: string | null; limit?: number } = {}) =>
    apiFetch<Paginated<DigitHistoryDto>>('/digits/history', {
      token,
      query: { cursor: p.cursor ?? undefined, limit: p.limit },
    }),

  // Payments (amounts are integer cents)
  createDeposit: (token: string, body: { amount: number; phone: string }) =>
    apiFetch<DepositResult>('/deposits', { method: 'POST', token, body }),
  // Deposit gateways to render for the player's brand (migration 0116) + the Mega Pay STK deposit.
  depositProviders: (token: string) =>
    apiFetch<{ providers: DepositProviderDto[]; methods?: DepositMethodDto[] }>('/deposits/providers', { token }),
  createMegapayDeposit: (token: string, body: { amount: number; phone: string }) =>
    apiFetch<MegaPayDepositResult>('/deposits/megapay', { method: 'POST', token, body }),
  // PayHero (Lipwa) STK deposit — the third rail.
  createPayheroDeposit: (token: string, body: { amount: number; phone: string }) =>
    apiFetch<{ transactionId: string; reference: string; checkoutRequestId: string }>('/deposits/payhero', { method: 'POST', token, body }),
  // PayHero Lipwa hosted checkout (card / bank / mobile money / cross-border) — opened in an in-app modal.
  createPayheroLipwaDeposit: (token: string, body: { amount: number }) =>
    apiFetch<{ transactionId: string; reference: string; lipwaUrl: string }>('/deposits/payhero/lipwa', { method: 'POST', token, body }),
  // PayX M-Pesa push — same contract as the other STK rails; the sheet polls the transaction until it settles.
  createPayxDeposit: (token: string, body: { amount: number; method?: string; phone?: string; email?: string }) =>
    apiFetch<{ transactionId: string; checkoutRequestId: string; checkoutUrl?: string }>('/deposits/payx', { method: 'POST', token, body }),
  // PayHero manual Pay Bill: claim a payment made to the PayHero paybill by its M-PESA code.
  claimPayheroPaybill: (token: string, body: { code: string }) =>
    apiFetch<PaybillClaimDto>('/deposits/payhero/paybill/claim', { method: 'POST', token, body }),
  // Pay Bill (manual C2B) deposit: public display config + authed claim-by-code.
  paybillInfo: (site?: string) => apiFetch<PaybillInfoDto>('/deposits/paybill/info', { query: { site } }),
  claimPaybill: (token: string, body: { code: string }) =>
    apiFetch<PaybillClaimDto>('/deposits/paybill/claim', { method: 'POST', token, body }),
  createWithdrawal: (token: string, body: { amount: number; phone: string }) =>
    apiFetch<WithdrawalResult>('/withdrawals', { method: 'POST', token, body }),

  // Affiliate / marketer (M5)
  affiliateEnroll: (token: string) =>
    apiFetch<AffiliateEnrollment>('/affiliate/enroll', { method: 'POST', token }),
  affiliateSummary: (token: string) => apiFetch<AffiliateSummary>('/affiliate/summary', { token }),
  // Marketer self-service (funny-money demo wallet). marketerMe returns the simulated wallet balance;
  // marketerDemoTopup tops it up to the policy cap (no real cash — migration 0102).
  marketerMe: (token: string) => apiFetch<MarketerProfileDto>('/marketers/me', { token }),
  // ── Live sessions (docs/55). Reporting only: starting one changes no attribution. ──
  marketerLive: (token: string) => apiFetch<MarketerLiveDto>('/affiliate/live', { token }),
  marketerLiveStart: (token: string, streamUrl?: string) =>
    apiFetch<LiveSessionDto>('/affiliate/live/start', { method: 'POST', token, body: streamUrl ? { streamUrl } : {} }),
  marketerLiveEnd: (token: string) => apiFetch<LiveSessionDto>('/affiliate/live/end', { method: 'POST', token }),
  marketerLiveExtend: (token: string) => apiFetch<LiveSessionDto>('/affiliate/live/extend', { method: 'POST', token }),

  // ── Community channel (docs/56). Read for players, write for admins. ──
  community: (token: string, limit?: number) =>
    apiFetch<{ items: CommunityPostDto[] }>('/community', { token, ...(limit ? { query: { limit: String(limit) } } : {}) }),
  communityVote: (token: string, postId: string, optionId: string) =>
    apiFetch<CommunityPostDto>(`/community/${postId}/vote`, { method: 'POST', token, body: { optionId } }),
  communityPost: (token: string, input: { kind?: 'post' | 'poll'; title?: string | null; body: string; options?: string[]; pinned?: boolean }) =>
    apiFetch<CommunityPostDto>('/community', { method: 'POST', token, body: input }),
  communityPin: (token: string, postId: string, pinned: boolean) =>
    apiFetch<{ ok: true }>(`/community/${postId}/pin`, { method: 'POST', token, body: { pinned } }),
  communityClose: (token: string, postId: string, closed: boolean) =>
    apiFetch<{ ok: true }>(`/community/${postId}/close`, { method: 'POST', token, body: { closed } }),
  communityDelete: (token: string, postId: string) =>
    apiFetch<{ ok: true }>(`/community/${postId}/delete`, { method: 'POST', token }),
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
  /**
   * The marketer's money statement for one time range (the /dashboard money table).
   *
   * `range` is a closed server-side enum — an unrecognised value is refused with 400 INVALID_RANGE
   * rather than quietly answered with a different window's figures. The reply echoes the resolved
   * inclusive EAT bounds (`from`/`to`) and carries the LIFETIME ladder alongside the windowed
   * figures, so the UI can say which is which.
   */
  affiliateMoney: (token: string, range: MarketerMoneyRange) =>
    apiFetch<MarketerMoneyDto>('/affiliate/money', { token, query: { range } }),

  // Marketer advance requests (0122): request a cash advance, list own requests, cancel a pending one.
  affiliateAdvances: (token: string) =>
    apiFetch<{ items: MarketerAdvanceDto[] }>('/affiliate/advances', { token }),
  requestAdvance: (token: string, body: { amountCents: number; reason?: string }) =>
    apiFetch<MarketerAdvanceDto>('/affiliate/advances', { method: 'POST', token, body }),
  cancelAdvance: (token: string, id: string) =>
    apiFetch<MarketerAdvanceDto>(`/affiliate/advances/${id}/cancel`, { method: 'POST', token }),

  // Sticky notifications (J7)
  notifications: (token: string) => apiFetch<{ items: NotificationDto[] }>('/notifications', { token }),
  dismissNotification: (token: string, id: number) =>
    apiFetch<{ dismissed: boolean }>(`/notifications/${id}/dismiss`, { method: 'POST', token }),
};
