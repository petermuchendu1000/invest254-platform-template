import { randomUUID } from "node:crypto";
import {
  parseCohort, parsePayments, distributeDynamicPool, emaForecast, robustExpectedTurnover,
  type CohortEconomy, type PaymentsEconomy,
} from "@invest254/shared";
import type { Querier } from "./wallet.js";
import { GATEWAY_SCHEMAS, getSchema, splitSubmission, validateConfig, PLAYER_DEPOSIT_RAILS, type GatewaySchema, type ValidationIssue } from "./gatewayschema.js";
import { encryptSecrets, decryptSecrets, isEncryptionConfigured } from "./providercrypto.js";
import { testConnection, type ConnResult } from "./gatewaytest.js";

/**
 * Platform (cross-brand) operations for the platform-superadmin console (docs/22 Task H):
 * onboard a brand, tune its economy, and read per-brand KPIs. All mutations go through the
 * SECURITY DEFINER `fn_platform_*` RPCs (migration 0052), which gate on `platform_superadmin`
 * and write an admin_actions audit row. Reads (listSites) are leak-safe selects.
 */

export interface SiteRow {
  siteId: string; slug: string; name: string; status: string;
  primaryDomain: string | null; logoUrl: string | null; faviconUrl: string | null; wordmarkText: string | null;
  colorPrimary: string; colorBg: string; colorAccent: string; theme: string;
  currency: string; locale: string; chartStyle: string; tradeUi: string; licenceLine: string | null; supportEmail: string | null;
  // Per-brand M-Pesa config (non-secret) + which secret refs are configured + legal copy (docs/24).
  mpesaEnv: string | null; mpesaShortcode: string | null; mpesaCallbackBase: string | null; mpesaB2cInitiator: string | null;
  hasMpesaConsumerKey: boolean; hasMpesaConsumerSecret: boolean; hasMpesaPasskey: boolean; hasMpesaB2cCredential: boolean;
  legalCopy: Record<string, unknown> | null;
  ownerUserId: string | null;
}
export interface SiteConfigRow {
  houseEdge: number; maxMultiplier: number; minStakeCents: number; maxStakeCents: number; minWithdrawalCents: number;
  /** Currency-native minimum withdrawal in the brand's display currency major units (docs/25 §16). */
  minWithdrawalNative?: number | null;
  defaultDurationS: number; tickRateMs: number; driftBias: number; volatility: number; targetWinRate: number; version: number;
}
export interface SiteWithConfig extends SiteRow { config: SiteConfigRow }
export interface SiteKpis {
  siteId: string; slug: string; name: string; status: string;
  users: number; depositsCents: number; withdrawalsCents: number; ggrCents: number; openPositions: number; bets: number;
}
export interface CreateSiteInput { slug: string; name: string; currency?: string | undefined; primaryDomain?: string | null | undefined; }

// ── Platform tier (Issue 1) — grouping entity above sites ────────────────────────────────────────
export interface PlatformRow { platformId: string; slug: string; name: string; status: string; ownerUserId: string | null; notes: string | null; }
export interface PlatformKpis { platformId: string; slug: string; name: string; status: string; sites: number; users: number; siteAdmins: number; platformAdmins: number; }
export interface AppointResult { userId: string; role: string; platformId: string | null; }
/** Per-brand performance over a [fromMs, toMs) window (docs/24 performance filters). Shared columns
 *  (deposits/withdrawals/ggr/bets) reconcile with `overview` when the window spans all time. */
export interface SitePerformance {
  siteId: string; slug: string; name: string; status: string;
  depositsCents: number; withdrawalsCents: number; ggrCents: number; bets: number; stakedCents: number; newPlayers: number;
}
/** A JSON patch of snake_case columns (mirrors the RPC jsonb contract). */
export type JsonPatch = Record<string, unknown>;

/** Platform-wide master config (migration 0092) — the global console's single source of truth. */
export interface GlobalConfig {
  depositsEnabled: boolean; withdrawalsEnabled: boolean; playEnabled: boolean;
  marketersEnabled: boolean; registrationsEnabled: boolean;
  maintenanceMessage: string | null; globalDailyPoolCents: number | null;
  // Migration 0099 — per-field ENFORCE-able economy overrides (global wins over site + user).
  playerEconomy: CohortEconomy; marketerEconomy: CohortEconomy; payments: PaymentsEconomy;
  version: number; updatedAt: string | null;
}
export interface DistributeResult { totalCents: number; mode: string; perSite: Record<string, number>; }
export interface PoolDistribution {
  id: number; totalCents: number; mode: string; siteCount: number;
  perSite: Record<string, number>; createdAt: string;
}

// ── Dynamic (demand-based) pool distribution (docs/25 §15) ──
export interface PoolDemandOpts {
  /** Days of history to forecast from (EAT). Default 14, clamped [3,90]. */
  lookbackDays?: number | undefined;
  /** Global pool total to allocate. Null/omitted ⇒ current sum of active pool-mode brand budgets. */
  totalCents?: number | null | undefined;
  /** EMA smoothing (default 0.4), floor per active brand as fraction of total (default 0.015),
   *  per-brand cap as a multiple of required (default 2.5). */
  alpha?: number | undefined; floorFrac?: number | undefined; capMult?: number | undefined;
  /** Days of history for the OUTAGE-PROOF anti-starvation baseline (docs/25 §15.2). Default 45,
   *  clamped [lookbackDays,90]. Only non-zero days count, so a deposit outage cannot drag it down. */
  baselineDays?: number | undefined;
  /** Absolute per-brand anti-starvation floor in cents. Each active brand is guaranteed at least
   *  max(configuredFloorCents, targetRtp × expectedTurnover). Default 0. */
  configuredFloorCents?: number | undefined;
}
export interface PoolDemandRow {
  siteId: string; slug: string; targetRtp: number;
  forecastTurnoverCents: number; recentTurnoverCents: number; requiredCents: number;
  currentPoolCents: number; suggestedCents: number;
  /** suggested / required — <1 means the brand is under-funded for its target RTP at forecast demand. */
  coverage: number;
  /** OUTAGE-PROOF baseline daily turnover feeding the floor (docs/25 §15.2). */
  expectedTurnoverCents: number;
  /** The guaranteed anti-starvation floor applied to this brand = max(configuredFloor, tRtp×expected). */
  floorCents: number;
}
export interface PoolDemandPreview {
  lookbackDays: number; totalCents: number; alpha: number; floorFrac: number; capMult: number;
  rows: PoolDemandRow[]; suggestedTotalCents: number; reserveCents: number;
  /** Anti-starvation params echoed for audit/visibility (docs/25 §15.2). */
  baselineDays: number; configuredFloorCents: number;
}
export type DistributeDynamicResult = DistributeResult & { preview: PoolDemandPreview };

