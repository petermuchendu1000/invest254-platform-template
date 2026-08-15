import { randomUUID } from "node:crypto";
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
  currency: string; locale: string; licenceLine: string | null; supportEmail: string | null;
  // Per-brand M-Pesa config (non-secret) + which secret refs are configured + legal copy (docs/24).
  mpesaEnv: string | null; mpesaShortcode: string | null; mpesaCallbackBase: string | null; mpesaB2cInitiator: string | null;
  hasMpesaConsumerKey: boolean; hasMpesaConsumerSecret: boolean; hasMpesaPasskey: boolean; hasMpesaB2cCredential: boolean;
  legalCopy: Record<string, unknown> | null;
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
/** A JSON patch of snake_case columns (mirrors the RPC jsonb contract). */
export type JsonPatch = Record<string, unknown>;

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
  // Task R — cross-brand marketer rollup (reporting only; money stays per site).
  marketerRollup(actorRole: string): Promise<MarketerRollupRow[]>;
  createMarketerGlobal(actorId: string, actorRole: string, label: string): Promise<string>;
  linkMarketer(actorId: string, actorRole: string, affiliateUserId: string, globalId: string | null): Promise<void>;
  /** Persist a brand's full design-token palette (docs/22 Task G+). platform_superadmin-gated. */
  setSiteTheme(actorId: string, actorRole: string, siteId: string, tokens: JsonPatch): Promise<SiteRow>;
}

const num = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number)) || 0;

function mapSiteRow(x: Record<string, unknown>): SiteRow {
  return {
    siteId: String(x.id ?? x.site_id), slug: String(x.slug), name: String(x.name), status: String(x.status),
    primaryDomain: (x.primary_domain as string) ?? null, logoUrl: (x.logo_url as string) ?? null,
    faviconUrl: (x.favicon_url as string) ?? null, wordmarkText: (x.wordmark_text as string) ?? null,
    colorPrimary: String(x.color_primary), colorBg: String(x.color_bg), colorAccent: String(x.color_accent), theme: String(x.theme),
    currency: String(x.currency), locale: String(x.locale),
    licenceLine: (x.licence_line as string) ?? null, supportEmail: (x.support_email as string) ?? null,
    mpesaEnv: (x.mpesa_env as string) ?? null, mpesaShortcode: (x.mpesa_shortcode as string) ?? null,
    mpesaCallbackBase: (x.mpesa_callback_base as string) ?? null, mpesaB2cInitiator: (x.mpesa_b2c_initiator as string) ?? null,
    hasMpesaConsumerKey: Boolean(x.mpesa_consumer_key_ref), hasMpesaConsumerSecret: Boolean(x.mpesa_consumer_secret_ref),
    hasMpesaPasskey: Boolean(x.mpesa_passkey_ref), hasMpesaB2cCredential: Boolean(x.mpesa_b2c_credential_ref),
    legalCopy: (x.legal_copy as Record<string, unknown>) ?? null,
  };
}
function mapConfigRow(x: Record<string, unknown>): SiteConfigRow {
  return {
    houseEdge: num(x.house_edge), maxMultiplier: num(x.max_multiplier), minStakeCents: num(x.min_stake), maxStakeCents: num(x.max_stake),
    minWithdrawalCents: num(x.min_withdrawal), defaultDurationS: num(x.default_duration_s), tickRateMs: num(x.tick_rate_ms),
    driftBias: num(x.drift_bias), volatility: num(x.volatility), targetWinRate: num(x.target_win_rate), version: num(x.version),
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
      currency: "KES", locale: "en-KE", licenceLine: "Operated under licence.", supportEmail: null,
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
      colorAccent: "#06b6d4", theme: "dark", currency: input.currency ?? "KES", locale: "en-KE",
      licenceLine: null, supportEmail: null,
      mpesaEnv: null, mpesaShortcode: null, mpesaCallbackBase: null, mpesaB2cInitiator: null,
      hasMpesaConsumerKey: false, hasMpesaConsumerSecret: false, hasMpesaPasskey: false, hasMpesaB2cCredential: false,
      legalCopy: null,
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
      theme: "theme", currency: "currency", locale: "locale", licence_line: "licenceLine", support_email: "supportEmail", status: "status",
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
}

/** Thin service over the repo: input validation + a stable surface for the API + console. */
export class PlatformService {
  constructor(private readonly repo: PlatformRepository) {}
  listSites(): Promise<SiteWithConfig[]> { return this.repo.listSites(); }
  overview(actorRole: string): Promise<SiteKpis[]> { return this.repo.overview(actorRole); }
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
}
