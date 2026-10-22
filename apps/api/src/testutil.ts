import { InMemoryLiveChatStore } from "./app.livechat.js";
import { InMemoryKycStore } from "./app.kyc.js";
import type { AddressInfo } from "node:net";
import { DEFAULT_CONFIG, normalizeHost, type Cents } from "@invest254/shared";
import {
  InMemoryEngagementRepository, InMemoryPaymentRepository, InMemoryGameRepository, StubDarajaClient, StubMegaPayClient, StubPayHeroClient, StubPaynicornClient,
  InMemoryIdentityRepository, PaymentService, AuthService, AffiliateService, AdminService, InMemoryAdminRepository, PlatformService, InMemoryPlatformRepository, maskHandle,
  SubscriptionService, InMemorySubscriptionRepository, TicketService, InMemoryTicketRepository,
  NotificationService, InMemoryNotificationRepository,
  PushService, InMemoryPushSubscriptionRepository,
  PaymentScopeService, InMemoryPaymentScopeRepository, BillingService, InMemoryBillingRepository,
  type PushSubscriptionRow, type PushSendResult, type WithdrawalRequestedEvent,
  type FairnessRecord, type AuthClaims, type Verifier,
} from "@invest254/engine";
import { createApp, type ApiDeps, type WalletBalance, type Brand } from "./app.js";
import { createLogger } from "@invest254/shared/logger";
import type { MarketerRepo, TransferResult, MarketerRow, MarketerProfile, MarketerLedgerRow, WithdrawResult, MarketerActor } from "./app.marketers.js";
import type { ReferralRepo, CommissionPayoutRow, AdminCommissionPayoutRow } from "./app.referral.js";
import type { SupportDeps, SupportStore, SupportConversation, SupportMessageRow } from "./app.support.js";
import type { PlatformOnboardDeps, OnboardInput, OnboardResult, RegistrarConfigDeps } from "./app.platform.js";
import type { AddonDeps } from "./app.addons.js";
import type { EmbedFn, KbHit, LlmFn, LlmMessage, SupportBrandInfo } from "@invest254/shared";
import { createHash } from "node:crypto";

/** In-memory ReferralRepo mirroring the 0078/0079 payout lifecycle (min KES 500, one pending
 *  request, approve->paid->reject) for API route tests. `_seedCommission` seeds a marketer balance. */
export type InMemoryReferralRepo = ReferralRepo & {
  _seedCommission(userId: string, cents: number, siteId?: string): void;
  _setCode(userId: string, code: string): void;
};
export function makeInMemoryReferralRepo(): InMemoryReferralRepo {
  const MIN = 50000;
  const accrued = new Map<string, number>();          // userId -> accrued marketer commission cents
  const codes = new Map<string, string>();            // userId -> referral code
  const siteOf = new Map<string, string>();           // userId -> siteId
  const payouts = new Map<string, AdminCommissionPayoutRow>();
  const bal = (u: string) => {
    const earned = accrued.get(u) ?? 0;
    let held = 0, paid = 0;
    for (const p of payouts.values()) if (p.beneficiaryUser === u) {
      if (p.status === "requested" || p.status === "approved") held += p.amountCents;
      else if (p.status === "paid") paid += p.amountCents;
    }
    return { earned, held, paid, available: earned - held - paid };
  };
  const asRow = (p: AdminCommissionPayoutRow): CommissionPayoutRow => ({
    id: p.id, amountCents: p.amountCents, status: p.status, requestedAtMs: p.requestedAtMs,
    approvedAtMs: p.approvedAtMs, paidAtMs: p.paidAtMs, paidRef: p.paidRef, note: p.note,
  });
  return {
    _seedCommission(userId, cents, siteId = "00000000-0000-0000-0000-000000000001") {
      accrued.set(userId, (accrued.get(userId) ?? 0) + cents); siteOf.set(userId, siteId);
    },
    _setCode(userId, code) { codes.set(userId, code); },
    async myReferral(userId) {
      const b = bal(userId); const code = codes.get(userId) ?? null;
      return { referralCode: code, referralPath: code ? `/r/${code}` : null, isMarketer: (accrued.get(userId) ?? 0) > 0,
        totalReferrals: 0, earnedCents: b.earned, marketerEarnedCents: b.earned, heldCents: b.held, paidCents: b.paid, availableCents: b.available, minPayoutCents: MIN };
    },
    async listMyCommissions() { return []; },
    async requestPayout(userId) {
      for (const p of payouts.values()) if (p.beneficiaryUser === userId && (p.status === "requested" || p.status === "approved")) throw new Error("PAYOUT_PENDING");
      const b = bal(userId);
      if (b.available < MIN) throw new Error("BELOW_MIN");
      const id = `cp-${payouts.size + 1}`;
      const row: AdminCommissionPayoutRow = { id, amountCents: b.available, status: "requested", requestedAtMs: Date.now(),
        approvedAtMs: null, paidAtMs: null, paidRef: null, note: null,
        beneficiaryUser: userId, username: null, phone: null, siteId: siteOf.get(userId) ?? "00000000-0000-0000-0000-000000000001" };
      payouts.set(id, row); return asRow(row);
    },
    async listMyPayouts(userId) { return [...payouts.values()].filter((p) => p.beneficiaryUser === userId).map(asRow); },
    async listPayouts(siteId, status) {
      return [...payouts.values()].filter((p) => (!siteId || p.siteId === siteId) && (!status || p.status === status));
    },
    async siteOfPayout(id) { return payouts.get(id)?.siteId ?? null; },
    async approvePayout(id) { const p = payouts.get(id); if (!p || p.status !== "requested") throw new Error("INVALID_STATE"); p.status = "approved"; p.approvedAtMs = Date.now(); return asRow(p); },
    async markPaid(id, _admin, ref) { const p = payouts.get(id); if (!p || (p.status !== "requested" && p.status !== "approved")) throw new Error("INVALID_STATE"); p.status = "paid"; p.paidAtMs = Date.now(); p.paidRef = ref; return asRow(p); },
    async rejectPayout(id, _admin, reason) { const p = payouts.get(id); if (!p || (p.status !== "requested" && p.status !== "approved")) throw new Error("INVALID_STATE"); p.status = "rejected"; p.note = reason; return asRow(p); },
  };
}

/** In-memory MarketerRepo mirroring the SQL RPCs (0033): overdraw guard, idempotency, initials. */
/** In-memory MarketerRepo plus test-only seeding helpers (brand names). */
export interface InMemoryMarketerRepo extends MarketerRepo {
  /** Register a site_id -> brand display name so profiles resolve `brand_name` (0096). */
  _setBrandName(siteId: string, name: string): void;
  /** Register a site-admin actor's home brand, so the in-memory repo can mirror the DB brand fence
   *  (0199 / A1): a site-tier actor acting on another brand's marketer raises SITE_SCOPE_FORBIDDEN. */
  _setActorSite(actorId: string, siteId: string): void;
  /** The actor last forwarded to a given mutating method ('credit'|'withdraw'|'setPin'|'setStatus'|
   *  'setFuliza'|'setAirtime'), so wiring tests can assert the admin routes pass the token actor and
   *  the system/self-service paths pass none. undefined when the method ran with no actor. */
  _lastActor(method: string): MarketerActor | undefined;
}

