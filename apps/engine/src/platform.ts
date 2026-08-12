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

export interface PlatformRepository {
  listSites(): Promise<SiteWithConfig[]>;
  createSite(actorId: string, actorRole: string, input: CreateSiteInput): Promise<string>;
  updateSite(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteRow>;
  setSiteConfig(actorId: string, actorRole: string, siteId: string, patch: JsonPatch): Promise<SiteConfigRow>;
  overview(actorRole: string): Promise<SiteKpis[]>;
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
      licenceLine: null, supportEmail: null, config: { ...DEFAULT_CONFIG },
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
}