/** EAT (UTC+3) day strings for the last n days, oldest→newest — the forecast window. */
function eatWindowDays(n: number): string[] {
  const out: string[] = [];
  const nowEat = Date.now() + 3 * 3600 * 1000;
  for (let i = n - 1; i >= 0; i--) out.push(new Date(nowEat - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** One (affiliate, site) row of the cross-brand marketer rollup (docs/22 Task R). A person spans
 *  brands via `marketerGlobalId`; a null id is an unlinked (single-brand) marketer. */
export interface MarketerRollupRow {
  marketerGlobalId: string | null; label: string | null; affiliateUserId: string;
  siteId: string; siteSlug: string; siteName: string;
  clients: number; ggrCents: number; commissionCents: number;
}

/** A registered deposit gateway + its platform-global switch (migration 0116). */
export interface PaymentProviderRow { code: string; displayName: string; enabledGlobal: boolean; sortOrder: number; }
/** A per-brand override forcing a provider on/off for one client (migration 0116). */
export interface PaymentProviderOverride { siteId: string; providerCode: string; enabled: boolean; }
/** The superadmin console view: the registry + every per-site override. */
export interface PaymentProvidersView { providers: PaymentProviderRow[]; overrides: PaymentProviderOverride[]; }

// ── Gateway CONFIG (migration 0130): credentials + settings, secrets encrypted at rest ──
/** Masked config for the console: settings (plaintext) + per-secret-field hints (never the secret). */
export interface ProviderConfigView {
  providerCode: string; siteId: string | null;
  settings: Record<string, string>;
  secretMeta: Record<string, { set: boolean; last4: string }>;
  hasSecret: boolean; encVersion: number; updatedAt: string | null; exists: boolean;
}
/** Service-role resolve: settings + ciphertext for the engine to decrypt at use-time. */
export interface ProviderConfigResolved {
  providerCode: string; siteId: string | null;
  settings: Record<string, string>; secretCiphertext: string | null; encVersion: number; scope: string;
}

export interface PlatformRepository {
  listSites(platformScope?: string | null): Promise<SiteWithConfig[]>;
  createSite(actorId: string, actorRole: string, input: CreateSiteInput): Promise<string>;
  updateSite(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteRow>;
  setSiteConfig(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteConfigRow>;
  overview(actorId: string, actorRole: string): Promise<SiteKpis[]>;
  /** The platform a site belongs to (for API-layer platform-scope enforcement). null if unknown. */
  platformOfSite(siteId: string): Promise<string | null>;
  // ── Platform tier (Issue 1) — SYSTEM-only governance of platforms + platform admins ──
  /** Every platform (leak-safe select; the route gates on platform_superadmin). */
  listPlatforms(): Promise<PlatformRow[]>;
  /** All-platforms overview: one row per platform with headline counts (platform_superadmin only). */
  platformsOverview(actorRole: string): Promise<PlatformKpis[]>;
  /** Create a platform. */
  createPlatform(actorId: string, actorRole: string, slug: string, name: string, ownerUserId?: string | null): Promise<string>;
  /** Edit a platform (name/status/owner_user_id/notes). */
  updatePlatform(actorId: string, actorRole: string, platformId: string, patch: JsonPatch): Promise<PlatformRow>;
  /** Move a site into a platform (re-parent a brand). */
  assignSiteToPlatform(actorId: string, actorRole: string, siteId: string, platformId: string): Promise<{ siteId: string; platformId: string }>;
  /** Appoint a user as platform_admin of a platform (sets role + platform_id atomically). */
  appointPlatformAdmin(actorId: string, actorRole: string, targetUserId: string, platformId: string): Promise<AppointResult>;
  /** Revoke a platform_admin back to a site-level role (clears platform_id). */
  revokePlatformAdmin(actorId: string, actorRole: string, targetUserId: string, newRole: string): Promise<{ userId: string; role: string }>;
  /** Per-brand performance within a time window (read-only; the API route gates on platform_superadmin). */
  /** Per-brand performance in [from, to). `platformScope` (docs/42 UI-5): a platform admin's own platform only; null = every brand. */
  performance(fromMs: number, toMs: number, platformScope?: string | null): Promise<SitePerformance[]>;
  // Task R — cross-brand marketer rollup (reporting only; money stays per site).
  marketerRollup(actorRole: string): Promise<MarketerRollupRow[]>;
  createMarketerGlobal(actorId: string, actorRole: string, label: string): Promise<string>;
  linkMarketer(actorId: string, actorRole: string, affiliateUserId: string, globalId: string | null): Promise<void>;
  /** Persist a brand's full design-token palette (docs/22 Task G+). platform_superadmin-gated. */
  setSiteTheme(actorId: string, actorRole: string, siteId: string, tokens: JsonPatch): Promise<SiteRow>;
  /** Assign/clear the brand's marketer (owner_user_id) — the site-owner commission model (0081/0082). */
  setSiteOwner(actorId: string, actorRole: string, siteId: string, ownerUserId: string | null): Promise<SiteRow>;
  /** Admin-panel set/clear the brand's DEFAULT marketer, scoped to the actor's own brand and to an
   *  ACTIVE marketer (migration 0104). Site is derived from the marketer. makeDefault=false clears. */
  setDefaultMarketer(actorId: string, actorRole: string, marketerId: string, makeDefault: boolean): Promise<SiteRow>;
  // ── Global config console (migration 0092): master switches + global pool distribution ──
  getGlobalConfig(): Promise<GlobalConfig>;
  setGlobalConfig(actorId: string, actorRole: string, patch: JsonPatch): Promise<GlobalConfig>;
  distributePool(actorId: string, actorRole: string, totalCents: number | null, mode: string, overrides?: Record<string, number> | null, platformId?: string | null): Promise<DistributeResult>;
  listPoolDistributions(limit?: number, platformId?: string | null): Promise<PoolDistribution[]>;
  /** Preview demand-based allocation (read-only; does NOT apply). */
  poolDemand(opts: PoolDemandOpts, platformId?: string | null): Promise<PoolDemandPreview>;
  /** Compute the demand-based allocation and APPLY it via the audited per-site distributor. */
  distributePoolDynamic(actorId: string, actorRole: string, opts: PoolDemandOpts, platformId?: string | null): Promise<DistributeDynamicResult>;
  // ── Payment-gateway provider switches (migration 0116) ──
  /** The registry + per-site overrides for the superadmin console (platform_superadmin-gated). */
  listPaymentProviders(actorRole: string): Promise<PaymentProvidersView>;
  /** Flip a provider's platform-global switch (affects every brand without an override). */
  setProviderGlobal(actorId: string, actorRole: string, code: string, enabled: boolean): Promise<void>;
  /** Force a provider on/off for ONE brand (override wins over the global switch). */
  setProviderSite(actorId: string, actorRole: string, siteId: string, code: string, enabled: boolean): Promise<void>;
  /** Clear a brand's override so it reverts to the global default. */
  clearProviderSite(actorId: string, actorRole: string, siteId: string, code: string): Promise<void>;
  // ── Gateway config persistence (migration 0130) — dumb store; crypto/validation live in the service ──
  /** Masked config read for the console (platform_superadmin-gated in the RPC). */
  getProviderConfigRaw(actorRole: string, code: string, siteId: string | null): Promise<ProviderConfigView>;
  /** Persist config. `secretCiphertext`: null=keep, ''=clear, '…'=replace. Audited in the RPC. */
  setProviderConfigRaw(actorId: string, actorRole: string, code: string, siteId: string | null,
    settings: Record<string, string> | null, secretCiphertext: string | null,
    secretMeta: Record<string, { set: boolean; last4: string }>, encVersion: number): Promise<ProviderConfigView>;
  /** Service-role resolve (settings + ciphertext) for building live clients. null when unconfigured. */
  resolveProviderConfig(code: string, siteId: string | null): Promise<ProviderConfigResolved | null>;
}

const num = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number)) || 0;

/** Map the jsonb returned by fn_admin_get/set_provider_config into the typed masked view. */
function mapProviderConfig(v: Record<string, unknown>): ProviderConfigView {
  return {
    providerCode: String(v.provider_code ?? ""), siteId: (v.site_id as string) ?? null,
    settings: (v.settings ?? {}) as Record<string, string>,
    secretMeta: (v.secret_meta ?? {}) as Record<string, { set: boolean; last4: string }>,
    hasSecret: Boolean(v.has_secret), encVersion: Number(v.enc_version ?? 1),
    updatedAt: (v.updated_at as string) ?? null, exists: Boolean(v.exists),
  };
}

function mapSiteRow(x: Record<string, unknown>): SiteRow {
  return {
    siteId: String(x.id ?? x.site_id), slug: String(x.slug), name: String(x.name), status: String(x.status),
    primaryDomain: (x.primary_domain as string) ?? null, logoUrl: (x.logo_url as string) ?? null,
    faviconUrl: (x.favicon_url as string) ?? null, wordmarkText: (x.wordmark_text as string) ?? null,
    colorPrimary: String(x.color_primary), colorBg: String(x.color_bg), colorAccent: String(x.color_accent), theme: String(x.theme),
    currency: String(x.currency), locale: String(x.locale), chartStyle: (x.chart_style as string) ?? "line", tradeUi: (x.trade_ui as string) ?? "classic",
    licenceLine: (x.licence_line as string) ?? null, supportEmail: (x.support_email as string) ?? null,
    mpesaEnv: (x.mpesa_env as string) ?? null, mpesaShortcode: (x.mpesa_shortcode as string) ?? null,
    mpesaCallbackBase: (x.mpesa_callback_base as string) ?? null, mpesaB2cInitiator: (x.mpesa_b2c_initiator as string) ?? null,
    hasMpesaConsumerKey: Boolean(x.mpesa_consumer_key_ref), hasMpesaConsumerSecret: Boolean(x.mpesa_consumer_secret_ref),
    hasMpesaPasskey: Boolean(x.mpesa_passkey_ref), hasMpesaB2cCredential: Boolean(x.mpesa_b2c_credential_ref),
    legalCopy: (x.legal_copy as Record<string, unknown>) ?? null,
    ownerUserId: (x.owner_user_id as string) ?? null,
  };
}
function mapConfigRow(x: Record<string, unknown>): SiteConfigRow {
  return {
    houseEdge: num(x.house_edge), maxMultiplier: num(x.max_multiplier), minStakeCents: num(x.min_stake), maxStakeCents: num(x.max_stake),
    minWithdrawalCents: num(x.min_withdrawal),
    minWithdrawalNative: x.min_withdrawal_native == null ? null : num(x.min_withdrawal_native),
    defaultDurationS: num(x.default_duration_s), tickRateMs: num(x.tick_rate_ms),
    driftBias: num(x.drift_bias), volatility: num(x.volatility), targetWinRate: num(x.target_win_rate), version: num(x.version),
  };
}
function mapGlobalConfig(x: Record<string, unknown>): GlobalConfig {
  return {
    depositsEnabled: x.deposits_enabled !== false,
    withdrawalsEnabled: x.withdrawals_enabled !== false,
    playEnabled: x.play_enabled !== false,
    marketersEnabled: x.marketers_enabled !== false,
    registrationsEnabled: x.registrations_enabled !== false,
    maintenanceMessage: (x.maintenance_message as string | null) ?? null,
    globalDailyPoolCents: x.global_daily_pool_cents == null ? null : num(x.global_daily_pool_cents),
    playerEconomy: parseCohort(x.player_economy),
    marketerEconomy: parseCohort(x.marketer_economy),
    payments: parsePayments(x.payments),
    version: num(x.version),
    updatedAt: (x.updated_at as string | null) ?? null,
  };
}

export class PgPlatformRepository implements PlatformRepository {
  constructor(private readonly q: Querier) {}

  async listSites(platformScope?: string | null): Promise<SiteWithConfig[]> {
    const r = await this.q.query(
      `select s.*, c.house_edge, c.max_multiplier, c.min_stake, c.max_stake, c.min_withdrawal, c.min_withdrawal_native,
              c.default_duration_s, c.tick_rate_ms, c.drift_bias, c.volatility, c.target_win_rate, c.version
         from sites s left join site_game_config c on c.site_id = s.id
        where ($1::uuid is null or s.platform_id = $1)
        order by s.created_at asc`, [platformScope ?? null]);
    return r.rows.map((x: Record<string, unknown>) => ({ ...mapSiteRow(x), config: mapConfigRow(x) }));
  }

  async createSite(actorId: string, actorRole: string, input: CreateSiteInput): Promise<string> {
    const r = await this.q.query("select fn_platform_create_site($1,$2,$3,$4,$5,$6) as id",
      [actorId, actorRole, input.slug, input.name, input.currency ?? "KES", input.primaryDomain ?? null]);
    return String(r.rows[0].id);
  }

  async updateSite(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteRow> {
    const r = await this.q.query("select * from fn_platform_update_site($1,$2,$3,$4)",
      [actorId, actorRole, siteId, JSON.stringify(patch)]);
    return mapSiteRow(r.rows[0] as Record<string, unknown>);
  }

  async setSiteConfig(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteConfigRow> {
    const r = await this.q.query("select * from fn_platform_set_site_config($1,$2,$3,$4)",
      [actorId, actorRole, siteId, JSON.stringify(patch)]);
    return mapConfigRow(r.rows[0] as Record<string, unknown>);
  }

  async overview(actorId: string, actorRole: string): Promise<SiteKpis[]> {
    const r = await this.q.query("select * from fn_platform_overview($1,$2)", [actorId, actorRole]);
    return r.rows.map((x: Record<string, unknown>) => ({
      siteId: String(x.site_id), slug: String(x.slug), name: String(x.name), status: String(x.status),
      users: num(x.users), depositsCents: num(x.deposits_cents), withdrawalsCents: num(x.withdrawals_cents),
      ggrCents: num(x.ggr_cents), openPositions: num(x.open_positions), bets: num(x.bets),
    }));
  }
  async platformOfSite(siteId: string): Promise<string | null> {
    // FAIL CLOSED (Issue 1): an empty/absent siteId is UNRESOLVED (null), not a DB error from an
    // invalid uuid cast; and a site row whose platform_id IS NULL must resolve to null, not the
    // string "null" (String(null)) — the caller's scope guard refuses an unresolved target.
    if (!siteId) return null;
    const r = await this.q.query("select platform_id from sites where id = $1", [siteId]);
    const v = r.rows.length ? r.rows[0].platform_id : null;
    return v == null ? null : String(v);
  }

  async listPlatforms(): Promise<PlatformRow[]> {
    const r = await this.q.query(
      "select id, slug, name, status, owner_user_id, notes from platforms order by created_at asc", []);
    return r.rows.map((x: Record<string, unknown>) => ({
      platformId: String(x.id), slug: String(x.slug), name: String(x.name), status: String(x.status),
      ownerUserId: x.owner_user_id == null ? null : String(x.owner_user_id), notes: x.notes == null ? null : String(x.notes),
    }));
  }

  async platformsOverview(actorRole: string): Promise<PlatformKpis[]> {
    const r = await this.q.query("select * from fn_platforms_overview($1)", [actorRole]);
    return r.rows.map((x: Record<string, unknown>) => ({
      platformId: String(x.platform_id), slug: String(x.slug), name: String(x.name), status: String(x.status),
      sites: num(x.sites), users: num(x.users), siteAdmins: num(x.site_admins), platformAdmins: num(x.platform_admins),
    }));
  }

  async createPlatform(actorId: string, actorRole: string, slug: string, name: string, ownerUserId?: string | null): Promise<string> {
    const r = await this.q.query("select fn_platform_create_platform($1,$2,$3,$4,$5) as id",
      [actorId, actorRole, slug, name, ownerUserId ?? null]);
    return String(r.rows[0].id);
  }

  async updatePlatform(actorId: string, actorRole: string, platformId: string, patch: JsonPatch): Promise<PlatformRow> {
    const r = await this.q.query("select * from fn_platform_update_platform($1,$2,$3,$4)",
      [actorId, actorRole, platformId, JSON.stringify(patch)]);
    const x = r.rows[0] as Record<string, unknown>;
    return { platformId: String(x.id), slug: String(x.slug), name: String(x.name), status: String(x.status),
      ownerUserId: x.owner_user_id == null ? null : String(x.owner_user_id), notes: x.notes == null ? null : String(x.notes) };
  }

  async assignSiteToPlatform(actorId: string, actorRole: string, siteId: string, platformId: string): Promise<{ siteId: string; platformId: string }> {
    const r = await this.q.query("select id, platform_id from fn_platform_assign_site($1,$2,$3,$4)",
      [actorId, actorRole, siteId, platformId]);
    const x = r.rows[0] as Record<string, unknown>;
    return { siteId: String(x.id), platformId: String(x.platform_id) };
  }

  async appointPlatformAdmin(actorId: string, actorRole: string, targetUserId: string, platformId: string): Promise<AppointResult> {
    const r = await this.q.query("select * from fn_platform_appoint_platform_admin($1,$2,$3,$4)",
      [actorId, actorRole, targetUserId, platformId]);
    const x = r.rows[0] as Record<string, unknown>;
    return { userId: String(x.user_id), role: String(x.role), platformId: x.platform_id == null ? null : String(x.platform_id) };
  }

  async revokePlatformAdmin(actorId: string, actorRole: string, targetUserId: string, newRole: string): Promise<{ userId: string; role: string }> {
    const r = await this.q.query("select * from fn_platform_revoke_platform_admin($1,$2,$3,$4)",
      [actorId, actorRole, targetUserId, newRole]);
    const x = r.rows[0] as Record<string, unknown>;
    return { userId: String(x.user_id), role: String(x.role) };
  }

  async performance(fromMs: number, toMs: number, platformScope?: string | null): Promise<SitePerformance[]> {
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    const r = await this.q.query(
      `with dep as (
         select site_id,
                coalesce(sum(amount) filter (where kind='deposit'    and status='success'), 0) as deposits_cents,
                coalesce(sum(amount) filter (where kind='withdrawal' and status='success' and provider is distinct from 'internal'), 0) as withdrawals_cents
           from transactions
          where created_at >= $1 and created_at < $2
            and user_id not in (select user_id from marketer_account_ids)
          group by site_id
       ),
       pos as (
         select site_id,
                count(*) filter (where status='settled')                       as bets,
                coalesce(sum(stake), 0)                                         as staked_cents,
                coalesce(sum(stake - payout) filter (where status='settled'),0) as ggr_cents
           from positions
          where opened_at >= $1 and opened_at < $2
            and user_id not in (select user_id from marketer_account_ids)
          group by site_id
       ),
       np as (
         select site_id, count(*) as new_players
           from profiles
          where created_at >= $1 and created_at < $2
            and id not in (select user_id from marketer_account_ids)
          group by site_id
       )
       select s.id as site_id, s.slug, s.name, s.status,
              coalesce(dep.deposits_cents, 0)    as deposits_cents,
              coalesce(dep.withdrawals_cents, 0) as withdrawals_cents,
              coalesce(pos.ggr_cents, 0)         as ggr_cents,
              coalesce(pos.bets, 0)              as bets,
              coalesce(pos.staked_cents, 0)      as staked_cents,
              coalesce(np.new_players, 0)        as new_players
         from sites s
         left join dep on dep.site_id = s.id
         left join pos on pos.site_id = s.id
         left join np  on np.site_id  = s.id
        where ($3::uuid is null or s.platform_id = $3::uuid)
        order by s.created_at asc`,
      [from, to, platformScope ?? null],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      siteId: String(x.site_id), slug: String(x.slug), name: String(x.name), status: String(x.status),
      depositsCents: num(x.deposits_cents), withdrawalsCents: num(x.withdrawals_cents), ggrCents: num(x.ggr_cents),
      bets: num(x.bets), stakedCents: num(x.staked_cents), newPlayers: num(x.new_players),
    }));
  }

  async marketerRollup(actorRole: string): Promise<MarketerRollupRow[]> {
    const r = await this.q.query("select * from fn_platform_marketer_rollup($1)", [actorRole]);
    return r.rows.map((x: Record<string, unknown>) => ({
      marketerGlobalId: x.marketer_global_id == null ? null : String(x.marketer_global_id),
      label: x.label == null ? null : String(x.label),
      affiliateUserId: String(x.affiliate_user_id),
      siteId: String(x.site_id), siteSlug: String(x.site_slug), siteName: String(x.site_name),
      clients: num(x.clients), ggrCents: num(x.ggr_cents), commissionCents: num(x.commission_cents),
    }));
  }

  async createMarketerGlobal(actorId: string, actorRole: string, label: string): Promise<string> {
    const r = await this.q.query("select fn_platform_create_marketer_global($1,$2,$3) as id", [actorId, actorRole, label]);
    return String(r.rows[0].id);
  }

  async linkMarketer(actorId: string, actorRole: string, affiliateUserId: string, globalId: string | null): Promise<void> {
    await this.q.query("select fn_platform_link_marketer($1,$2,$3,$4)", [actorId, actorRole, affiliateUserId, globalId]);
  }

  async setSiteTheme(actorId: string, actorRole: string, siteId: string, tokens: JsonPatch): Promise<SiteRow> {
    const r = await this.q.query("select * from fn_platform_set_site_theme($1,$2,$3,$4)",
      [actorId, actorRole, siteId, JSON.stringify(tokens)]);
    return mapSiteRow(r.rows[0] as Record<string, unknown>);
  }

  async setSiteOwner(actorId: string, actorRole: string, siteId: string, ownerUserId: string | null): Promise<SiteRow> {
    const r = await this.q.query("select * from fn_platform_set_site_owner($1,$2,$3,$4)",
      [actorId, actorRole, siteId, ownerUserId]);
    return mapSiteRow(r.rows[0] as Record<string, unknown>);
  }

  async setDefaultMarketer(actorId: string, actorRole: string, marketerId: string, makeDefault: boolean): Promise<SiteRow> {
    const r = await this.q.query("select * from fn_admin_set_site_owner($1,$2,$3,$4)",
      [actorId, actorRole, marketerId, makeDefault]);
    return mapSiteRow(r.rows[0] as Record<string, unknown>);
  }

  async getGlobalConfig(): Promise<GlobalConfig> {
    const r = await this.q.query("select public.fn_platform_get_global_config() as c", []);
    return mapGlobalConfig((r.rows[0].c ?? {}) as Record<string, unknown>);
  }
  async setGlobalConfig(actorId: string, actorRole: string, patch: JsonPatch): Promise<GlobalConfig> {
    const r = await this.q.query("select public.fn_platform_set_global_config($1,$2,$3) as c",
      [actorId, actorRole, JSON.stringify(patch)]);
    return mapGlobalConfig(r.rows[0].c as Record<string, unknown>);
  }
  // ── Payment-gateway provider switches (migration 0116) ──
  async listPaymentProviders(actorRole: string): Promise<PaymentProvidersView> {
    const r = await this.q.query("select public.fn_admin_list_providers($1) as v", [actorRole]);
    const v = (r.rows[0]?.v ?? {}) as { providers?: any[]; overrides?: any[] };
    return {
      providers: (v.providers ?? []).map((p) => ({ code: String(p.code), displayName: String(p.display_name), enabledGlobal: Boolean(p.enabled_global), sortOrder: Number(p.sort_order) })),
      overrides: (v.overrides ?? []).map((o) => ({ siteId: String(o.site_id), providerCode: String(o.provider_code), enabled: Boolean(o.enabled) })),
    };
  }
  async setProviderGlobal(actorId: string, actorRole: string, code: string, enabled: boolean): Promise<void> {
    await this.q.query("select public.fn_platform_set_provider_global($1,$2,$3,$4)", [actorId, actorRole, code, enabled]);
  }
  async setProviderSite(actorId: string, actorRole: string, siteId: string, code: string, enabled: boolean): Promise<void> {
    await this.q.query("select public.fn_platform_set_provider_site($1,$2,$3,$4,$5)", [actorId, actorRole, siteId, code, enabled]);
  }
  async clearProviderSite(actorId: string, actorRole: string, siteId: string, code: string): Promise<void> {
    await this.q.query("select public.fn_platform_clear_provider_site($1,$2,$3,$4)", [actorId, actorRole, siteId, code]);
  }
  // ── Gateway config persistence (migration 0130) ──
  async getProviderConfigRaw(actorRole: string, code: string, siteId: string | null): Promise<ProviderConfigView> {
    const r = await this.q.query("select public.fn_admin_get_provider_config($1,$2,$3) as v", [actorRole, code, siteId]);
    return mapProviderConfig(r.rows[0]?.v ?? {});
  }
  async setProviderConfigRaw(actorId: string, actorRole: string, code: string, siteId: string | null,
    settings: Record<string, string> | null, secretCiphertext: string | null,
    secretMeta: Record<string, { set: boolean; last4: string }>, encVersion: number): Promise<ProviderConfigView> {
    const r = await this.q.query(
      "select public.fn_platform_set_provider_config($1,$2,$3,$4,$5,$6,$7,$8) as v",
      [actorId, actorRole, code, siteId, settings ? JSON.stringify(settings) : null,
       secretCiphertext, JSON.stringify(secretMeta ?? {}), encVersion]);
    return mapProviderConfig(r.rows[0]?.v ?? {});
  }
  async resolveProviderConfig(code: string, siteId: string | null): Promise<ProviderConfigResolved | null> {
    const r = await this.q.query("select public.fn_provider_config_resolve($1,$2) as v", [code, siteId]);
    const v = r.rows[0]?.v;
    if (!v) return null;
    return {
      providerCode: String(v.provider_code), siteId: v.site_id ?? null,
      settings: (v.settings ?? {}) as Record<string, string>,
      secretCiphertext: v.secret_ciphertext ?? null, encVersion: Number(v.enc_version ?? 1), scope: String(v.scope ?? "global"),
    };
  }
  async distributePool(actorId: string, actorRole: string, totalCents: number | null, mode: string, overrides?: Record<string, number> | null, platformId?: string | null): Promise<DistributeResult> {
    // platformId set => platform-scoped distributor (0143): only that platform's active brands.
    const r = platformId
      ? await this.q.query("select public.fn_platform_distribute_pool_scoped($1,$2,$3,$4,$5,$6) as r",
          [actorId, actorRole, platformId, totalCents, mode, overrides ? JSON.stringify(overrides) : null])
      : await this.q.query("select public.fn_platform_distribute_pool($1,$2,$3,$4,$5) as r",
          [actorId, actorRole, totalCents, mode, overrides ? JSON.stringify(overrides) : null]);
    const x = r.rows[0].r as Record<string, unknown>;
    return { totalCents: num(x.total_cents), mode: String(x.mode), perSite: (x.per_site as Record<string, number>) ?? {} };
  }
  async listPoolDistributions(limit = 20, platformId?: string | null): Promise<PoolDistribution[]> {
    const r = await this.q.query(
      "select id, total_cents, mode, site_count, per_site, created_at from public.platform_pool_distributions where ($2::uuid is null or platform_id = $2) order by created_at desc limit $1", [limit, platformId ?? null]);
    return r.rows.map((x: Record<string, unknown>) => ({
      id: num(x.id), totalCents: num(x.total_cents), mode: String(x.mode), siteCount: num(x.site_count),
      perSite: (x.per_site as Record<string, number>) ?? {}, createdAt: String(x.created_at),
    }));
  }

  /**
   * Demand-based allocation preview (docs/25 §15). Forecasts each ACTIVE pool-mode brand's daily
   * player turnover via an EMA over `lookbackDays` of position_decision history (player-only by
   * construction — marketers never produce pool decisions), then runs the shared water-fill allocator.
   * Read-only: computes but does not apply.
   */
  async poolDemand(opts: PoolDemandOpts, platformId?: string | null): Promise<PoolDemandPreview> {
    const lookbackDays = Math.min(90, Math.max(3, Math.floor(opts.lookbackDays ?? 14)));
    const baselineDays = Math.min(90, Math.max(lookbackDays, Math.floor(opts.baselineDays ?? 45)));
    const alpha = opts.alpha ?? 0.4, floorFrac = opts.floorFrac ?? 0.015, capMult = opts.capMult ?? 2.5;
    const configuredFloorCents = Math.max(0, Math.floor(opts.configuredFloorCents ?? 0));
    const sitesR = await this.q.query(
      `select s.id, s.slug, s.default_daily_pool_cents, coalesce(g.house_edge, 0.05) as house_edge
         from public.sites s left join public.site_game_config g on g.site_id = s.id
        where s.status = 'active' and s.pool_mode = true and ($1::uuid is null or s.platform_id = $1)
        order by s.created_at`, [platformId ?? null]);
    // One query over the wider baseline window; the reactive forecast uses only its recent tail.
    const turnR = await this.q.query(
      `select d.site_id::text as site_id, (d.pool_day)::text as day, coalesce(sum(p.stake), 0)::bigint as turnover
         from public.position_decision d join public.positions p on p.id = d.position_id
        where d.pool_day > current_date - $1::int
        group by d.site_id, d.pool_day`, [baselineDays]);

    const perSiteDay = new Map<string, Map<string, number>>();
    for (const row of turnR.rows) {
      const sid = String(row.site_id), day = String(row.day);
      if (!perSiteDay.has(sid)) perSiteDay.set(sid, new Map());
      perSiteDay.get(sid)!.set(day, num(row.turnover));
    }
    const baseWindow = eatWindowDays(baselineDays);          // oldest→newest, full baseline
    const recentWindow = baseWindow.slice(-lookbackDays);    // reactive-forecast tail
    const brands = sitesR.rows.map((s: Record<string, unknown>) => {
      const sid = String(s.id);
      const m = perSiteDay.get(sid) ?? new Map<string, number>();
      const baseSeries = baseWindow.map((d) => m.get(d) ?? 0);
      const recentSeries = recentWindow.map((d) => m.get(d) ?? 0);
      const forecast = emaForecast(recentSeries, alpha);
      // Floor baseline is never below the reactive forecast (so a live spike still lifts the floor),
      // and is outage-proof (non-zero days only) via robustExpectedTurnover.
      const expectedTurnover = Math.max(forecast, robustExpectedTurnover(baseSeries));
      return {
        siteId: sid, slug: String(s.slug), houseEdge: num(s.house_edge),
        currentPoolCents: num(s.default_daily_pool_cents),
        recentTurnoverCents: recentSeries.reduce((a, b) => a + b, 0),
        forecastTurnoverCents: forecast,
        expectedTurnoverCents: expectedTurnover,
      };
    });
    const totalCents = opts.totalCents != null
      ? Math.max(0, Math.floor(opts.totalCents))
      : brands.reduce((a, b) => a + b.currentPoolCents, 0);

    const alloc = distributeDynamicPool(
      brands.map((b) => ({ siteId: b.siteId, houseEdge: b.houseEdge, forecastTurnoverCents: b.forecastTurnoverCents, expectedTurnoverCents: b.expectedTurnoverCents })),
      totalCents, { floorFrac, capMult, configuredFloorCents });
    const allocById = new Map(alloc.map((a) => [a.siteId, a]));

    const rows: PoolDemandRow[] = brands.map((b) => {
      const a = allocById.get(b.siteId)!;
      const floorCents = (b.forecastTurnoverCents > 0 || b.expectedTurnoverCents > 0)
        ? Math.max(configuredFloorCents, Math.round(a.targetRtp * b.expectedTurnoverCents)) : 0;
      return {
        siteId: b.siteId, slug: b.slug, targetRtp: a.targetRtp,
        forecastTurnoverCents: Math.round(b.forecastTurnoverCents), recentTurnoverCents: b.recentTurnoverCents,
        requiredCents: a.requiredCents, currentPoolCents: b.currentPoolCents, suggestedCents: a.allocCents,
        coverage: a.requiredCents > 0 ? a.allocCents / a.requiredCents : 1,
        expectedTurnoverCents: Math.round(b.expectedTurnoverCents), floorCents,
      };
    });
    const suggestedTotalCents = rows.reduce((a, b) => a + b.suggestedCents, 0);
    return { lookbackDays, totalCents, alpha, floorFrac, capMult, rows, suggestedTotalCents,
      reserveCents: totalCents - suggestedTotalCents, baselineDays, configuredFloorCents };
  }

  async distributePoolDynamic(actorId: string, actorRole: string, opts: PoolDemandOpts, platformId?: string | null): Promise<DistributeDynamicResult> {
    const preview = await this.poolDemand(opts, platformId);
    if (!preview.rows.length) throw new Error("NO_ACTIVE_SITES");
    const overrides: Record<string, number> = {};
    for (const r of preview.rows) overrides[r.siteId] = r.suggestedCents; // includes 0 for idle brands (explicit)
    // Reuse the audited per-site distributor (0092/0143): sets each brand's recurring default_daily_pool_cents.
    const result = await this.distributePool(actorId, actorRole, preview.totalCents, "per_site", overrides, platformId);
    return { ...result, preview };
  }
}

const DEFAULT_CONFIG: SiteConfigRow = {
  houseEdge: 0.75, maxMultiplier: 5, minStakeCents: 25000, maxStakeCents: 5000000, minWithdrawalCents: 25000,
  defaultDurationS: 10, tickRateMs: 150, driftBias: 0.3, volatility: 1, targetWinRate: 0.125, version: 1,
};
const DEFAULT_SITE_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_PLATFORM_ID = "10000000-0000-0000-0000-000000000001";

/** In-memory platform repo for tests. Enforces the platform_superadmin gate; seeds the default brand. */
export class InMemoryPlatformRepository implements PlatformRepository {
  private readonly sites = new Map<string, SiteWithConfig>();
  // Platform tier (Issue 1) in-memory state.
  private readonly platforms = new Map<string, PlatformRow>();
  private readonly sitePlatform = new Map<string, string>();   // siteId -> platformId
  private readonly platformAdmins = new Map<string, string>(); // userId -> platformId
  /** Optional KPI source so overview can return real numbers in tests. */
  kpis: (siteId: string) => Omit<SiteKpis, "siteId" | "slug" | "name" | "status"> = () => ({
    users: 0, depositsCents: 0, withdrawalsCents: 0, ggrCents: 0, openPositions: 0, bets: 0,
  });

  constructor() {
    this.sites.set(DEFAULT_SITE_ID, {
      siteId: DEFAULT_SITE_ID, slug: "invest254", name: "Invest254", status: "active",
      primaryDomain: "invest254.com", logoUrl: null, faviconUrl: null, wordmarkText: "invest254.com",
      colorPrimary: "#22c55e", colorBg: "#0a0a0a", colorAccent: "#06b6d4", theme: "dark",
      currency: "KES", locale: "en-KE", chartStyle: "line", tradeUi: "classic", licenceLine: "Operated under licence.", supportEmail: null,
      mpesaEnv: null, mpesaShortcode: null, mpesaCallbackBase: null, mpesaB2cInitiator: null,
      hasMpesaConsumerKey: false, hasMpesaConsumerSecret: false, hasMpesaPasskey: false, hasMpesaB2cCredential: false,
      legalCopy: null,
      ownerUserId: null,
      config: { ...DEFAULT_CONFIG },
    });
    this.platforms.set(DEFAULT_PLATFORM_ID, { platformId: DEFAULT_PLATFORM_ID, slug: "default", name: "Default Platform", status: "active", ownerUserId: null, notes: null });
    this.sitePlatform.set(DEFAULT_SITE_ID, DEFAULT_PLATFORM_ID);
  }
  private gate(role: string) { if (role !== "platform_superadmin") throw new Error("NOT_AUTHORIZED"); }
  // Site management is allowed for a platform_admin too (the API's scopeSiteParam already bounded the
  // target site to the caller's platform; the Pg RPCs enforce it in-definer).
  private gateManage(role: string) { if (!["platform_admin", "platform_superadmin"].includes(role)) throw new Error("NOT_AUTHORIZED"); }

  async listSites(platformScope?: string | null): Promise<SiteWithConfig[]> {
    const all = [...this.sites.values()];
    if (platformScope == null) return all;
    return all.filter((s) => (this.sitePlatform.get(s.siteId) ?? DEFAULT_PLATFORM_ID) === platformScope);
  }
  async platformOfSite(siteId: string): Promise<string | null> {
    if (!this.sites.has(siteId)) return null;
    return this.sitePlatform.get(siteId) ?? DEFAULT_PLATFORM_ID;
  }

  async createSite(_actorId: string, actorRole: string, input: CreateSiteInput): Promise<string> {
    this.gate(actorRole);
    const slug = (input.slug ?? "").trim().toLowerCase();
    const name = (input.name ?? "").trim();
    if (!slug || !name) throw new Error("INVALID_BRAND");
    if ([...this.sites.values()].some((s) => s.slug === slug)) throw new Error("SLUG_TAKEN");
    const id = randomUUID();
    this.sites.set(id, {
      siteId: id, slug, name, status: "active", primaryDomain: input.primaryDomain ?? null,
      logoUrl: null, faviconUrl: null, wordmarkText: null, colorPrimary: "#22c55e", colorBg: "#0a0a0a",
      colorAccent: "#06b6d4", theme: "dark", currency: input.currency ?? "KES", locale: "en-KE", chartStyle: "line", tradeUi: "classic",
      licenceLine: null, supportEmail: null,
      mpesaEnv: null, mpesaShortcode: null, mpesaCallbackBase: null, mpesaB2cInitiator: null,
      hasMpesaConsumerKey: false, hasMpesaConsumerSecret: false, hasMpesaPasskey: false, hasMpesaB2cCredential: false,
      legalCopy: null,
      ownerUserId: null,
      config: { ...DEFAULT_CONFIG },
    });
    return id;
  }

  async updateSite(_actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteRow> {
    this.gateManage(actorRole);
    const s = this.sites.get(siteId);
    if (!s) throw new Error("SITE_NOT_FOUND");
    const map: Record<string, keyof SiteRow> = {
      name: "name", primary_domain: "primaryDomain", logo_url: "logoUrl", favicon_url: "faviconUrl",
      wordmark_text: "wordmarkText", color_primary: "colorPrimary", color_bg: "colorBg", color_accent: "colorAccent",
      theme: "theme", currency: "currency", locale: "locale", chart_style: "chartStyle", licence_line: "licenceLine", support_email: "supportEmail", status: "status",
    };
    for (const [k, prop] of Object.entries(map)) {
      if (k in patch) (s as unknown as Record<string, unknown>)[prop] = patch[k] === "" ? null : patch[k];
    }
    return { ...s };
  }

  async setSiteConfig(_actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteConfigRow> {
    this.gateManage(actorRole);
    const s = this.sites.get(siteId);
    if (!s) throw new Error("SITE_NOT_FOUND");
    const map: Record<string, keyof SiteConfigRow> = {
      house_edge: "houseEdge", max_multiplier: "maxMultiplier", min_stake: "minStakeCents", max_stake: "maxStakeCents",
      min_withdrawal: "minWithdrawalCents", default_duration_s: "defaultDurationS", tick_rate_ms: "tickRateMs",
      drift_bias: "driftBias", volatility: "volatility", target_win_rate: "targetWinRate",
    };
    for (const [k, prop] of Object.entries(map)) if (k in patch) (s.config[prop] as number) = Number(patch[k]);
    s.config.version += 1;
    return { ...s.config };
  }

  async overview(_actorId: string, actorRole: string): Promise<SiteKpis[]> {
    if (!["platform_admin", "platform_superadmin"].includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    return [...this.sites.values()].map((s) => ({ siteId: s.siteId, slug: s.slug, name: s.name, status: s.status, ...this.kpis(s.siteId) }));
  }

  async listPlatforms(): Promise<PlatformRow[]> { return [...this.platforms.values()].map((p) => ({ ...p })); }

  async platformsOverview(actorRole: string): Promise<PlatformKpis[]> {
    this.gate(actorRole);
    return [...this.platforms.values()].map((p) => {
      const sites = [...this.sitePlatform.values()].filter((pid) => pid === p.platformId).length;
      const platformAdmins = [...this.platformAdmins.values()].filter((pid) => pid === p.platformId).length;
      return { platformId: p.platformId, slug: p.slug, name: p.name, status: p.status, sites, users: 0, siteAdmins: 0, platformAdmins };
    });
  }

  async createPlatform(_actorId: string, actorRole: string, slug: string, name: string, ownerUserId?: string | null): Promise<string> {
    this.gate(actorRole);
    const s = (slug ?? "").trim().toLowerCase(); const n = (name ?? "").trim();
    if (!s || !n) throw new Error("INVALID_PLATFORM");
    if ([...this.platforms.values()].some((p) => p.slug === s)) throw new Error("SLUG_TAKEN");
    const id = randomUUID();
    this.platforms.set(id, { platformId: id, slug: s, name: n, status: "active", ownerUserId: ownerUserId ?? null, notes: null });
    return id;
  }

  async updatePlatform(_actorId: string, actorRole: string, platformId: string, patch: JsonPatch): Promise<PlatformRow> {
    this.gate(actorRole);
    const p = this.platforms.get(platformId); if (!p) throw new Error("PLATFORM_NOT_FOUND");
    if ("name" in patch) p.name = String(patch.name);
    if ("status" in patch) p.status = String(patch.status);
    if ("owner_user_id" in patch) p.ownerUserId = patch.owner_user_id ? String(patch.owner_user_id) : null;
    if ("notes" in patch) p.notes = patch.notes ? String(patch.notes) : null;
    return { ...p };
  }

  async assignSiteToPlatform(_actorId: string, actorRole: string, siteId: string, platformId: string): Promise<{ siteId: string; platformId: string }> {
    this.gate(actorRole);
    if (!this.platforms.has(platformId)) throw new Error("PLATFORM_NOT_FOUND");
    if (!this.sites.has(siteId)) throw new Error("SITE_NOT_FOUND");
    this.sitePlatform.set(siteId, platformId);
    return { siteId, platformId };
  }

  async appointPlatformAdmin(_actorId: string, actorRole: string, targetUserId: string, platformId: string): Promise<AppointResult> {
    this.gate(actorRole);
    if (!this.platforms.has(platformId)) throw new Error("PLATFORM_NOT_FOUND");
    this.platformAdmins.set(targetUserId, platformId);
    return { userId: targetUserId, role: "platform_admin", platformId };
  }

  async revokePlatformAdmin(_actorId: string, actorRole: string, targetUserId: string, newRole: string): Promise<{ userId: string; role: string }> {
    this.gate(actorRole);
    if (!["player", "marketer", "admin"].includes(newRole)) throw new Error("INVALID_ROLE");
    if (this.platformAdmins.get(targetUserId) === undefined) throw new Error("NOT_A_PLATFORM_ADMIN");
    this.platformAdmins.delete(targetUserId);
    return { userId: targetUserId, role: newRole };
  }

  async performance(_fromMs: number, _toMs: number, platformScope?: string | null): Promise<SitePerformance[]> {
    // No transaction/position store in the in-memory repo — return each brand with zeroed metrics.
    const inScope = await this.listSites(platformScope ?? null);
    const ids = new Set(inScope.map((x) => x.siteId));
    return [...this.sites.values()].filter((s) => ids.has(s.siteId)).map((s) => ({
      siteId: s.siteId, slug: s.slug, name: s.name, status: s.status,
      depositsCents: 0, withdrawalsCents: 0, ggrCents: 0, bets: 0, stakedCents: 0, newPlayers: 0,
    }));
  }

  // ── Task R: cross-brand marketer rollup (in-memory mirror for tests) ──
  private readonly globals = new Map<string, { id: string; label: string }>();
  private readonly themeTokens = new Map<string, Record<string, unknown>>();
  /** Seeded affiliate rows (one per site). `seedMarketer` adds them; `linkMarketer` mutates the link. */
  readonly marketers: Array<{
    affiliateUserId: string; siteId: string; marketerGlobalId: string | null;
    clients: number; ggrCents: number; commissionCents: number;
  }> = [];

  /** Test seam: register a per-site affiliate row with its client/GGR/commission facts. */
  seedMarketer(row: { affiliateUserId: string; siteId: string; clients: number; ggrCents: number; commissionCents: number; marketerGlobalId?: string | null }): void {
    this.marketers.push({ marketerGlobalId: row.marketerGlobalId ?? null, ...row });
  }

  async createMarketerGlobal(_actorId: string, actorRole: string, label: string): Promise<string> {
    this.gate(actorRole);
    if (!label || !label.trim()) throw new Error("INVALID_LABEL");
    const id = randomUUID();
    this.globals.set(id, { id, label: label.trim() });
    return id;
  }

  async linkMarketer(_actorId: string, actorRole: string, affiliateUserId: string, globalId: string | null): Promise<void> {
    this.gate(actorRole);
    if (globalId !== null && !this.globals.has(globalId)) throw new Error("MARKETER_GLOBAL_NOT_FOUND");
    const row = this.marketers.find((m) => m.affiliateUserId === affiliateUserId);
    if (!row) throw new Error("NOT_AFFILIATE");
    row.marketerGlobalId = globalId;
  }

  async marketerRollup(actorRole: string): Promise<MarketerRollupRow[]> {
    this.gate(actorRole);
    return this.marketers.map((m) => {
      const site = this.sites.get(m.siteId);
      return {
        marketerGlobalId: m.marketerGlobalId,
        label: m.marketerGlobalId ? (this.globals.get(m.marketerGlobalId)?.label ?? null) : null,
        affiliateUserId: m.affiliateUserId,
        siteId: m.siteId, siteSlug: site?.slug ?? "", siteName: site?.name ?? "",
        clients: m.clients, ggrCents: m.ggrCents, commissionCents: m.commissionCents,
      };
    });
  }

  async setSiteTheme(_actorId: string, actorRole: string, siteId: string, tokens: JsonPatch): Promise<SiteRow> {
    this.gate(actorRole);
    if (!tokens || typeof tokens !== "object") throw new Error("INVALID_PATCH");
    const s = this.sites.get(siteId);
    if (!s) throw new Error("SITE_NOT_FOUND");
    this.themeTokens.set(siteId, tokens as Record<string, unknown>);
    const { config, ...row } = s;
    return { ...row };
  }

  async setSiteOwner(_actorId: string, actorRole: string, siteId: string, ownerUserId: string | null): Promise<SiteRow> {
    this.gate(actorRole);
    const s = this.sites.get(siteId);
    if (!s) throw new Error("SITE_NOT_FOUND");
    s.ownerUserId = ownerUserId;
    const { config, ...row } = s;
    return { ...row };
  }

  // In-memory double: real site-derivation + active-marketer + scope guards live in the DB RPC
  // (fn_admin_set_site_owner, migration 0104) and are covered by rolled-back live e2e. Here we only
  // gate the role and apply to the default site so route wiring/tests compile and behave sanely.
  async setDefaultMarketer(_actorId: string, actorRole: string, marketerId: string, makeDefault: boolean): Promise<SiteRow> {
    if (!["admin", "platform_superadmin"].includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    const s = this.sites.get(DEFAULT_SITE_ID)!;
    s.ownerUserId = makeDefault ? marketerId : (s.ownerUserId === marketerId ? null : s.ownerUserId);
    const { config, ...row } = s;
    return { ...row };
  }

  // ── Payment-gateway provider switches (migration 0116) — in-memory double ──
  private providersReg: PaymentProviderRow[] = [
    // Mirrors the DB registry seed (migrations 0116 + 0130): existing rails + the new configurable gateways.
    { code: "mpesa", displayName: "M-Pesa", enabledGlobal: true, sortOrder: 10 },
    { code: "megapay", displayName: "Mega Pay", enabledGlobal: false, sortOrder: 20 },
    { code: "paystack", displayName: "Paystack", enabledGlobal: false, sortOrder: 30 },
    { code: "binance", displayName: "Binance Pay", enabledGlobal: false, sortOrder: 40 },
    { code: "payhero", displayName: "PayHero", enabledGlobal: false, sortOrder: 50 },
  ];
  private providerOverrides = new Map<string, boolean>(); // key `${siteId}:${code}`
  async listPaymentProviders(actorRole: string): Promise<PaymentProvidersView> {
    this.gate(actorRole);
    return {
      providers: this.providersReg.map((p) => ({ ...p })),
      overrides: [...this.providerOverrides].map(([k, enabled]) => {
        const i = k.indexOf(":"); return { siteId: k.slice(0, i), providerCode: k.slice(i + 1), enabled };
      }),
    };
  }
  async setProviderGlobal(_actorId: string, actorRole: string, code: string, enabled: boolean): Promise<void> {
    this.gate(actorRole);
    const p = this.providersReg.find((x) => x.code === code);
    if (!p) throw new Error("PROVIDER_NOT_FOUND");
    p.enabledGlobal = enabled;
  }
  async setProviderSite(_actorId: string, actorRole: string, siteId: string, code: string, enabled: boolean): Promise<void> {
    this.gate(actorRole);
    if (!this.providersReg.find((x) => x.code === code)) throw new Error("PROVIDER_NOT_FOUND");
    this.providerOverrides.set(`${siteId}:${code}`, enabled);
  }
  async clearProviderSite(_actorId: string, actorRole: string, siteId: string, code: string): Promise<void> {
    this.gate(actorRole);
    this.providerOverrides.delete(`${siteId}:${code}`);
  }

  // ── Gateway config persistence (migration 0130) — in-memory double ──
  private providerConfigs = new Map<string, { settings: Record<string, string>; ciphertext: string | null; meta: Record<string, { set: boolean; last4: string }>; encVersion: number; updatedAt: string }>();
  private cfgKey(code: string, siteId: string | null) { return `${code}:${siteId ?? "__global__"}`; }
  async getProviderConfigRaw(actorRole: string, code: string, siteId: string | null): Promise<ProviderConfigView> {
    this.gate(actorRole);
    if (!this.providersReg.find((x) => x.code === code)) throw new Error("PROVIDER_NOT_FOUND");
    const row = this.providerConfigs.get(this.cfgKey(code, siteId));
    if (!row) return { providerCode: code, siteId, settings: {}, secretMeta: {}, hasSecret: false, encVersion: 1, updatedAt: null, exists: false };
    return { providerCode: code, siteId, settings: { ...row.settings }, secretMeta: { ...row.meta }, hasSecret: row.ciphertext != null, encVersion: row.encVersion, updatedAt: row.updatedAt, exists: true };
  }
  async setProviderConfigRaw(_actorId: string, actorRole: string, code: string, siteId: string | null,
    settings: Record<string, string> | null, secretCiphertext: string | null,
    secretMeta: Record<string, { set: boolean; last4: string }>, encVersion: number): Promise<ProviderConfigView> {
    this.gate(actorRole);
    if (!this.providersReg.find((x) => x.code === code)) throw new Error("PROVIDER_NOT_FOUND");
    const k = this.cfgKey(code, siteId);
    const prev = this.providerConfigs.get(k);
    const next = {
      settings: settings ?? prev?.settings ?? {},
      ciphertext: secretCiphertext === null ? (prev?.ciphertext ?? null) : (secretCiphertext === "" ? null : secretCiphertext),
      meta: secretCiphertext === null ? (prev?.meta ?? {}) : (secretCiphertext === "" ? {} : (secretMeta ?? {})),
      encVersion: encVersion ?? prev?.encVersion ?? 1,
      updatedAt: new Date().toISOString(),
    };
    this.providerConfigs.set(k, next);
    return { providerCode: code, siteId, settings: { ...next.settings }, secretMeta: { ...next.meta }, hasSecret: next.ciphertext != null, encVersion: next.encVersion, updatedAt: next.updatedAt, exists: true };
  }
  async resolveProviderConfig(code: string, siteId: string | null): Promise<ProviderConfigResolved | null> {
    const site = siteId ? this.providerConfigs.get(this.cfgKey(code, siteId)) : null;
    const row = site ?? this.providerConfigs.get(this.cfgKey(code, null));
    if (!row) return null;
    return { providerCode: code, siteId: site ? siteId : null, settings: { ...row.settings }, secretCiphertext: row.ciphertext, encVersion: row.encVersion, scope: site ? "site" : "global" };
  }

  private gc: GlobalConfig = {
    depositsEnabled: true, withdrawalsEnabled: true, playEnabled: true, marketersEnabled: true,
    registrationsEnabled: true, maintenanceMessage: null, globalDailyPoolCents: null,
    playerEconomy: {}, marketerEconomy: {}, payments: {}, version: 1, updatedAt: null,
  };
  private dists: PoolDistribution[] = [];
  async getGlobalConfig(): Promise<GlobalConfig> { return { ...this.gc }; }
  async setGlobalConfig(_actorId: string, actorRole: string, patch: JsonPatch): Promise<GlobalConfig> {
    this.gate(actorRole);
    for (const k of ["depositsEnabled", "withdrawalsEnabled", "playEnabled", "marketersEnabled", "registrationsEnabled"] as const) {
      const snake = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      if (snake in patch && typeof patch[snake] === "boolean") this.gc[k] = patch[snake] as boolean;
    }
    if ("maintenance_message" in patch) this.gc.maintenanceMessage = (patch.maintenance_message as string) || null;
    // Economy blocks (0099): shallow-merge per field over the current block (mirrors the DB RPC's `||`).
    if ("player_economy" in patch) this.gc.playerEconomy = { ...this.gc.playerEconomy, ...parseCohort(patch.player_economy) };
    if ("marketer_economy" in patch) this.gc.marketerEconomy = { ...this.gc.marketerEconomy, ...parseCohort(patch.marketer_economy) };
    if ("payments" in patch) this.gc.payments = { ...this.gc.payments, ...parsePayments(patch.payments) };
    this.gc.version += 1; this.gc.updatedAt = new Date().toISOString();
    return { ...this.gc };
  }
  async distributePool(_actorId: string, actorRole: string, totalCents: number | null, mode: string, overrides?: Record<string, number> | null, _platformId?: string | null): Promise<DistributeResult> {
    this.gate(actorRole);
    if (mode !== "equal" && mode !== "per_site") throw new Error("INVALID_MODE");
    const active = [...this.sites.values()].filter((s) => s.status === "active");
    if (active.length === 0) throw new Error("NO_ACTIVE_SITES");
    const perSite: Record<string, number> = {};
    if (mode === "equal") {
      if (totalCents == null || totalCents < 0) throw new Error("INVALID_AMOUNT");
      const base = Math.floor(totalCents / active.length); const rem = totalCents - base * active.length;
      active.forEach((s, i) => { perSite[s.siteId] = base + (i === 0 ? rem : 0); });
    } else {
      for (const s of active) { const a = overrides?.[s.siteId]; if (a == null) continue; if (a < 0) throw new Error("INVALID_AMOUNT"); perSite[s.siteId] = a; }
    }
    const applied = Object.values(perSite).reduce((a, b) => a + b, 0);
    this.gc.globalDailyPoolCents = totalCents ?? applied;
    this.dists.unshift({ id: this.dists.length + 1, totalCents: totalCents ?? applied, mode, siteCount: Object.keys(perSite).length, perSite, createdAt: new Date().toISOString() });
    return { totalCents: totalCents ?? applied, mode, perSite };
  }
  async listPoolDistributions(limit = 20, _platformId?: string | null): Promise<PoolDistribution[]> { return this.dists.slice(0, limit); }

  /** Test/dev demand preview: no turnover history is tracked in-memory, so forecasts are 0 (all idle). */
  async poolDemand(opts: PoolDemandOpts, _platformId?: string | null): Promise<PoolDemandPreview> {
    const alpha = opts.alpha ?? 0.4, floorFrac = opts.floorFrac ?? 0.015, capMult = opts.capMult ?? 2.5;
    const baselineDays = Math.min(90, Math.max(Math.floor(opts.lookbackDays ?? 14), Math.floor(opts.baselineDays ?? 45)));
    const configuredFloorCents = Math.max(0, Math.floor(opts.configuredFloorCents ?? 0));
    const active = [...this.sites.values()].filter((s) => s.status === "active");
    const totalCents = opts.totalCents != null ? Math.max(0, Math.floor(opts.totalCents)) : 0;
    const alloc = distributeDynamicPool(
      active.map((s) => ({ siteId: s.siteId, houseEdge: s.config.houseEdge, forecastTurnoverCents: 0, expectedTurnoverCents: 0 })),
      totalCents, { floorFrac, capMult, configuredFloorCents });
    const byId = new Map(alloc.map((a) => [a.siteId, a]));
    const rows: PoolDemandRow[] = active.map((s) => {
      const a = byId.get(s.siteId)!;
      return { siteId: s.siteId, slug: s.slug, targetRtp: a.targetRtp, forecastTurnoverCents: 0,
        recentTurnoverCents: 0, requiredCents: 0, currentPoolCents: 0, suggestedCents: a.allocCents,
        coverage: 1, expectedTurnoverCents: 0, floorCents: 0 };
    });
    return { lookbackDays: Math.floor(opts.lookbackDays ?? 14), totalCents, alpha, floorFrac, capMult,
      rows, suggestedTotalCents: rows.reduce((x, r) => x + r.suggestedCents, 0),
      reserveCents: totalCents - rows.reduce((x, r) => x + r.suggestedCents, 0),
      baselineDays, configuredFloorCents };
  }

  async distributePoolDynamic(actorId: string, actorRole: string, opts: PoolDemandOpts, platformId?: string | null): Promise<DistributeDynamicResult> {
    const preview = await this.poolDemand(opts, platformId);
    const overrides: Record<string, number> = {};
    for (const r of preview.rows) overrides[r.siteId] = r.suggestedCents;
    const result = await this.distributePool(actorId, actorRole, preview.totalCents, "per_site", overrides, platformId);
    return { ...result, preview };
  }
}

/** Thin service over the repo: input validation + a stable surface for the API + console. */
export class PlatformService {
  constructor(private readonly repo: PlatformRepository) {}
  listSites(platformScope?: string | null): Promise<SiteWithConfig[]> { return this.repo.listSites(platformScope ?? null); }
  overview(actorId: string, actorRole: string): Promise<SiteKpis[]> { return this.repo.overview(actorId, actorRole); }
  platformOfSite(siteId: string): Promise<string | null> { return this.repo.platformOfSite(siteId); }
  performance(fromMs: number, toMs: number, platformScope?: string | null): Promise<SitePerformance[]> {
    const from = Number(fromMs), to = Number(toMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("INVALID_RANGE");
    return this.repo.performance(from, to, platformScope ?? null);
  }
  createSite(actorId: string, actorRole: string, input: CreateSiteInput): Promise<string> {
    if (!input || typeof input.slug !== "string" || typeof input.name !== "string" || !input.slug.trim() || !input.name.trim()) {
      throw new Error("INVALID_BRAND");
    }
    return this.repo.createSite(actorId, actorRole, input);
  }
  updateSite(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteRow> {
    if (!patch || typeof patch !== "object") throw new Error("INVALID_PATCH");
    return this.repo.updateSite(actorId, actorRole, siteId, patch);
  }
  setSiteConfig(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteConfigRow> {
    if (!patch || typeof patch !== "object") throw new Error("INVALID_PATCH");
    return this.repo.setSiteConfig(actorId, actorRole, siteId, patch);
  }

  // ── Platform tier (Issue 1) — SYSTEM-only platform governance (validated → repo → RPCs). ──
  listPlatforms(): Promise<PlatformRow[]> { return this.repo.listPlatforms(); }
  platformsOverview(actorRole: string): Promise<PlatformKpis[]> { return this.repo.platformsOverview(actorRole); }
  createPlatform(actorId: string, actorRole: string, slug: string, name: string, ownerUserId?: string | null): Promise<string> {
    if (typeof slug !== "string" || !slug.trim() || typeof name !== "string" || !name.trim()) throw new Error("INVALID_PLATFORM");
    return this.repo.createPlatform(actorId, actorRole, slug.trim(), name.trim(), ownerUserId ?? null);
  }
  updatePlatform(actorId: string, actorRole: string, platformId: string, patch: JsonPatch): Promise<PlatformRow> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("INVALID_PATCH");
    if (typeof platformId !== "string" || !platformId) throw new Error("INVALID_PLATFORM");
    return this.repo.updatePlatform(actorId, actorRole, platformId, patch);
  }
  assignSiteToPlatform(actorId: string, actorRole: string, siteId: string, platformId: string): Promise<{ siteId: string; platformId: string }> {
    if (typeof siteId !== "string" || !siteId || typeof platformId !== "string" || !platformId) throw new Error("INVALID_ARGS");
    return this.repo.assignSiteToPlatform(actorId, actorRole, siteId, platformId);
  }
  appointPlatformAdmin(actorId: string, actorRole: string, targetUserId: string, platformId: string): Promise<AppointResult> {
    if (typeof targetUserId !== "string" || !targetUserId || typeof platformId !== "string" || !platformId) throw new Error("INVALID_ARGS");
    return this.repo.appointPlatformAdmin(actorId, actorRole, targetUserId, platformId);
  }
  revokePlatformAdmin(actorId: string, actorRole: string, targetUserId: string, newRole: string): Promise<{ userId: string; role: string }> {
    if (typeof targetUserId !== "string" || !targetUserId) throw new Error("INVALID_ARGS");
    return this.repo.revokePlatformAdmin(actorId, actorRole, targetUserId, newRole);
  }

  // ── Task R: cross-brand marketer rollup (reporting only) ──
  marketerRollup(actorRole: string): Promise<MarketerRollupRow[]> { return this.repo.marketerRollup(actorRole); }
  createMarketerGlobal(actorId: string, actorRole: string, label: string): Promise<string> {
    if (typeof label !== "string" || !label.trim()) throw new Error("INVALID_LABEL");
    return this.repo.createMarketerGlobal(actorId, actorRole, label.trim());
  }
  linkMarketer(actorId: string, actorRole: string, affiliateUserId: string, globalId: string | null): Promise<void> {
    if (typeof affiliateUserId !== "string" || !affiliateUserId) throw new Error("INVALID_AFFILIATE");
    if (globalId !== null && typeof globalId !== "string") throw new Error("INVALID_GLOBAL");
    return this.repo.linkMarketer(actorId, actorRole, affiliateUserId, globalId);
  }
  setSiteTheme(actorId: string, actorRole: string, siteId: string, tokens: JsonPatch): Promise<SiteRow> {
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error("INVALID_PATCH");
    return this.repo.setSiteTheme(actorId, actorRole, siteId, tokens);
  }
  setSiteOwner(actorId: string, actorRole: string, siteId: string, ownerUserId: string | null): Promise<SiteRow> {
    return this.repo.setSiteOwner(actorId, actorRole, siteId, ownerUserId);
  }
  setDefaultMarketer(actorId: string, actorRole: string, marketerId: string, makeDefault: boolean): Promise<SiteRow> {
    return this.repo.setDefaultMarketer(actorId, actorRole, marketerId, makeDefault);
  }

  // ── Global config console (migration 0092) ──
  getGlobalConfig(): Promise<GlobalConfig> { return this.repo.getGlobalConfig(); }
  setGlobalConfig(actorId: string, actorRole: string, patch: JsonPatch): Promise<GlobalConfig> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("INVALID_PATCH");
    return this.repo.setGlobalConfig(actorId, actorRole, patch);
  }
  distributePool(actorId: string, actorRole: string, totalCents: number | null, mode: string, overrides?: Record<string, number> | null, platformId?: string | null): Promise<DistributeResult> {
    if (mode !== "equal" && mode !== "per_site") throw new Error("INVALID_MODE");
    if (mode === "equal" && (totalCents == null || !Number.isInteger(totalCents) || totalCents < 0)) throw new Error("INVALID_AMOUNT");
    if (mode === "per_site" && (!overrides || Object.keys(overrides).length === 0)) throw new Error("INVALID_OVERRIDES");
    return this.repo.distributePool(actorId, actorRole, totalCents, mode, overrides ?? null, platformId ?? null);
  }
  listPoolDistributions(limit?: number, platformId?: string | null): Promise<PoolDistribution[]> { return this.repo.listPoolDistributions(limit, platformId ?? null); }

  // ── Payment-gateway provider switches (migration 0116) ──
  listPaymentProviders(actorRole: string): Promise<PaymentProvidersView> { return this.repo.listPaymentProviders(actorRole); }
  setProviderGlobal(actorId: string, actorRole: string, code: string, enabled: boolean): Promise<void> {
    if (!code || typeof code !== "string") throw new Error("INVALID_PROVIDER");
    if (typeof enabled !== "boolean") throw new Error("INVALID_ENABLED");
    // A gateway with no player deposit rail (config-only) can never be switched live for players.
    if (enabled && !PLAYER_DEPOSIT_RAILS.has(code)) throw new Error("PROVIDER_NOT_PLAYER_READY");
    return this.repo.setProviderGlobal(actorId, actorRole, code, enabled);
  }
  setProviderSite(actorId: string, actorRole: string, siteId: string, code: string, enabled: boolean): Promise<void> {
    if (!siteId || typeof siteId !== "string") throw new Error("INVALID_SITE");
    if (!code || typeof code !== "string") throw new Error("INVALID_PROVIDER");
    if (typeof enabled !== "boolean") throw new Error("INVALID_ENABLED");
    if (enabled && !PLAYER_DEPOSIT_RAILS.has(code)) throw new Error("PROVIDER_NOT_PLAYER_READY");
    return this.repo.setProviderSite(actorId, actorRole, siteId, code, enabled);
  }
  clearProviderSite(actorId: string, actorRole: string, siteId: string, code: string): Promise<void> {
    if (!siteId || !code) throw new Error("INVALID_ARGS");
    return this.repo.clearProviderSite(actorId, actorRole, siteId, code);
  }

  // ── Gateway config (migration 0130): validation + AES-GCM encryption live here; the repo just stores ──
  /** The field schema for every configurable gateway (serialised to the console so the form matches the backend). */
  gatewaySchemas(): Record<string, GatewaySchema> { return GATEWAY_SCHEMAS; }

  /** Masked config read for one provider/scope (settings + secret hints; never the secret itself). */
  getProviderConfig(actorRole: string, code: string, siteId: string | null = null): Promise<ProviderConfigView> {
    getSchema(code); // PROVIDER_NOT_CONFIGURABLE for unknown codes
    return this.repo.getProviderConfigRaw(actorRole, code, siteId);
  }

  /**
   * Validate + persist a config submission. Settings are MERGED over what's stored (a partial submit
   * never nukes untouched fields); secret fields supplied now are MERGED over the existing decrypted
   * secrets and the whole set re-encrypted (so updating one of two secrets never drops the other).
   * Passing no secret fields leaves the stored secret untouched.
   */
  async setProviderConfig(actorId: string, actorRole: string, code: string, siteId: string | null,
    values: Record<string, unknown>): Promise<ProviderConfigView> {
    getSchema(code);
    const split = splitSubmission(code, values);
    // drop blank secret submissions (empty string = "leave as is", not "clear")
    for (const k of Object.keys(split.secrets)) if (String(split.secrets[k]).trim() === "") delete split.secrets[k];

    const current = await this.repo.getProviderConfigRaw(actorRole, code, siteId);
    const existingSecretKeys = Object.keys(current.secretMeta ?? {}).filter((k) => current.secretMeta[k]?.set);
    // Validate the EFFECTIVE state (stored settings + this submission), so a partial edit doesn't trip
    // "required" on a field that's already on file. Secrets already stored are honoured via existingSecretKeys.
    const mergedSettings = { ...current.settings, ...split.settings };
    const issues = validateConfig(code, { settings: mergedSettings, secrets: split.secrets }, existingSecretKeys);
    if (issues.length) { const e = new Error("VALIDATION") as Error & { issues: ValidationIssue[] }; e.issues = issues; throw e; }
    let ciphertext: string | null = null; // null => keep existing secret untouched
    let meta = current.secretMeta ?? {};
    let encVersion = current.encVersion || 1;

    const suppliedSecretKeys = Object.keys(split.secrets);
    if (suppliedSecretKeys.length) {
      if (!isEncryptionConfigured()) throw new Error("ENC_KEY_NOT_CONFIGURED");
      // merge supplied secrets over the existing decrypted set (exact-scope only) so partial edits are safe
      let mergedSecrets: Record<string, string> = { ...split.secrets };
      const resolved = await this.repo.resolveProviderConfig(code, siteId);
      const sameScope = !!resolved && ((siteId == null && resolved.siteId == null) || (siteId != null && resolved.siteId === siteId));
      if (sameScope && resolved!.secretCiphertext) {
        try { mergedSecrets = { ...decryptSecrets(resolved!.secretCiphertext), ...split.secrets }; } catch { /* corrupt/rotated: replace */ }
      }
      const enc = encryptSecrets(mergedSecrets);
      ciphertext = enc.ciphertext; meta = enc.meta; encVersion = enc.encVersion;
    }
    return this.repo.setProviderConfigRaw(actorId, actorRole, code, siteId, mergedSettings, ciphertext, meta, encVersion);
  }

  /**
   * SAFE read-only connectivity test. Builds the effective config (stored, decrypted) overlaid with any
   * unsaved DRAFT values the admin typed, then hits each provider's non-mutating endpoint. Never moves money.
   */
  async testProviderConnection(actorRole: string, code: string, siteId: string | null,
    draftValues: Record<string, unknown> = {}): Promise<ConnResult> {
    if (actorRole !== "platform_superadmin") throw new Error("NOT_AUTHORIZED");
    getSchema(code);
    const draft = splitSubmission(code, draftValues);
    for (const k of Object.keys(draft.secrets)) if (String(draft.secrets[k]).trim() === "") delete draft.secrets[k];
    let cfg: Record<string, string> = {};
    const resolved = await this.repo.resolveProviderConfig(code, siteId);
    if (resolved) {
      cfg = { ...resolved.settings };
      if (resolved.secretCiphertext) { try { Object.assign(cfg, decryptSecrets(resolved.secretCiphertext)); } catch { /* ignore */ } }
    }
    cfg = { ...cfg, ...draft.settings, ...draft.secrets }; // draft overrides stored
    return testConnection(code, cfg);
  }

  /**
   * ENGINE-INTERNAL: resolve a provider's effective config with DECRYPTED secrets (site → global),
   * for building a live client. Not role-gated (service-role/engine path). Returns null when there is
   * no config row, and empty secrets when the ciphertext is missing/corrupt (caller falls back to env).
   */
  async resolveDecryptedConfig(code: string, siteId: string | null = null):
    Promise<{ settings: Record<string, string>; secrets: Record<string, string> } | null> {
    const r = await this.repo.resolveProviderConfig(code, siteId);
    if (!r) return null;
    let secrets: Record<string, string> = {};
    if (r.secretCiphertext) { try { secrets = decryptSecrets(r.secretCiphertext); } catch { secrets = {}; } }
    return { settings: r.settings ?? {}, secrets };
  }

  // ── Dynamic (demand-based) pool distribution (docs/25 §15) ──
  poolDemand(opts: PoolDemandOpts, platformId?: string | null): Promise<PoolDemandPreview> { return this.repo.poolDemand(opts ?? {}, platformId ?? null); }
  distributePoolDynamic(actorId: string, actorRole: string, opts: PoolDemandOpts, platformId?: string | null): Promise<DistributeDynamicResult> {
    return this.repo.distributePoolDynamic(actorId, actorRole, opts ?? {}, platformId ?? null);
  }
}