export function makeInMemoryMarketerRepo(): InMemoryMarketerRepo {
  interface Rec { id: string; name: string; phone: string; status: string; created_at: string; updated_at: string; balance: number; fuliza: number; airtime: number; site_id: string; email?: string | null; }
  const byId = new Map<string, Rec>();
  // Keyed by phone WITHIN a brand: a phone is only unique per site, so two brands may each own a
  // marketer with the same number (mirrors the SQL `marketers (phone, site_id)` scoping).
  const DEF_SITE = "00000000-0000-0000-0000-000000000001";
  // site_id -> brand display name, mirroring the 0096 `marketer_profiles.brand_name` (sites.name).
  // The default brand is Invest254; tests register others via `_setBrandName`.
  const brandBySite = new Map<string, string>([[DEF_SITE, "Invest254"]]);
  // Significant-9-digits phone key, mirroring the DB's fn_phone_sig9 (migration 0086) so the
  // in-memory repo matches the real Postgres semantics (marketers.pg.ts profileByPhone).
  const sig9 = (phone: string) => phone.replace(/[^0-9]/g, "").slice(-9);
  const pkey = (phone: string, siteId?: string) => `${sig9(phone)}::${siteId ?? DEF_SITE}`;
  const byPhone = new Map<string, string>();
  const ledgers = new Map<string, MarketerLedgerRow[]>();
  const refs = new Map<string, { balance: number; ledgerId: number }>();
  const pins = new Map<string, string>();
  // 0198: marketer security answers (marketer id -> question_key -> answer_hash) and the force-logout
  // epoch (marketer id -> epoch ms). Mirror the SQL semantics so the in-memory and Pg paths agree.
  const securityAnswers = new Map<string, Map<string, string>>();
  const forceLogoutAt = new Map<string, number>();
  // 0199/A1: the DB brand fence mirrored in memory. `actorSites` maps a site-admin actor to its home
  // brand; `lastActor` records the actor each mutating method last received (for wiring assertions).
  const actorSites = new Map<string, string>();
  const lastActor = new Map<string, MarketerActor | undefined>();
  // Mirrors fn_assert_actor_site_scope (0156): a site-tier actor confined to a single brand (registered
  // here with `_setActorSite`) may not act on another brand's marketer. A platform actor / the owner
  // (no registered home => acts across brands) and a null actor (internal/system + self-service) are a
  // no-op, as is a missing marketer (null site) — left to the method's own MARKETER_NOT_FOUND, exactly
  // like the SQL helper's `p_site is not null` guard. (The real role→scope mapping lives in the DB and
  // is proven by packages/db/_testkit/e2e_marketer_rpc_tenant_fence.py; this models it via the home.)
  const fence = (method: string, marketerSite: string | undefined, actor?: MarketerActor): void => {
    lastActor.set(method, actor);
    if (!actor || marketerSite == null) return;
    const home = actorSites.get(actor.id);
    if (home !== undefined && home !== marketerSite) throw new Error("SITE_SCOPE_FORBIDDEN");
  };
  let mseq = 0, lseq = 0;
  const now = () => new Date().toISOString();
  const parts = (n: string) => n.trim().split(/\s+/).filter(Boolean);
  const firstName = (n: string) => parts(n)[0] ?? "";
  const initials = (n: string) => { const p = parts(n); return p.length === 0 ? "" : p.length === 1 ? p[0]!.slice(0, 2).toUpperCase() : (p[0]![0]! + p[p.length - 1]![0]!).toUpperCase(); };
  const profileOf = (m: Rec): MarketerProfile => ({ id: m.id, name: m.name, first_name: firstName(m.name), initials: initials(m.name), phone: m.phone, status: m.status, balance_cents: m.balance, available_fuliza_cents: m.fuliza, airtime_balance_cents: m.airtime, currency: "KES", site_id: m.site_id, brand_name: brandBySite.get(m.site_id) ?? null, sessions_valid_after: forceLogoutAt.has(m.id) ? new Date(forceLogoutAt.get(m.id)!).toISOString() : null, email: m.email ?? null });
  // `createdAt` is passed only by the transfer mirror, where both halves must carry the SAME
  // timestamp: in Postgres they do, because created_at defaults to now() and now() is transaction
  // start. Letting each row take its own clock reading here would quietly make the in-memory
  // harness disagree with the database about whether the two sides of one transfer are simultaneous.
  const push = (id: string, entry_type: string, amount_cents: number, balance_after_cents: number, ref: string | null, meta: unknown, createdAt?: string): number => {
    const row: MarketerLedgerRow = { id: ++lseq, entry_type, amount_cents, balance_after_cents, ref, meta: meta ?? {}, created_at: createdAt ?? now() };
    (ledgers.get(id) ?? []).push(row);
    return row.id;
  };
  return {
    async create(name: string, phone: string, siteId?: string): Promise<MarketerRow> {
      const site = siteId ?? DEF_SITE;
      const existing = byPhone.get(pkey(phone, site));
      if (existing) { const m = byId.get(existing)!; m.name = name; m.updated_at = now(); return { id: m.id, name: m.name, phone: m.phone, status: m.status, created_at: m.created_at, updated_at: m.updated_at }; }
      const id = `m-${++mseq}`; const ts = now();
      const m: Rec = { id, name, phone, status: "active", created_at: ts, updated_at: ts, balance: 0, fuliza: 0, airtime: 0, site_id: site, email: null };
      byId.set(id, m); byPhone.set(pkey(phone, site), id); ledgers.set(id, []);
      return { id, name, phone, status: "active", created_at: ts, updated_at: ts };
    },
    async update(id: string, name: string | null, phone: string | null): Promise<MarketerRow> {
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      if (phone && phone.trim() && phone.trim() !== m.phone) {
        const other = byPhone.get(pkey(phone.trim(), m.site_id));
        if (other && other !== id) throw new Error("PHONE_TAKEN");
        byPhone.delete(pkey(m.phone, m.site_id)); m.phone = phone.trim(); byPhone.set(pkey(m.phone, m.site_id), id);
      }
      if (name && name.trim()) m.name = name.trim();
      m.updated_at = now();
      return { id: m.id, name: m.name, phone: m.phone, status: m.status, created_at: m.created_at, updated_at: m.updated_at };
    },
    async list(limit: number): Promise<MarketerProfile[]> {
      return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(profileOf);
    },
    async profile(id: string): Promise<MarketerProfile | null> { const m = byId.get(id); return m ? profileOf(m) : null; },
    async profileByPhone(phone: string, siteId?: string): Promise<MarketerProfile | null> {
      // Site-scoped when a brand is supplied; else first match across brands (single-tenant callers).
      if (siteId) { const id = byPhone.get(pkey(phone, siteId)); const m = id ? byId.get(id) : undefined; return m ? profileOf(m) : null; }
      const m = [...byId.values()].find((r) => sig9(r.phone) === sig9(phone) && sig9(phone).length === 9);
      return m ? profileOf(m) : null;
    },
    /**
     * Mirrors fn_marketer_transfer (0203) closely enough that a route test proves the ROUTE, not a
     * convenient fiction: same refusal order, same opaque RECIPIENT_NOT_FOUND for "another brand /
     * suspended / absent", same cash-only rule (Fuliza is never consulted), same `<ref>:out` /
     * `<ref>:in` idempotency, same rolling-24h cap. What it cannot mirror is atomicity under
     * concurrency — that is proven against real Postgres in
     * packages/db/_testkit/e2e_marketer_transfer.py, which is where it belongs.
     */
    async transfer(fromId: string, toId: string, amountCents: number, ref: string | null, meta: unknown, dailyCapCents: number): Promise<TransferResult> {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("AMOUNT_MUST_BE_POSITIVE");
      if (amountCents < 100) throw new Error("AMOUNT_BELOW_MINIMUM");
      if (fromId === toId) throw new Error("TRANSFER_TO_SELF");

      const refOut = ref ? `${ref}:out` : null;
      const refIn = ref ? `${ref}:in` : null;
      if (refOut) {
        for (const [mid, rows] of ledgers) {
          const hit = rows.find((r) => r.ref === refOut);
          if (hit) {
            return {
              idempotent: true,
              from_balance_cents: hit.balance_after_cents,
              to_balance_cents: byId.get(toId)?.balance ?? 0,
              out_ledger_id: hit.id,
              in_ledger_id: [...ledgers.values()].flat().find((r) => r.ref === refIn)?.id ?? 0,
              recipient_name: byId.get(toId)?.name ?? "",
              sent_cents: -hit.amount_cents,
              // The STORED row's time (0205) — a replay reprints the original receipt. Returning a
              // fresh clock reading here is the exact bug the field exists to prevent.
              out_created_at: hit.created_at,
            };
            void mid;
          }
        }
      }

      const from = byId.get(fromId);
      if (!from) throw new Error("MARKETER_NOT_FOUND");
      if (from.status !== "active") throw new Error(`MARKETER_NOT_ACTIVE:${from.status}`);
      const to = byId.get(toId);
      // ONE refusal for absent / other-brand / suspended — see the RPC header.
      if (!to || to.site_id !== from.site_id || to.status !== "active") throw new Error("RECIPIENT_NOT_FOUND");

      if (dailyCapCents !== null && dailyCapCents >= 0) {
        const since = Date.now() - 24 * 60 * 60 * 1000;
        const sent = (ledgers.get(fromId) ?? [])
          .filter((r) => r.entry_type === "transfer_out" && Date.parse(r.created_at) > since)
          .reduce((acc, r) => acc - r.amount_cents, 0);
        if (sent + amountCents > dailyCapCents) throw new Error(`TRANSFER_DAILY_CAP: sent ${sent}, cap ${dailyCapCents}`);
      }

      // CASH ONLY — `from.fuliza` is deliberately not consulted (0203 header).
      if (from.balance < amountCents) throw new Error(`INSUFFICIENT_FUNDS: have ${from.balance}, need ${amountCents}`);

      from.balance -= amountCents; from.updated_at = now();
      to.balance += amountCents;   to.updated_at = now();
      const baseMeta = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
      // One reading for both rows — see the note on `push`.
      const at = now();
      const outId = push(fromId, "transfer_out", -amountCents, from.balance, refOut,
        { ...baseMeta, source: "marketer_transfer", name: to.name, counterparty_marketer_id: toId }, at);
      // `pair_ledger_id` on the IN row only (0205): it is what makes the recipient's confirmation
      // carry the sender's code instead of a second one for the same transfer.
      const inId = push(toId, "transfer_in", amountCents, to.balance, refIn,
        { ...baseMeta, source: "marketer_transfer", name: from.name, counterparty_marketer_id: fromId, pair_ledger_id: outId }, at);
      return {
        idempotent: false,
        from_balance_cents: from.balance,
        to_balance_cents: to.balance,
        out_ledger_id: outId,
        in_ledger_id: inId,
        recipient_name: to.name,
        sent_cents: amountCents,
        out_created_at: at,
      };
    },
    async credit(id: string, amountCents: number, ref: string | null, meta: unknown, actor?: MarketerActor): Promise<number> {
      fence("credit", byId.get(id)?.site_id, actor);
      if (amountCents <= 0) throw new Error("AMOUNT_MUST_BE_POSITIVE");
      if (ref && refs.has(ref)) return refs.get(ref)!.balance;
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      m.balance += amountCents; m.updated_at = now();
      const lid = push(id, "credit", amountCents, m.balance, ref, meta);
      if (ref) refs.set(ref, { balance: m.balance, ledgerId: lid });
      return m.balance;
    },
    async topupDemo(id: string, capCents: number): Promise<number> {
      if (capCents == null || capCents <= 0 || capCents > 100_000_000) throw new Error("INVALID_CAP");
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      if (m.status !== "active") throw new Error(`MARKETER_NOT_ACTIVE:${m.status}`);
      if (m.balance >= capCents) return m.balance;          // idempotent no-op once at/above cap
      const add = capCents - m.balance; m.balance += add; m.updated_at = now();
      push(id, "credit", add, m.balance, `self_demo_topup:${now()}`, { source: "self_service_demo" });
      return m.balance;
    },
    async withdraw(id: string, amountCents: number, ref: string | null, meta: unknown, _method: string, actor?: MarketerActor): Promise<WithdrawResult> {
      fence("withdraw", byId.get(id)?.site_id, actor);
      if (amountCents <= 0) throw new Error("AMOUNT_MUST_BE_POSITIVE");
      if (ref && refs.has(ref)) { const e = refs.get(ref)!; return { idempotent: true, balance_cents: e.balance, ledger_id: e.ledgerId }; }
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      if (m.status !== "active") throw new Error(`MARKETER_NOT_ACTIVE:${m.status}`);
      // FULIZA COVERS A SHORTFALL ON A WITHDRAWAL, exactly as fn_marketer_withdraw (0033) does.
      // This mirror used to refuse at `m.balance < amountCents` and never touch m.fuliza, so every
      // route test about a withdrawal was testing behaviour the database does not have — and the
      // `fuliza_used_cents` branch of ledgerToTxDto had never been exercised by anything. BUGLOG #147.
      const spendable = m.balance + m.fuliza;
      if (spendable < amountCents) throw new Error(`INSUFFICIENT_FUNDS: have ${spendable}, need ${amountCents}`);
      const fromFuliza = Math.max(amountCents - m.balance, 0);
      m.balance = Math.max(m.balance - amountCents, 0);
      m.fuliza -= fromFuliza;
      m.updated_at = now();
      const wMeta = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
      const lid = push(id, "withdrawal", -amountCents, m.balance, ref, { ...wMeta, fuliza_used_cents: fromFuliza });
      if (ref) refs.set(ref, { balance: m.balance, ledgerId: lid });
      return { idempotent: false, balance_cents: m.balance, withdrawal_id: `w-${lid}`, ledger_id: lid };
    },
    async setFuliza(id: string, amountCents: number, actor?: MarketerActor): Promise<number> { fence("setFuliza", byId.get(id)?.site_id, actor); if (amountCents < 0) throw new Error("AMOUNT_MUST_BE_NONNEGATIVE"); const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND"); m.fuliza = amountCents; m.updated_at = now(); return amountCents; },
    async setAirtime(id: string, amountCents: number, actor?: MarketerActor): Promise<number> { fence("setAirtime", byId.get(id)?.site_id, actor); if (amountCents < 0) throw new Error("AMOUNT_MUST_BE_NONNEGATIVE"); const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND"); m.airtime = amountCents; m.updated_at = now(); return amountCents; },
    async statement(id: string, limit: number): Promise<MarketerLedgerRow[]> { return (ledgers.get(id) ?? []).slice().reverse().slice(0, limit); },
    /**
     * Mirrors fn_marketer_statement_summary (0206) — SAME bucket mapping, including the reading
     * that game-winnings credits are OTHERS and not an AGENT DEPOSIT. If these two ever disagree,
     * the route tests are proving a convenient fiction rather than the product.
     */
    async setEmail(id: string, email: string | null): Promise<string | null> {
      // Mirrors fn_marketer_set_email: trimmed, lower-cased, empty becomes null.
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      if (m.status !== "active") throw new Error(`MARKETER_NOT_ACTIVE:${m.status}`);
      const clean = (email ?? "").trim().toLowerCase() || null;
      if (clean !== null && (clean.length < 6 || clean.length > 254 || !/.+@.+\..{2,}/.test(clean))) {
        throw new Error("INVALID_EMAIL");
      }
      m.email = clean;
      return clean;
    },

    /** Mirrors fn_marketer_buy_airtime (0207): cash only, one debit row, idempotent on ref. */
    async buyAirtime(id: string, amountCents: number, ref: string | null, meta: unknown, minCents: number) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("AMOUNT_MUST_BE_POSITIVE");
      if (amountCents < Math.max(minCents, 1)) throw new Error(`AMOUNT_BELOW_MINIMUM: min ${Math.max(minCents, 1)}`);
      if (ref) {
        const hit = [...ledgers.values()].flat().find((r) => r.ref === ref);
        if (hit) {
          return {
            idempotent: true,
            balance_cents: hit.balance_after_cents,
            airtime_balance_cents: byId.get(id)?.airtime ?? 0,
            ledger_id: hit.id,
            created_at: hit.created_at,
          };
        }
      }
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      if (m.status !== "active") throw new Error(`MARKETER_NOT_ACTIVE:${m.status}`);
      // CASH ONLY — `m.fuliza` is deliberately not consulted (0207 header).
      if (m.balance < amountCents) throw new Error(`INSUFFICIENT_FUNDS: have ${m.balance}, need ${amountCents}`);
      m.balance -= amountCents;
      m.airtime += amountCents;
      m.updated_at = now();
      const baseMeta = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
      const lid = push(id, "airtime", -amountCents, m.balance, ref, { ...baseMeta, source: "airtime_purchase" });
      const row = (ledgers.get(id) ?? []).find((r) => r.id === lid)!;
      return {
        idempotent: false,
        balance_cents: m.balance,
        airtime_balance_cents: m.airtime,
        ledger_id: lid,
        created_at: row.created_at,
      };
    },

    async statementSummary(id: string, fromIso: string, toIso: string) {
      const from = Date.parse(fromIso), to = Date.parse(toIso);
      const rows = (ledgers.get(id) ?? []).filter((r) => {
        const t = Date.parse(r.created_at);
        return t >= from && t < to;
      });
      const buckets: Record<string, { in: number; out: number }> = {
        "SEND MONEY": { in: 0, out: 0 }, "RECEIVED MONEY": { in: 0, out: 0 },
        "AGENT DEPOSIT": { in: 0, out: 0 }, "AGENT WITHDRAWAL": { in: 0, out: 0 },
        OTHERS: { in: 0, out: 0 },
      };
      for (const r of rows) {
        const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
        const source = typeof meta.source === "string" ? meta.source : "";
        const bucket =
          r.entry_type === "transfer_out" ? "SEND MONEY"
          : r.entry_type === "transfer_in" ? "RECEIVED MONEY"
          : r.entry_type === "withdrawal" ? "AGENT WITHDRAWAL"
          : r.entry_type === "credit" && source !== "game_withdrawal" && source !== "game_withdrawal_approved"
            ? "AGENT DEPOSIT"
            : "OTHERS";
        buckets[bucket]!.in += Math.max(r.amount_cents, 0);
        buckets[bucket]!.out += Math.max(-r.amount_cents, 0);
      }
      const paid_in_cents = Object.values(buckets).reduce((a, b) => a + b.in, 0);
      const paid_out_cents = Object.values(buckets).reduce((a, b) => a + b.out, 0);
      return { buckets, txn_count: rows.length, paid_in_cents, paid_out_cents };
    },
    /**
     * Newest `cap` rows of the range, returned oldest-first — the shape 0206/0208 guarantee.
     *
     * Sorted by (created_at, id), not by insertion order: `id` and `created_at` can disagree,
     * because now() is transaction START time while the id is drawn at INSERT time (BUGLOG #149).
     * `id` remains the tie-breaker so the two halves of a transfer, which share a timestamp to the
     * microsecond, keep the debit before the credit.
     */
    async statementRange(id: string, fromIso: string, toIso: string, cap: number): Promise<MarketerLedgerRow[]> {
      const from = Date.parse(fromIso), to = Date.parse(toIso);
      const inRange = (ledgers.get(id) ?? []).filter((r) => {
        const t = Date.parse(r.created_at);
        return t >= from && t < to;
      });
      // Mirrors fn_marketer_statement_range (0209): take the NEWEST `cap` rows, then hand them back
      // newest-first. The two steps are separate on purpose — sorting descending and then slicing
      // the head would look equivalent and would be, but doing it in one step invites the inverse
      // mistake of slicing the OLDEST rows, which is silent and wrong.
      inRange.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
      return inRange.slice(-Math.max(cap, 1)).reverse();
    },
    async setPin(id: string, pin: string, actor?: MarketerActor): Promise<void> { fence("setPin", byId.get(id)?.site_id, actor); if (!/^\d{4,6}$/.test(pin)) throw new Error("INVALID_PIN"); if (!byId.has(id)) throw new Error("MARKETER_NOT_FOUND"); pins.set(id, pin); },
    async login(phone: string, pin: string, siteId?: string): Promise<string | null> {
      // Mirrors fn_marketer_login (0093): a phone is unique only within a brand, so match the PIN
      // across every brand holding this phone (or scope to one brand when siteId is given). The PIN
      // — not a client-supplied brand — identifies the marketer, so a shared phone never leaks.
      const candidates = [...byId.values()]
        .filter((m) => m.phone === phone && (siteId == null || m.site_id === siteId))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const m of candidates) {
        if (m.status !== "active") continue;
        if (pins.get(m.id) === pin) return m.id;
      }
      return null;
    },
    async changePin(id: string, currentPin: string, newPin: string): Promise<void> {
      if (!/^\d{4,6}$/.test(newPin)) throw new Error("INVALID_PIN");
      if (!pins.has(id)) throw new Error("NO_PIN_SET");
      if (pins.get(id) !== currentPin) throw new Error("INVALID_CREDENTIALS");
      pins.set(id, newPin);
    },
    async setStatus(id: string, status: string, actor?: MarketerActor): Promise<string> {
      fence("setStatus", byId.get(id)?.site_id, actor);
      if (!["active", "suspended", "disabled"].includes(status)) throw new Error("INVALID_STATUS");
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      m.status = status; m.updated_at = now(); return status;
    },
    async delete(id: string, siteId?: string): Promise<{ deleted: boolean }> {
      const m = byId.get(id);
      if (!m || (siteId && m.site_id !== siteId)) return { deleted: false };
      byId.delete(id); byPhone.delete(pkey(m.phone, m.site_id)); ledgers.delete(id); pins.delete(id);
      return { deleted: true };
    },
    // ── Security questions + force-logout (0198) ──
    async getSecurityAnswers(id: string): Promise<{ questionKey: string; answerHash: string }[]> {
      const m = securityAnswers.get(id);
      if (!m) return [];
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([questionKey, answerHash]) => ({ questionKey, answerHash }));
    },
    async setSecurityAnswers(id: string, answers: { questionKey: string; answerHash: string }[]): Promise<void> {
      // Replace the whole set (mirror the Pg upsert-and-prune): the stored map becomes exactly `answers`.
      securityAnswers.set(id, new Map(answers.map((a) => [a.questionKey, a.answerHash])));
    },
    async forceLogout(id: string): Promise<void> { forceLogoutAt.set(id, Date.now()); },
    // Test-only: register a brand (site) display name so profiles resolve `brand_name` like the
    // 0096 view does in production. Mirrors the `_seed*` helpers on the affiliate in-memory repo.
    _setBrandName(siteId: string, name: string): void { brandBySite.set(siteId, name); },
    _setActorSite(actorId: string, siteId: string): void { actorSites.set(actorId, siteId); },
    _lastActor(method: string): MarketerActor | undefined { return lastActor.get(method); },
  };
}

