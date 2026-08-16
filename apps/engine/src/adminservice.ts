import type { Page, PageQuery } from "./paging.js";
import type {
  AdminRepository, AdminOverview, AdminUserRow, AdminUserDetail, AdminWithdrawalRow, AdminAuditRow,
  AdminUserListQuery, AdminWithdrawalListQuery, AdminTransactionRow, AdminTransactionListQuery,
  SetUserStatusResult, SetCommissionRateResult,
  AdjustBalanceResult, AdjustBalanceKindResult, ClearBalanceResult, ResetBalanceResult, BalanceKind, UserOverrideRow, UserOverridePatch,
  AdminDepositRow, AdminDepositListQuery, AdminDepositsReconcile,
  ReportRange, DailyReportRow, UserReportRow,
  GameConfigRow, GameConfigPatch, RtpMonitor, AdminSeedRow, SeedRotateResult,
  WithdrawalPoolRow,
  MpesaConfigRow, MpesaConfigPatch, SetUserRoleResult,
  AdminPayoutRow, AdminPayoutListQuery, AdminChatModRow,
  AdminUserActivityRow, AdminUserActivityQuery,
} from "./admin.js";

/**
 * AdminService (J2) — thin orchestration over AdminRepository the HTTP API binds to. The
 * authorization guards and audit writes live in the repository (the 0021 RPCs for Postgres,
 * mirrored in-memory for tests); this layer adds light validation and turns a missing user
 * detail into a USER_NOT_FOUND domain error for a 404.
 */
export class AdminService {
  constructor(private readonly repo: AdminRepository) {}

  overview(): Promise<AdminOverview> { return this.repo.overview(); }

  listUsers(q: AdminUserListQuery): Promise<Page<AdminUserRow>> { return this.repo.listUsers(q); }

  async getUserDetail(userId: string): Promise<AdminUserDetail> {
    const d = await this.repo.getUserDetail(userId);
    if (!d) throw new Error("USER_NOT_FOUND");
    return d;
  }

  /** A single user's unified activity timeline (deposits + withdrawals + bets), newest-first,
   *  keyset-paginated. Like the other admin lists it does not 404 — an unknown user simply
   *  yields an empty page (the user-detail read already guards existence). */
  listUserActivity(userId: string, q: AdminUserActivityQuery): Promise<Page<AdminUserActivityRow>> {
    return this.repo.listUserActivity(userId, q);
  }

  setUserStatus(actorId: string, actorRole: string, targetId: string, status: string, reason: string | null): Promise<SetUserStatusResult> {
    return this.repo.setUserStatus(actorId, actorRole, targetId, status, reason);
  }

  setCommissionRate(actorId: string, actorRole: string, targetId: string, rate: number): Promise<SetCommissionRateResult> {
    return this.repo.setCommissionRate(actorId, actorRole, targetId, rate);
  }

  /** Promote/demote a user's role (superadmin) — guards + audit live in the repo/RPC. */
  setUserRole(actorId: string, actorRole: string, targetId: string, role: string): Promise<SetUserRoleResult> {
    return this.repo.setUserRole(actorId, actorRole, targetId, role);
  }

  listWithdrawals(q: AdminWithdrawalListQuery): Promise<Page<AdminWithdrawalRow>> { return this.repo.listWithdrawals(q); }

  /** Unified deposits + withdrawals feed for the Finance transactions explorer. */
  listTransactions(q: AdminTransactionListQuery): Promise<Page<AdminTransactionRow>> { return this.repo.listTransactions(q); }

  listAudit(q: PageQuery, siteId?: string): Promise<Page<AdminAuditRow>> { return this.repo.listAudit(q, siteId); }

  /** Manual wallet credit/debit (J3) — signed cents, mandatory reason; guards + audit live in the repo/RPC. */
  adjustBalance(actorId: string, actorRole: string, targetId: string, amountCents: number, reason: string): Promise<AdjustBalanceResult> {
    return this.repo.adjustBalance(actorId, actorRole, targetId, amountCents, reason);
  }

  /** Reset a user's real wallet to their most recent successful deposit amount (audited). */
  resetBalanceToLastFunded(actorId: string, actorRole: string, targetId: string, reason: string): Promise<ResetBalanceResult> {
    return this.repo.resetBalanceToLastFunded(actorId, actorRole, targetId, reason);
  }
  /** J8: credit/debit either wallet (real|bonus). */
  adjustBalanceKind(actorId: string, actorRole: string, targetId: string, amountCents: number, kind: BalanceKind, reason: string): Promise<AdjustBalanceKindResult> {
    return this.repo.adjustBalanceKind(actorId, actorRole, targetId, amountCents, kind, reason);
  }
  /** J8: clear a wallet (real|bonus|both) to zero. */
  clearBalance(actorId: string, actorRole: string, targetId: string, kind: "real" | "bonus" | "both", reason: string): Promise<ClearBalanceResult> {
    return this.repo.clearBalance(actorId, actorRole, targetId, kind, reason);
  }
  /** J8: read a user's engine overrides (null = none). */
  getUserOverrides(userId: string): Promise<UserOverrideRow | null> {
    return this.repo.getUserOverrides(userId);
  }
  /** J8: upsert a user's engine overrides (win rate / duration / cap / stake bounds). */
  setUserOverrides(actorId: string, actorRole: string, targetId: string, patch: UserOverridePatch): Promise<UserOverrideRow> {
    return this.repo.setUserOverrides(actorId, actorRole, targetId, patch);
  }

