import { randomUUID } from "node:crypto";
import {
  parseCohort, parsePayments, distributeDynamicPool, emaForecast,
  type CohortEconomy, type PaymentsEconomy,
} from "@invest254/shared";
import type { Querier } from "./wallet.js";

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
  currency: string; locale: string; chartStyle: string; licenceLine: string | null; supportEmail: string | null;
  // Per-brand M-Pesa config (non-secret) + which secret refs are configured + legal copy (docs/24).
  mpesaEnv: string | null; mpesaShortcode: string | null; mpesaCallbackBase: string | null; mpesaB2cInitiator: string | null;
  hasMpesaConsumerKey: boolean; hasMpesaConsumerSecret: boolean; hasMpesaPasskey: boolean; hasMpesaB2cCredential: boolean;
  legalCopy: Record<string, unknown> | null;
  ownerUserId: string | null;
}
export interface SiteConfigRow {
  houseEdge: number; maxMultiplier: number; minStakeCents: number; maxStakeCents: number; minWithdrawalCents: number;
  defaultDurationS: number; tickRateMs: number; driftBias: number; volatility: number; targetWinRate: number; version: number;
}
export interface SiteWithConfig extends SiteRow { config: SiteConfigRow }
export interface SiteKpis {
  siteId: string; slug: string; name: string; status: string;
  users: number; depositsCents: number; withdrawalsCents: number; ggrCents: number; openPositions: number; bets: number;
}
export interface CreateSiteInput { slug: string; name: string; currency?: string | undefined; primaryDomain?: string | null | undefined; }
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
}
export interface PoolDemandRow {
  siteId: string; slug: string; targetRtp: number;
  forecastTurnoverCents: number; recentTurnoverCents: number; requiredCents: number;
  currentPoolCents: number; suggestedCents: number;
  /** suggested / required — <1 means the brand is under-funded for its target RTP at forecast demand. */
  coverage: number;
}
export interface PoolDemandPreview {
  lookbackDays: number; totalCents: number; alpha: number; floorFrac: number; capMult: number;
  rows: PoolDemandRow[]; suggestedTotalCents: number; reserveCents: number;
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

export interface PlatformRepository {
  listSites(): Promise<SiteWithConfig[]>;
  createSite(actorId: string, actorRole: string, input: CreateSiteInput): Promise<string>;
  updateSite(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteRow>;
  setSiteConfig(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteConfigRow>;
  overview(actorRole: string): Promise<SiteKpis[]>;
  /** Per-brand performance within a time window (read-only; the API route gates on platform_superadmin). */
  performance(fromMs: number, toMs: number): Promise<SitePerformance[]>;
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
  distributePool(actorId: string, actorRole: string, totalCents: number | null, mode: string, overrides?: Record<string, number> | null): Promise<DistributeResult>;
  listPoolDistributions(limit?: number): Promise<PoolDistribution[]>;
  /** Preview demand-based allocation (read-only; does NOT apply). */
  poolDemand(opts: PoolDemandOpts): Promise<PoolDemandPreview>;
  /** Compute the demand-based allocation and APPLY it via the audited per-site distributor. */
  distributePoolDynamic(actorId: string, actorRole: string, opts: PoolDemandOpts): Promise<DistributeDynamicResult>;
}

const num = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number)) || 0;

function mapSiteRow(x: Record<string, unknown>): SiteRow {
  return {
    siteId: String(x.id ?? x.site_id), slug: String(x.slug), name: String(x.name), status: String(x.status),
    primaryDomain: (x.primary_domain as string) ?? null, logoUrl: (x.logo_url as string) ?? null,
    faviconUrl: (x.favicon_url as string) ?? null, wordmarkText: (x.wordmark_text as string) ?? null,
    colorPrimary: String(x.color_primary), colorBg: String(x.color_bg), colorAccent: String(x.color_accent), theme: String(x.theme),
    currency: String(x.currency), locale: String(x.locale), chartStyle: (x.chart_style as string) ?? "line",
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
    minWithdrawalCents: num(x.min_withdrawal), defaultDurationS: num(x.default_duration_s), tickRateMs: num(x.tick_rate_ms),
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

  async listSites(): Promise<SiteWithConfig[]> {
    const r = await this.q.query(
      `select s.*, c.house_edge, c.max_multiplier, c.min_stake, c.max_stake, c.min_withdrawal,
              c.default_duration_s, c.tick_rate_ms, c.drift_bias, c.volatility, c.target_win_rate, c.version
         from sites s left join site_game_config c on c.site_id = s.id
        order by s.created_at asc`, []);
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

  async overview(actorRole: string): Promise<SiteKpis[]> {
    const r = await this.q.query("select * from fn_platform_overview($1)", [actorRole]);
    return r.rows.map((x: Record<string, unknown>) => ({
      siteId: String(x.site_id), slug: String(x.slug), name: String(x.name), status: String(x.status),
      users: num(x.users), depositsCents: num(x.deposits_cents), withdrawalsCents: num(x.withdrawals_cents),
      ggrCents: num(x.ggr_cents), openPositions: num(x.open_positions), bets: num(x.bets),
    }));
  }

  async performance(fromMs: number, toMs: number): Promise<SitePerformance[]> {
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
        order by s.created_at asc`,
      [from, to],
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
  async distributePool(actorId: string, actorRole: string, totalCents: number | null, mode: string, overrides?: Record<string, number> | null): Promise<DistributeResult> {
    const r = await this.q.query("select public.fn_platform_distribute_pool($1,$2,$3,$4,$5) as r",
      [actorId, actorRole, totalCents, mode, overrides ? JSON.stringify(overrides) : null]);
    const x = r.rows[0].r as Record<string, unknown>;
    return { totalCents: num(x.total_cents), mode: String(x.mode), perSite: (x.per_site as Record<string, number>) ?? {} };
  }
  async listPoolDistributions(limit = 20): Promise<PoolDistribution[]> {
    const r = await this.q.query(
      "select id, total_cents, mode, site_count, per_site, created_at from public.platform_pool_distributions order by created_at desc limit $1", [limit]);
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
  async poolDemand(opts: PoolDemandOpts): Promise<PoolDemandPreview> {
    const lookbackDays = Math.min(90, Math.max(3, Math.floor(opts.lookbackDays ?? 14)));
    const alpha = opts.alpha ?? 0.4, floorFrac = opts.floorFrac ?? 0.015, capMult = opts.capMult ?? 2.5;
    const sitesR = await this.q.query(
      `select s.id, s.slug, s.default_daily_pool_cents, coalesce(g.house_edge, 0.05) as house_edge
         from public.sites s left join public.site_game_config g on g.site_id = s.id
        where s.status = 'active' and s.pool_mode = true
        order by s.created_at`, []);
    const turnR = await this.q.query(
      `select d.site_id::text as site_id, (d.pool_day)::text as day, coalesce(sum(p.stake), 0)::bigint as turnover
         from public.position_decision d join public.positions p on p.id = d.position_id
        where d.pool_day > current_date - $1::int
        group by d.site_id, d.pool_day`, [lookbackDays]);

    const perSiteDay = new Map<string, Map<string, number>>();
    for (const row of turnR.rows) {
      const sid = String(row.site_id), day = String(row.day);
      if (!perSiteDay.has(sid)) perSiteDay.set(sid, new Map());
      perSiteDay.get(sid)!.set(day, num(row.turnover));
    }
    const days = eatWindowDays(lookbackDays);
    const brands = sitesR.rows.map((s: Record<string, unknown>) => {
      const sid = String(s.id);
      const m = perSiteDay.get(sid) ?? new Map<string, number>();
      const series = days.map((d) => m.get(d) ?? 0);
      return {
        siteId: sid, slug: String(s.slug), houseEdge: num(s.house_edge),
        currentPoolCents: num(s.default_daily_pool_cents),
        recentTurnoverCents: series.reduce((a, b) => a + b, 0),
        forecastTurnoverCents: emaForecast(series, alpha),
      };
    });
    const totalCents = opts.totalCents != null
      ? Math.max(0, Math.floor(opts.totalCents))
      : brands.reduce((a, b) => a + b.currentPoolCents, 0);

    const alloc = distributeDynamicPool(
      brands.map((b) => ({ siteId: b.siteId, houseEdge: b.houseEdge, forecastTurnoverCents: b.forecastTurnoverCents })),
      totalCents, { floorFrac, capMult });
    const allocById = new Map(alloc.map((a) => [a.siteId, a]));

    const rows: PoolDemandRow[] = brands.map((b) => {
      const a = allocById.get(b.siteId)!;
      return {
        siteId: b.siteId, slug: b.slug, targetRtp: a.targetRtp,
        forecastTurnoverCents: Math.round(b.forecastTurnoverCents), recentTurnoverCents: b.recentTurnoverCents,
        requiredCents: a.requiredCents, currentPoolCents: b.currentPoolCents, suggestedCents: a.allocCents,
        coverage: a.requiredCents > 0 ? a.allocCents / a.requiredCents : 1,
      };
    });
    const suggestedTotalCents = rows.reduce((a, b) => a + b.suggestedCents, 0);
    return { lookbackDays, totalCents, alpha, floorFrac, capMult, rows, suggestedTotalCents, reserveCents: totalCents - suggestedTotalCents };
  }

  async distributePoolDynamic(actorId: string, actorRole: string, opts: PoolDemandOpts): Promise<DistributeDynamicResult> {
    const preview = await this.poolDemand(opts);
    if (!preview.rows.length) throw new Error("NO_ACTIVE_SITES");
    const overrides: Record<string, number> = {};
    for (const r of preview.rows) overrides[r.siteId] = r.suggestedCents; // includes 0 for idle brands (explicit)
    // Reuse the audited per-site distributor (0092): sets each brand's recurring default_daily_pool_cents.
    const result = await this.distributePool(actorId, actorRole, preview.totalCents, "per_site", overrides);
    return { ...result, preview };
  }
}

const DEFAULT_CONFIG: SiteConfigRow = {
  houseEdge: 0.75, maxMultiplier: 5, minStakeCents: 25000, maxStakeCents: 5000000, minWithdrawalCents: 25000,
  defaultDurationS: 10, tickRateMs: 150, driftBias: 0.3, volatility: 1, targetWinRate: 0.125, version: 1,
};
const DEFAULT_SITE_ID = "00000000-0000-0000-0000-000000000001";

/** In-memory platform repo for tests. Enforces the platform_superadmin gate; seeds the default brand. */
export class InMemoryPlatformRepository implements PlatformRepository {
  private readonly sites = new Map<string, SiteWithConfig>();
  /** Optional KPI source so overview can return real numbers in tests. */
  kpis: (siteId: string) => Omit<SiteKpis, "siteId" | "slug" | "name" | "status"> = () => ({
    users: 0, depositsCents: 0, withdrawalsCents: 0, ggrCents: 0, openPositions: 0, bets: 0,
  });

  constructor() {
    this.sites.set(DEFAULT_SITE_ID, {
      siteId: DEFAULT_SITE_ID, slug: "invest254", name: "Invest254", status: "active",
      primaryDomain: "invest254.com", logoUrl: null, faviconUrl: null, wordmarkText: "invest254.com",
      colorPrimary: "#22c55e", colorBg: "#0a0a0a", colorAccent: "#06b6d4", theme: "dark",
      currency: "KES", locale: "en-KE", chartStyle: "line", licenceLine: "Operated under licence.", supportEmail: null,
      mpesaEnv: null, mpesaShortcode: null, mpesaCallbackBase: null, mpesaB2cInitiator: null,
      hasMpesaConsumerKey: false, hasMpesaConsumerSecret: false, hasMpesaPasskey: false, hasMpesaB2cCredential: false,
      legalCopy: null,
      ownerUserId: null,
      config: { ...DEFAULT_CONFIG },
    });
  }
  private gate(role: string) { if (role !== "platform_superadmin") throw new Error("NOT_AUTHORIZED"); }

  async listSites(): Promise<SiteWithConfig[]> { return [...this.sites.values()]; }

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
      colorAccent: "#06b6d4", theme: "dark", currency: input.currency ?? "KES", locale: "en-KE", chartStyle: "line",
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
    this.gate(actorRole);
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
    this.gate(actorRole);
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

  async overview(actorRole: string): Promise<SiteKpis[]> {
    this.gate(actorRole);
    return [...this.sites.values()].map((s) => ({ siteId: s.siteId, slug: s.slug, name: s.name, status: s.status, ...this.kpis(s.siteId) }));
  }

  async performance(_fromMs: number, _toMs: number): Promise<SitePerformance[]> {
    // No transaction/position store in the in-memory repo — return each brand with zeroed metrics.
    return [...this.sites.values()].map((s) => ({
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
    if (!["admin", "superadmin", "platform_superadmin"].includes(actorRole)) throw new Error("NOT_AUTHORIZED");
    const s = this.sites.get(DEFAULT_SITE_ID)!;
    s.ownerUserId = makeDefault ? marketerId : (s.ownerUserId === marketerId ? null : s.ownerUserId);
    const { config, ...row } = s;
    return { ...row };
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
  async distributePool(_actorId: string, actorRole: string, totalCents: number | null, mode: string, overrides?: Record<string, number> | null): Promise<DistributeResult> {
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
  async listPoolDistributions(limit = 20): Promise<PoolDistribution[]> { return this.dists.slice(0, limit); }

  /** Test/dev demand preview: no turnover history is tracked in-memory, so forecasts are 0 (all idle). */
  async poolDemand(opts: PoolDemandOpts): Promise<PoolDemandPreview> {
    const alpha = opts.alpha ?? 0.4, floorFrac = opts.floorFrac ?? 0.015, capMult = opts.capMult ?? 2.5;
    const active = [...this.sites.values()].filter((s) => s.status === "active");
    const totalCents = opts.totalCents != null ? Math.max(0, Math.floor(opts.totalCents)) : 0;
    const alloc = distributeDynamicPool(
      active.map((s) => ({ siteId: s.siteId, houseEdge: s.config.houseEdge, forecastTurnoverCents: 0 })),
      totalCents, { floorFrac, capMult });
    const byId = new Map(alloc.map((a) => [a.siteId, a]));
    const rows: PoolDemandRow[] = active.map((s) => {
      const a = byId.get(s.siteId)!;
      return { siteId: s.siteId, slug: s.slug, targetRtp: a.targetRtp, forecastTurnoverCents: 0,
        recentTurnoverCents: 0, requiredCents: 0, currentPoolCents: 0, suggestedCents: a.allocCents,
        coverage: 1 };
    });
    return { lookbackDays: Math.floor(opts.lookbackDays ?? 14), totalCents, alpha, floorFrac, capMult,
      rows, suggestedTotalCents: rows.reduce((x, r) => x + r.suggestedCents, 0),
      reserveCents: totalCents - rows.reduce((x, r) => x + r.suggestedCents, 0) };
  }

  async distributePoolDynamic(actorId: string, actorRole: string, opts: PoolDemandOpts): Promise<DistributeDynamicResult> {
    const preview = await this.poolDemand(opts);
    const overrides: Record<string, number> = {};
    for (const r of preview.rows) overrides[r.siteId] = r.suggestedCents;
    const result = await this.distributePool(actorId, actorRole, preview.totalCents, "per_site", overrides);
    return { ...result, preview };
  }
}

/** Thin service over the repo: input validation + a stable surface for the API + console. */
export class PlatformService {
  constructor(private readonly repo: PlatformRepository) {}
  listSites(): Promise<SiteWithConfig[]> { return this.repo.listSites(); }
  overview(actorRole: string): Promise<SiteKpis[]> { return this.repo.overview(actorRole); }
  performance(fromMs: number, toMs: number): Promise<SitePerformance[]> {
    const from = Number(fromMs), to = Number(toMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("INVALID_RANGE");
    return this.repo.performance(from, to);
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
  distributePool(actorId: string, actorRole: string, totalCents: number | null, mode: string, overrides?: Record<string, number> | null): Promise<DistributeResult> {
    if (mode !== "equal" && mode !== "per_site") throw new Error("INVALID_MODE");
    if (mode === "equal" && (totalCents == null || !Number.isInteger(totalCents) || totalCents < 0)) throw new Error("INVALID_AMOUNT");
    if (mode === "per_site" && (!overrides || Object.keys(overrides).length === 0)) throw new Error("INVALID_OVERRIDES");
    return this.repo.distributePool(actorId, actorRole, totalCents, mode, overrides ?? null);
  }
  listPoolDistributions(limit?: number): Promise<PoolDistribution[]> { return this.repo.listPoolDistributions(limit); }

  // ── Dynamic (demand-based) pool distribution (docs/25 §15) ──
  poolDemand(opts: PoolDemandOpts): Promise<PoolDemandPreview> { return this.repo.poolDemand(opts ?? {}); }
  distributePoolDynamic(actorId: string, actorRole: string, opts: PoolDemandOpts): Promise<DistributeDynamicResult> {
    return this.repo.distributePoolDynamic(actorId, actorRole, opts ?? {});
  }
}