// ── Support-chat fakes (deterministic; no ONNX, no network) ─────────────────────────────
const EMBED_DIMS = 384;
/** Deterministic zero-model embedder: token-hashed bag-of-words, L2-normalised (mirrors the
 *  Python `hash_embed` used by the DB e2e). Lexical, not semantic, but perfect for asserting
 *  the retrieval pipeline (cosine ordering + scoping) with hand-crafted chunks. */
export function makeHashEmbed(dims = EMBED_DIMS): EmbedFn {
  return async (texts: string[]) =>
    texts.map((t) => {
      const v = new Array<number>(dims).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const h = createHash("sha256").update(tok).digest();
        const idx = h.readUInt32BE(0) % dims;
        v[idx]! += (h[8]! & 1) === 0 ? 1 : -1;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map((x) => x / norm);
    });
}

const dot = (a: number[], b: number[]): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
};

export interface SeedChunk { siteId: string | null; source: string; heading?: string | null; content: string; }

export interface SupportHarness {
  deps: SupportDeps;
  store: SupportStore;
  /** Seed KB chunks (site_id null = shared). Vectors are computed with the hash embedder. */
  seedKb(chunks: SeedChunk[]): Promise<void>;
  /** Swap the LLM at runtime (default echoes an em-dash answer that quotes the top context). */
  setLlm(fn: LlmFn): void;
  llmCalls: LlmMessage[][];
  conversations: Map<string, SupportConversation>;
  messages: Map<string, SupportMessageRow[]>;
}