  listDeposits(q: AdminDepositListQuery): Promise<Page<AdminDepositRow>> { return this.repo.listDeposits(q); }

  depositsReconcile(staleMinutes: number): Promise<AdminDepositsReconcile> { return this.repo.depositsReconcile(staleMinutes); }

  /** Per-day operator finance report (J4) — deposits/withdrawals + turnover/GGR, oldest day first. */
  reportDaily(range: ReportRange): Promise<DailyReportRow[]> { return this.repo.reportDaily(range); }

  /** Per-user operator finance report (J4) — same metrics, ordered by GGR desc. */
  reportByUser(range: ReportRange): Promise<UserReportRow[]> { return this.repo.reportByUser(range); }

  // ── J5: game config + RTP monitor + seed rotation ────────────────────────────────────────────

  /** Current game_config singleton (J5). */
  getGameConfig(siteId?: string): Promise<GameConfigRow> { return this.repo.getGameConfig(siteId); }

  /** Edit a brand's site_game_config (J5; superadmin) — partial patch; guards + validation + audit
   *  live in the repo/RPC. siteId scopes the write to the operator's brand (the table the engine reads). */
  updateGameConfig(actorId: string, actorRole: string, patch: GameConfigPatch, siteId?: string): Promise<GameConfigRow> {
    return this.repo.updateGameConfig(actorId, actorRole, patch, siteId);
  }

  /** docs/25 Phase 1 — read a brand's daily withdrawal-pool budget (EAT day). */
  getWithdrawalPool(siteId: string, tradeDay: string): Promise<WithdrawalPoolRow> { return this.repo.getWithdrawalPool(siteId, tradeDay); }
  /** docs/25 Phase 1 — superadmin sets a brand's daily withdrawal-pool budget (guards + audit in repo/RPC). */
  setWithdrawalPool(actorId: string, actorRole: string, siteId: string, tradeDay: string, amountCents: number): Promise<WithdrawalPoolRow> {
    return this.repo.setWithdrawalPool(actorId, actorRole, siteId, tradeDay, amountCents);
  }

  /** Admin-visible M-Pesa config (secrets masked). */
  getMpesaConfig(): Promise<MpesaConfigRow> { return this.repo.getMpesaConfig(); }

  /** Edit M-Pesa config (superadmin) — partial patch; secret fields write-only; audited in the repo/RPC. */
  updateMpesaConfig(actorId: string, actorRole: string, patch: MpesaConfigPatch): Promise<MpesaConfigRow> {
    return this.repo.updateMpesaConfig(actorId, actorRole, patch);
  }

  /** Realised RTP vs target across rolling windows, with a drift alert (J5). */
  rtpMonitor(): Promise<RtpMonitor> { return this.repo.rtpMonitor(); }

  /** Provably-fair day rows: commitment hash, seed version, reveal state (J5). */
  listSeeds(limit: number): Promise<AdminSeedRow[]> { return this.repo.listSeeds(limit); }

  /** Force-rotate a day's seed (J5; superadmin) — bumps the durable seed version; audited. */
  rotateSeed(actorId: string, actorRole: string, tradeDate: string): Promise<SeedRotateResult> {
    return this.repo.rotateSeed(actorId, actorRole, tradeDate);
  }

  // ── J6: affiliate payout queue + chat moderation ─────────────────────────────────────────────

  /** Affiliate payout approve/reject queue (J6). */
  listAffiliatePayouts(q: AdminPayoutListQuery): Promise<Page<AdminPayoutRow>> { return this.repo.listAffiliatePayouts(q); }

  /** Chat moderation list (J6) — newest-first, includes hidden rows when asked. */
  listChat(limit: number, includeHidden: boolean): Promise<AdminChatModRow[]> { return this.repo.listChat(limit, includeHidden); }

  /** Hide a chat message (J6; audited). */
  hideChat(actorId: string, actorRole: string, id: number): Promise<boolean> { return this.repo.hideChat(actorId, actorRole, id); }

  /** Restore a hidden chat message (J6; audited). */
  unhideChat(actorId: string, actorRole: string, id: number): Promise<boolean> { return this.repo.unhideChat(actorId, actorRole, id); }

  /** Append an audit row for an action whose mutation runs in another service/RPC (J6 payout decisions). */
  recordAction(actorId: string, actorRole: string, action: string, targetType: string, targetId: string | null, detail: unknown): Promise<void> {
    return this.repo.recordAction(actorId, actorRole, action, targetType, targetId, detail);
  }

  // Write-path per-brand enforcement (docs/22 Task H): resolve the brand a mutation target belongs
  // to (default when the row's site is null; null when the target is unknown) so the API can reject
  // a site-scoped admin acting across brands.
  siteOfUser(userId: string): Promise<string | null> { return this.repo.siteOfUser(userId); }
  siteOfTransaction(txId: string): Promise<string | null> { return this.repo.siteOfTransaction(txId); }
}