/** Build the in-memory support deps: hash embedder, seedable KB, recording store, fake LLM. */
export function makeSupportHarness(brandOf: (siteId: string) => SupportBrandInfo): SupportHarness {
  const embed = makeHashEmbed();
  const kb: Array<{ siteId: string | null; source: string; heading: string | null; content: string; vector: number[] }> = [];
  const llmCalls: LlmMessage[][] = [];
  let llm: LlmFn = async (messages) => {
    // Default: quote the first context line and deliberately include an em dash so tests can
    // prove the transport strips it. If no context, answer with an uncertain line.
    const sys = messages[0]?.content ?? "";
    const m = sys.match(/\n\[1\][^\n]*\n([^\n]+)/);
    return m ? `Here is what I found \u2014 ${m[1]}` : "I am not certain about that, let me connect you with a human.";
  };

  const conversations = new Map<string, SupportConversation>();
  const messages = new Map<string, SupportMessageRow[]>();
  let cseq = 0, mseq = 0;
  const now = () => new Date().toISOString();

  const store: SupportStore = {
    async start(siteId, opts) {
      const id = `c0000000-0000-0000-0000-${String(++cseq).padStart(12, "0")}`;
      conversations.set(id, {
        id, siteId, userId: opts.userId ?? null, visitorId: opts.visitorId ?? null,
        status: "open", escalated: false, contactEmail: null, contactPhone: null,
        createdAt: now(), lastAt: now(), accessHash: opts.accessHash,
      });
      messages.set(id, []);
      return id;
    },
    async log(conversationId, role, content, sources, confidence) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("CONVERSATION_NOT_FOUND");
      const id = `d0000000-0000-0000-0000-${String(++mseq).padStart(12, "0")}`;
      (messages.get(conversationId) ?? []).push({
        id, conversationId, siteId: conv.siteId, role, content, sources, confidence, createdAt: now(),
      });
      conv.lastAt = now();
      return id;
    },
    async escalate(conversationId, contact) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("CONVERSATION_NOT_FOUND");
      conv.escalated = true;
      conv.status = "escalated";
      conv.contactEmail = contact.email ?? conv.contactEmail;
      conv.contactPhone = contact.phone ?? conv.contactPhone;
      conv.lastAt = now();
    },
    async getConversation(conversationId) {
      return conversations.get(conversationId) ?? null;
    },
    async listMessages(conversationId) {
      return (messages.get(conversationId) ?? []).slice();
    },
    async listConversations(scope, opts) {
      return [...conversations.values()]
        .filter((c) => scope === null || c.siteId === scope)
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
        .slice(0, opts.limit);
    },
  };

  const searchKb = async (siteId: string, embedding: number[], k: number): Promise<KbHit[]> =>
    kb
      .filter((c) => c.siteId === null || c.siteId === siteId)
      .map((c) => ({ source: c.source, heading: c.heading, content: c.content, distance: 1 - dot(c.vector, embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);

  const deps: SupportDeps = {
    store,
    embed,
    searchKb,
    llm: (messages2, opts) => { llmCalls.push(messages2); return llm(messages2, opts); },
    brandInfo: async (siteId) => brandOf(siteId),
  };

  return {
    deps,
    store,
    async seedKb(chunks) {
      const vectors = await embed(chunks.map((c) => c.content));
      chunks.forEach((c, i) => kb.push({ siteId: c.siteId, source: c.source, heading: c.heading ?? null, content: c.content, vector: vectors[i]! }));
    },
    setLlm(fn) { llm = fn; },
    llmCalls,
    conversations,
    messages,
  };
}

/**
 * In-memory test harness: builds an app from REAL engine services backed by in-memory
 * repositories, listens on an ephemeral port, and returns the base URL + a close fn + the
 * underlying fakes so tests can pre-seed and assert. No Postgres, no real network.
 *
 * The stub verifier accepts a `<userId>` or `<userId>:<role>` bearer token so player and
 * finance-admin routes can be exercised without minting JWTs.
 * in the harness (rateLimitMs:0) — its time-based behaviour is covered by unit tests.
 */
export function stubVerifier(): Verifier {
  return async (token: string): Promise<AuthClaims> => {
    if (!token) throw new Error("TOKEN_REQUIRED");
    // `<userId>` | `<userId>:<role>` | `<userId>:<role>:<siteId>` | `<userId>:<role>:<siteId>:<platformId>`
    // — the optional 3rd/4th segments exercise the JWT `site` (requireSite) and `platform`
    // (adminScopePlatform, Issue 1) claims. An optional 5th segment is the token `iat` (seconds),
    // which the 0196 idle gate and the 0198 marketer force-logout epoch read from `raw.iat`; tokens
    // with four or fewer segments keep `raw: {}` exactly as before.
    const [userId, role, site, platform, iat] = token.split(":");
    if (!userId) throw new Error("TOKEN_INVALID");
    const raw = iat !== undefined && iat !== "" ? { iat: Number(iat) } : {};
    return { userId, role: role || "player", ...(site ? { site } : {}), ...(platform ? { platform } : {}), raw };
  };
}

export const TEST_USER = "u-test";
export const TEST_ADMIN = "u-admin";

/** Two brands on one deployment, for site-scoping tests (docs/22 Task E). */
export const SITE_A = "00000000-0000-0000-0000-000000000001";
export const SITE_B = "22222222-2222-2222-2222-222222222222";
export const TEST_BRANDS: Record<string, Brand> = {
  "invest254.com": {
    siteId: SITE_A, slug: "invest254", name: "Invest254", wordmarkText: "invest254.com",
    logoUrl: null, faviconUrl: null, colorPrimary: "#22c55e", colorBg: "#0a0a0a", colorAccent: "#06b6d4",
    theme: "dark", currency: "KES", locale: "en-KE", licenceLine: "Operated under licence.", supportEmail: null,
  },
  "brandb.example": {
    siteId: SITE_B, slug: "brandb", name: "Brand B", wordmarkText: null,
    logoUrl: null, faviconUrl: null, colorPrimary: "#f97316", colorBg: "#111111", colorAccent: "#a855f7",
    theme: "light", currency: "KES", locale: "en-KE", licenceLine: null, supportEmail: "support@brandb.example",
  },
};
/** Resolve a brand by primary host or slug (mirrors the Pg resolver in server.ts, incl. www-fold). */
export function resolveTestBrand(hostOrSlug: string): Brand | null {
  const k = normalizeHost(hostOrSlug);
  if (!k) return null;
  for (const b of Object.values(TEST_BRANDS)) if (b.slug === k) return b;
  for (const [host, b] of Object.entries(TEST_BRANDS)) if (normalizeHost(host) === k) return b;
  return null;
}

export interface TestApi {
  baseUrl: string;
  deps: ApiDeps;
  identity: InMemoryIdentityRepository;
  engage: InMemoryEngagementRepository;
  payRepo: InMemoryPaymentRepository;
  gameRepo: InMemoryGameRepository;
  daraja: StubDarajaClient;
  fairness: Map<number, FairnessRecord>;
  bonus: Map<string, Cents>;
  withdrawalSuccesses: Array<{ userId: string; amountCents: Cents }>;
  /** Raw onWithdrawalRequested events captured for the admin push fan-out (Issue 1). */
  withdrawalRequests: Array<WithdrawalRequestedEvent>;
  /** Every Web Push the capturing transport was asked to deliver (endpoint + decoded payload). */
  pushSends: Array<{ endpoint: string; payload: any }>;
  /** The push subscription store, so tests can seed admin devices directly. */
  pushRepo: InMemoryPushSubscriptionRepository;
  /** F-48 seam: site -> platform for push recipient scoping (platform_admin alerts). */
  pushSitePlatform: Map<string, string>;
  push: PushService;
  /** Await all in-flight fire-and-forget push fan-outs (the events are dispatched un-awaited). */
  flushPush(): Promise<unknown>;
  notifications: NotificationService;
  marketers: MarketerRepo;
  referral: InMemoryReferralRepo;
  /** The in-memory platform repo, so tests can seed brands + marketer rollup rows (Task R). */
  platformRepo: InMemoryPlatformRepository;
  /** The in-memory admin repo (docs/42 UI-10: tests spy on the platform audit query). */
  adminRepo: InMemoryAdminRepository;
  ticketRepo: InMemoryTicketRepository;
  /** Support-chat fakes (seed KB, swap LLM, inspect recorded conversations/messages). */
  support: SupportHarness;
  /** Instant-onboarding fake: recorded inputs + the in-memory deps. */
  onboard: { calls: OnboardInput[]; deps: PlatformOnboardDeps };
  close(): Promise<void>;
}

export interface TestApiOptions { startingBalanceCents?: Cents; depsOverrides?: Partial<ApiDeps>; }

export async function startTestApi(opts: TestApiOptions = {}): Promise<TestApi> {
  const engage = new InMemoryEngagementRepository();
  engage.setUsername(TEST_USER, "tester");

  const payRepo = new InMemoryPaymentRepository();
  payRepo.seed(TEST_USER, opts.startingBalanceCents ?? 1_000_000); // KES 10,000
  const gameRepo = new InMemoryGameRepository();
  gameRepo.seed(TEST_USER, opts.startingBalanceCents ?? 1_000_000);
  const daraja = new StubDarajaClient();
  const withdrawalSuccesses: Array<{ userId: string; amountCents: Cents }> = [];

  const resolveHandle = async (userId: string): Promise<string> =>
    (await engage.getUsername(userId)) ?? `guest_${userId.slice(0, 6)}`;

  // Late-bound so the withdrawal kill switch reads the SAME in-memory admin repo the toggle route
  // writes to (the admin repo is created below, after PaymentService). Resolver runs at request time.
  let adminRepoRef: InMemoryAdminRepository | undefined;
  const TU_DEFAULT_SITE_ID = "00000000-0000-0000-0000-000000000001";

  // Admin Web Push fan-out (Issue 1): an in-memory subscription store + a capturing transport that
  // records every send. An endpoint containing "gone" simulates a dead subscription (HTTP 410) so
  // tests can assert the self-healing prune. The VAPID public key is a fixed test sentinel.
  // Issue 1 / F-48: alert recipients are decided from each subscriber's LIVE profile (the identity repo,
  // assigned below) and the withdrawal brand's platform (`pushSitePlatform`, a test seam; unmapped =
  // no platform, so a platform_admin is alerted only for brands a test maps to its platform).
  let identityForPush: { getProfile(userId: string): Promise<{ role: string; status: string; siteId: string | null; platformId: string | null } | null> } | undefined;
  const pushSitePlatform = new Map<string, string>();
  const pushRepo = new InMemoryPushSubscriptionRepository({
    profileOf: async (userId) => {
      const p = await identityForPush?.getProfile(userId);
      return p ? { role: p.role, status: p.status, siteId: p.siteId, platformId: p.platformId } : null;
    },
    platformOfSite: (siteId) => pushSitePlatform.get(siteId) ?? null,
  });
  const pushSends: Array<{ endpoint: string; payload: any }> = [];
  const pushTransport = {
    publicKey: (): string | null => "TEST_VAPID_PUBLIC_KEY",
    async send(sub: PushSubscriptionRow, payload: string): Promise<PushSendResult> {
      pushSends.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      if (sub.endpoint.includes("gone")) return { ok: false, statusCode: 410, gone: true };
      return { ok: true, statusCode: 201 };
    },
  };
  const push = new PushService(pushRepo, pushTransport, { resolveHandle, appBaseUrl: "https://test.invest254.local" });
  const withdrawalRequests: Array<WithdrawalRequestedEvent> = [];
  const pushPromises: Array<Promise<unknown>> = [];

  const payments = new PaymentService(payRepo, daraja, {
    megapay: new StubMegaPayClient(), // Mega Pay rail (0116): deterministic offline client for route tests
    payhero: new StubPayHeroClient(), // PayHero rail: deterministic offline client for route tests
    paynicorn: new StubPaynicornClient(), // Paynicorn rail: offline client; postbacks sign with STUB_PAYNICORN_SECRET
    withdrawalsEnabledForSite: async (siteId) =>
      adminRepoRef ? adminRepoRef.getWithdrawalsEnabled(siteId ?? TU_DEFAULT_SITE_ID) : true,
    events: {
      onWithdrawalSuccess: (e) => {
        withdrawalSuccesses.push(e);
      },
      onWithdrawalRequested: (e) => {
        withdrawalRequests.push(e);
        pushPromises.push(push.notifyWithdrawalRequested(e));
      },
    },
  });


  const fairness = new Map<number, FairnessRecord>([
    [1, { gameDayId: 1, tradeDate: "2026-06-17", serverSeedHash: "hash-yesterday", serverSeed: "revealed-seed-yesterday", revealedAt: "2026-06-18T00:00:00.000Z" }],
    [2, { gameDayId: 2, tradeDate: "2026-06-18", serverSeedHash: "hash-today", serverSeed: null, revealedAt: null }],
  ]);
  const bonus = new Map<string, Cents>();

  const identity = new InMemoryIdentityRepository();
  identityForPush = identity;
  const auth = new AuthService(identity, { jwtSecret: "test-secret-which-is-long-enough-123456", jwtTtlSeconds: 3600 });
  const affiliate = new AffiliateService(identity, daraja);
  const adminRepo = new InMemoryAdminRepository(identity, payRepo, engage, gameRepo);
  adminRepoRef = adminRepo;
  const admin = new AdminService(adminRepo);
  const platformRepo = new InMemoryPlatformRepository();
  // 0173 — keep the bonus switch truthful across the two in-memory stores: the platform switch and
  // the site→platform mapping live in the platform repo, the system/brand switches in the admin repo,
  // and the grant asks the composed answer. In Postgres this is one join inside fn_bonuses_enabled.
  platformRepo.onPlatformBonuses = (platformId, enabled) => adminRepo.setPlatformBonuses(platformId, enabled);
  platformRepo.onSitePlatform = (siteId, platformId) => adminRepo.platformOfSite.set(siteId, platformId);
  identity.bonusesEnabledForSite = (siteId) => adminRepo.bonusesEffective(siteId ?? TU_DEFAULT_SITE_ID);
  const platform = new PlatformService(platformRepo);
  const subscriptionRepo = new InMemorySubscriptionRepository();
  const subscriptions = new SubscriptionService(subscriptionRepo);
  const ticketRepo = new InMemoryTicketRepository();
  const tickets = new TicketService(ticketRepo);
  const notifications = new NotificationService(new InMemoryNotificationRepository());

  // Support-chat harness: resolve brand facts from the seeded test brands (default fallback).
  const support = makeSupportHarness((siteId) => {
    const b = Object.values(TEST_BRANDS).find((x) => x.siteId === siteId);
    return { name: b?.name ?? "Invest254", supportEmail: b?.supportEmail ?? null, currency: b?.currency ?? "KES" };
  });

  // Instant-onboarding harness: an in-memory PlatformOnboardDeps that records inputs and returns
  // a deterministic provision result (no real Cloudflare/Namecheap calls).
  const onboardCalls: OnboardInput[] = [];
  const onboardDeps: PlatformOnboardDeps = {
    domainConfigured: true,
    registrarConfigured: true,
    async capabilities(_platformId: string | null) { return { domainConfigured: true, registrarConfigured: true }; },
    async onboard(input: OnboardInput, _platformId: string | null): Promise<OnboardResult> {
      onboardCalls.push(input);
      const host = input.primaryDomain ? input.primaryDomain.trim().toLowerCase() : null;
      const brand = {
        siteId: `site-${input.slug}`, slug: input.slug, name: input.name, primaryDomain: host,
        currency: input.currency ?? "KES", status: "active", resolvesByHost: Boolean(host),
      };
      const domain = input.provisionDomain && host
        ? { domain: host, zoneId: "z-test", nameServers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"], zoneStatus: "pending", nameserversUpdated: true, pages: [{ name: host, status: "initializing" }, { name: `www.${host}`, status: "initializing" }], note: "test" }
        : null;
      return { siteId: brand.siteId, brand, domain };
    },
    async domainStatus(d: string) {
      return { domain: d, zoneStatus: "pending", pages: [{ name: d, status: "initializing" }], active: false };
    },
    async listRegistrarDomains(_platformId: string | null) {
      return {
        registrarConfigured: true,
        domains: [
          { domain: "newbrand.com", expires: "01/01/2027", usingRegistrarDns: true, alreadyClient: false, suggestedSlug: "newbrand", suggestedName: "Newbrand" },
          { domain: "tamutraders.com", expires: "01/01/2027", usingRegistrarDns: false, alreadyClient: true, suggestedSlug: "tamutraders", suggestedName: "Tamutraders" },
        ],
      };
    },
    async domainHealth() {
      // tamutraders live; shikafx pending (zone not yet active) — mirrors real, truthful states.
      return { configured: true, statuses: { "tamutraders.com": "active", "www.tamutraders.com": "active", "shikafx.com": "pending" } };
    },
  };

  // In-memory registrar-config harness (Issue 1 #3): records per-platform config so the API endpoints
  // can be exercised without a DB. Real scoping/encryption is proven by e2e_registrar_config.py.
  const registrarStore = new Map<string, { settings: Record<string, string>; hasSecret: boolean }>();
  const registrarConfig: RegistrarConfigDeps = {
    async get(_a, _r, platformId) {
      const cur = registrarStore.get(platformId);
      return {
        platformId, providerCode: "namecheap", settings: cur?.settings ?? {},
        secretMeta: cur?.hasSecret ? { api_key: { set: true, last4: "cb60" } } : {},
        hasSecret: Boolean(cur?.hasSecret), encVersion: 1,
        updatedAt: cur ? new Date().toISOString() : null, exists: Boolean(cur),
        egressIp: "203.0.113.9", encryptionConfigured: true,
      };
    },
    async set(_a, _r, platformId, values) {
      const cur = registrarStore.get(platformId) ?? { settings: {}, hasSecret: false };
      if (typeof values.apiUser === "string") cur.settings.api_user = values.apiUser.trim();
      if (typeof values.userName === "string") cur.settings.username = values.userName.trim();
      if (typeof values.clientIp === "string") cur.settings.client_ip = values.clientIp.trim();
      if (values.apiKey !== undefined) cur.hasSecret = String(values.apiKey).trim() !== "";
      registrarStore.set(platformId, cur);
      return { platformId, hasSecret: cur.hasSecret, settings: cur.settings, exists: true };
    },
    async test(_a, _r, _platformId, draft) {
      const ok = Boolean((draft.apiKey ?? "").trim() && (draft.apiUser ?? "").trim());
      return { ok, detail: ok ? "Connected. Namecheap API responded successfully." : "Enter the Namecheap API user and API key first.", egressIp: "203.0.113.9" };
    },
  };

  // In-memory add-on stub (Issue 2): canned catalog/brand-view so the API endpoints + role guards can
  // be tested without a DB. Real catalog/entitlement/scope logic is proven by e2e_addon_entitlements.py.
  const addons: AddonDeps = {
    async catalog() {
      return [
        { category: "chart", key: "line", display_name: "Line graph", price_cents: 0, is_default: true, active: true, sort_order: 10 },
        { category: "chart", key: "candlestick", display_name: "Candlesticks", price_cents: 0, is_default: false, active: true, sort_order: 30 },
        { category: "payment_gateway", key: "paystack", display_name: "Paystack", price_cents: 1000000, is_default: false, active: true, sort_order: 30 },
      ];
    },
    async setPrice(_a, _r, category, key, priceCents) { return { category, key, price_cents: priceCents }; },
    async brandView() {
      return [
        { category: "chart", key: "line", display_name: "Line graph", price_cents: 0, is_default: true, entitled: true, active: true, pending: false },
        { category: "chart", key: "candlestick", display_name: "Candlesticks", price_cents: 0, is_default: false, entitled: false, active: false, pending: false },
        { category: "payment_gateway", key: "paystack", display_name: "Paystack", price_cents: 1000000, is_default: false, entitled: false, active: false, pending: false },
      ];
    },
    async request(_a, _r, site, category, key) { return { id: 1, site_id: site, category, key, status: "requested" }; },
    async listRequests() { return []; },
    async decideRequest(_a, _r, id, decision) { return { id, status: `${decision}d` }; },
    async grant(_a, _r, site, category, key) { return { site_id: site, category, key, entitled: true }; },
    async revoke(_a, _r, site, category, key) { return { site_id: site, category, key, entitled: false }; },
    // ADDON-1 (scope/rules proven by e2e_addon_marketplace.py): no request is seeded here, so a cancel of
    // an unknown id is refused like the RPC does.
    async update(_a, role, category, key, patch) { if (role !== "platform_superadmin") throw new Error("NOT_AUTHORIZED"); return { category, key, ...patch }; },
    async cancelRequest() { throw new Error("REQUEST_NOT_FOUND"); },
    async activate(_a, _r, site, category, key) {
      if (category !== "chart" && category !== "trade_ui") throw new Error("NOT_SWITCHABLE");
      if (key !== "line" && key !== "classic") throw new Error("NOT_ENTITLED");
      return { site_id: site, category, key, active: true };
    },
    async brands() { return []; },
  };

  const referralRepo = makeInMemoryReferralRepo();
  // Hoisted so the advance fake can log an expense on approval (mirrors fn_admin_decide_advance).
  const marketerExpensesFake = (() => {
    const rows: Array<{ id: string; marketerUserId: string; category: string; amountCents: number; note: string | null; createdBy: string | null; createdAtMs: number }> = [];
    let seq = 0;
    return {
      async add(actorId: string, actorRole: string, _siteId: string, marketerUserId: string, category: string, amountCents: number, note: string | null) {
        if (!["admin", "platform_admin", "platform_superadmin"].includes(actorRole)) throw new Error("NOT_AUTHORIZED");
        if (!category.trim()) throw new Error("CATEGORY_REQUIRED");
        if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
        const row = { id: `exp-${++seq}`, marketerUserId, category: category.trim(), amountCents, note: note && note.trim() ? note.trim() : null, createdBy: actorId, createdAtMs: Date.now() };
        rows.unshift(row);
        return { id: row.id, category: row.category, amountCents: row.amountCents, note: row.note, createdAtMs: row.createdAtMs, createdBy: row.createdBy };
      },
      async list(marketerUserId: string, limit: number) {
        return rows.filter((r) => r.marketerUserId === marketerUserId).slice(0, limit)
          .map((r) => ({ id: r.id, category: r.category, amountCents: r.amountCents, note: r.note, createdAtMs: r.createdAtMs, createdBy: r.createdBy }));
      },
      async total(marketerUserId: string) {
        return rows.filter((r) => r.marketerUserId === marketerUserId).reduce((s, r) => s + r.amountCents, 0);
      },
    };
  })();

  const marketerAdvancesFake = (() => {
    type Row = { id: string; siteId: string; marketerUserId: string; amountCents: number; reason: string | null; status: "requested" | "approved" | "rejected" | "cancelled"; decisionNote: string | null; decidedAtMs: number | null; expenseId: string | null; createdAtMs: number };
    const rows: Row[] = [];
    let seq = 0;
    const DSITE = "00000000-0000-0000-0000-000000000001";
    const mine = (r: Row) => ({ id: r.id, amountCents: r.amountCents, reason: r.reason, status: r.status, decisionNote: r.decisionNote, decidedAtMs: r.decidedAtMs, expenseId: r.expenseId, createdAtMs: r.createdAtMs });
    const admin = (r: Row) => ({ ...mine(r), marketerUserId: r.marketerUserId, username: null, phone: null, siteId: r.siteId });
    return {
      async request(marketerUserId: string, amountCents: number, reason: string | null) {
        if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
        if (rows.some((r) => r.marketerUserId === marketerUserId && r.status === "requested")) throw new Error("ADVANCE_PENDING");
        const row: Row = { id: `adv-${++seq}`, siteId: DSITE, marketerUserId, amountCents, reason: reason && reason.trim() ? reason.trim() : null, status: "requested", decisionNote: null, decidedAtMs: null, expenseId: null, createdAtMs: Date.now() };
        rows.unshift(row); return mine(row);
      },
      async cancel(marketerUserId: string, id: string) {
        const row = rows.find((r) => r.id === id && r.marketerUserId === marketerUserId && r.status === "requested");
        if (!row) throw new Error("INVALID_STATE");
        row.status = "cancelled"; row.decidedAtMs = Date.now(); return mine(row);
      },
      async listMine(marketerUserId: string, limit: number) {
        return rows.filter((r) => r.marketerUserId === marketerUserId).slice(0, limit).map(mine);
      },
      async decide(actorId: string, actorRole: string, id: string, approve: boolean, note: string | null) {
        if (!["admin", "platform_admin", "platform_superadmin"].includes(actorRole)) throw new Error("NOT_AUTHORIZED");
        const row = rows.find((r) => r.id === id);
        if (!row) throw new Error("NOT_FOUND");
        if (row.status !== "requested") throw new Error("INVALID_STATE");
        const n = note && note.trim() ? note.trim() : null;
        if (approve) {
          const exp = await marketerExpensesFake.add(actorId, actorRole, row.siteId, row.marketerUserId, "advance", row.amountCents, n ?? row.reason ?? "Advance request approved");
          row.status = "approved"; row.expenseId = exp.id;
        } else { row.status = "rejected"; }
        row.decisionNote = n; row.decidedAtMs = Date.now();
        return admin(row);
      },
      async adminList(siteId: string | null, status: string | null, limit: number) {
        return rows.filter((r) => (siteId == null || r.siteId === siteId) && (status == null || r.status === status)).slice(0, limit).map(admin);
      },
      async siteOf(id: string) { const r = rows.find((x) => x.id === id); return r ? r.siteId : null; },
    };
  })();

  const deps: ApiDeps = {
    verifier: stubVerifier(),
    // Silent logger in tests: exercises the request-logging path without spamming test output.
    logger: createLogger({ level: "error", sink: () => {} }),
    auth,
    // The 0196 per-session port, backed by the same in-memory identity repo the rest of this
    // harness uses, so the step-up and logout ROUTES are exercised for real.
    //
    // `stepUp` is deliberately NOT set here: the gate is off by default in tests. Turning it on
    // globally would make every one of the ~2100 tests present a second factor before any write,
    // which tests the gate over and over and the routes not at all. The gate has its own
    // end-to-end test that switches it on explicitly and asserts the splice happens.
    privilegedSessions: {
      getSession: (userId, iat) => identity.getPrivilegedSession(userId, iat),
      recordStepUp: (userId, iat, method) => identity.recordStepUp(userId, iat, method),
      endSessions: (userId) => identity.endPrivilegedSessions(userId),
      forceLogout: (userId) => identity.stampForceLogout(userId),
    },
    affiliate,
    admin,
    platform,
    subscriptions,
    tickets,    notifications,
    push,
    marketers: makeInMemoryMarketerRepo(),
    referral: referralRepo,
    marketerExpenses: marketerExpensesFake,
    marketerAdvances: marketerAdvancesFake,
    config: () => DEFAULT_CONFIG,
    // Brand-aware config for tests: resolve a ref (slug|id) to a TEST brand and return a DISTINCT
    // economy per brand (different maxMultiplier) so tests can prove the response is site-scoped.
    gameConfigForSite: async (ref: string) => {
      const h = normalizeHost(ref);
      const brand = Object.values(TEST_BRANDS).find((b) => b.slug === h || b.siteId === h);
      if (!brand) return null;
      const capBySite: Record<string, number> = { [SITE_A]: 4, [SITE_B]: 5 };
      return { ...DEFAULT_CONFIG, version: 7, maxMultiplier: capBySite[brand.siteId] ?? DEFAULT_CONFIG.maxMultiplier };
    },
    fairnessById: async (id) => fairness.get(id) ?? null,
    brandByHost: async (host) => resolveTestBrand(host),
    payments,
    resolveHandle,
    scopeNames: async (siteId: string | null, platformId: string | null) => {
      const site = siteId ? (await platformRepo.listSites(null)).find((x) => x.siteId === siteId) : undefined;
      const plat = platformId ? (await platformRepo.listPlatforms()).find((x) => x.platformId === platformId) : undefined;
      return { siteName: site?.name ?? null, platformName: plat?.name ?? null };
    },
    walletBalance: async (userId, siteId): Promise<WalletBalance> =>
      ({ real: await payRepo.getBalance(userId, siteId), bonus: bonus.get(userId) ?? 0, currency: "KES" }),
    ledger: (userId, q, siteId) => gameRepo.listLedger(userId, q, siteId),
    positions: (userId, q, siteId) => gameRepo.listPositions(userId, q, siteId),
    digitHistory: (userId, q, siteId) => gameRepo.listDigitHistory(userId, q, siteId),
    positionDetail: (userId, id, siteId) => gameRepo.getPositionDetail(userId, id, siteId),
    transactions: (userId, q, siteId) => payRepo.listTransactions(userId, q, siteId),
    support: support.deps,
    // CHAT-1 / ACCT-1: in-memory live chat + identity verification (so the F-44 matrix attacks their routes).
    liveChat: { store: new InMemoryLiveChatStore(), mediaSecret: "test-media" },
    kyc: { store: new InMemoryKycStore(), mediaSecret: "test-media" },
    platformOnboard: onboardDeps,
    registrarConfig,
    addons,
    // PAY-1: an empty in-memory scope store (no scope configured -> every brand on the System accounts).
    paymentScopes: new PaymentScopeService(new InMemoryPaymentScopeRepository(), {
      callbacks: async () => ({ stkCallbackUrl: "", b2cResultUrl: "", b2cTimeoutUrl: "" }),
    }),
    // BILL-1: scope-enforcing in-memory billing (money logic is proven against Postgres).
    billing: new BillingService(new InMemoryBillingRepository(), { daraja: () => new StubDarajaClient() }),
    ...opts.depsOverrides,
  };

  const server = createApp(deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    deps, identity, engage, payRepo, gameRepo, daraja, fairness, bonus, withdrawalSuccesses,
    withdrawalRequests, pushSends, pushRepo, pushSitePlatform, push, flushPush: () => Promise.all(pushPromises),
    notifications,
    marketers: deps.marketers,
    referral: referralRepo,
    platformRepo,
    adminRepo,
    ticketRepo,
    support,
    onboard: { calls: onboardCalls, deps: onboardDeps },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
