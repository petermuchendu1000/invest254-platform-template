import { Router, ApiError, requireAuth, requireRole, adminScopePlatform, assertTargetPlatformInScope, type Ctx, type Middleware } from "./http.js";
import { COHORT_KEYS, PAYMENT_KEYS } from "@invest254/shared";
import type { MarketerRollupRow } from "@invest254/engine";
import type { ApiDeps } from "./app.js";
import type { ProvisionResult, DomainStatus } from "./domains.js";

// ── Instant client onboarding (docs/21) — brand + economy + optional domain provisioning ──
export interface OnboardColors { primary?: string; bg?: string; accent?: string }
export interface OnboardGame {
  houseEdge?: number; maxMultiplier?: number; minStake?: number; maxStake?: number; minWithdrawal?: number;
  defaultDurationS?: number; tickRateMs?: number; driftBias?: number; volatility?: number; targetWinRate?: number;
}
export interface OnboardInput {
  slug: string; name: string; primaryDomain?: string; currency?: string; locale?: string; theme?: string;
  colors?: OnboardColors; wordmarkText?: string; licenceLine?: string; supportEmail?: string;
  game?: OnboardGame; provisionDomain?: boolean;
}
export interface OnboardBrand {
  siteId: string; slug: string; name: string; primaryDomain: string | null; currency: string;
  status: string; resolvesByHost: boolean;
}
export interface OnboardResult { siteId: string; brand: OnboardBrand; domain: ProvisionResult | null }

/** One domain from the registrar account, annotated with whether it's already a client + suggestions. */
export interface RegistrarDomainRow {
  domain: string; expires: string | null; usingRegistrarDns: boolean;
  alreadyClient: boolean; suggestedSlug: string; suggestedName: string;
}
export interface RegistrarDomainsView { registrarConfigured: boolean; domains: RegistrarDomainRow[] }

/** Real per-domain health from Cloudflare Pages: { "<domain>": "active" | "pending" | ... }. */
export interface DomainHealthView { configured: boolean; statuses: Record<string, string> }

export interface PlatformOnboardDeps {
  /** True when the Cloudflare + Namecheap secrets are present so a domain can be auto-provisioned. */
  domainConfigured: boolean;
  /** True when a registrar API (Namecheap) is configured to auto-set nameservers; false => manual NS. */
  registrarConfigured: boolean;
  /** Per-platform capabilities (a platform admin may have its OWN registrar even if env has none). */
  capabilities(platformId: string | null): Promise<{ domainConfigured: boolean; registrarConfigured: boolean }>;
  /** Create/upsert a brand. platformId stamps the new site into the caller's platform (null = default).
   *  `callerScope` = the platform a BOUNDED caller (platform admin) is confined to, null for the system
   *  owner: re-onboarding an EXISTING slug that lives in another platform is refused (SLUG_TAKEN) —
   *  Issue 1 / F-47 (it used to overwrite another tenant's brand + economy). */
  onboard(input: OnboardInput, platformId: string | null, callerScope?: string | null): Promise<OnboardResult>;
  /** Provisioning status of a domain. A bounded caller may only probe a domain claimed by a brand of its
   *  own platform (DOMAIN_NOT_FOUND otherwise) — F-47. */
  domainStatus(domain: string, callerScope?: string | null): Promise<DomainStatus>;
  /** List the registrar account's domains for the caller's platform, annotated with which are clients. */
  listRegistrarDomains(platformId: string | null): Promise<RegistrarDomainsView>;
  /** Real domain health (Cloudflare Pages custom-domain statuses) so the console never fakes "live".
   *  A bounded caller only sees the domains of its own platform's brands — F-47. */
  domainHealth(callerScope?: string | null): Promise<DomainHealthView>;
}

/** Per-platform registrar (Namecheap) config surface (Issue 1 #3). Implemented by RegistrarConfigService. */
export interface RegistrarConfigDeps {
  get(actorId: string, actorRole: string, platformId: string): Promise<{
    platformId: string; providerCode: string; settings: Record<string, string>;
    secretMeta: Record<string, { set: boolean; last4: string }>; hasSecret: boolean; encVersion: number;
    updatedAt: string | null; exists: boolean; egressIp: string | null; encryptionConfigured: boolean;
  }>;
  set(actorId: string, actorRole: string, platformId: string, values: {
    apiUser?: string; userName?: string; clientIp?: string; apiKey?: string;
  }): Promise<{ platformId: string; hasSecret: boolean; settings: Record<string, string>; exists: boolean }>;
  test(actorId: string, actorRole: string, platformId: string, draft: {
    apiUser?: string; userName?: string; clientIp?: string; apiKey?: string;
  }): Promise<{ ok: boolean; detail: string; egressIp: string | null }>;
}

/**
 * Platform-superadmin console (docs/22 Task H) — cross-brand operations, gated to
 * `platform_superadmin` (a per-brand admin/superadmin never reaches these):
 *   GET   /platform/overview          per-brand KPIs (users, deposits, withdrawals, GGR, positions)
 *   GET   /platform/sites             every brand + its economy (site_game_config)
 *   POST  /platform/sites             onboard a brand (creates the site + default economy)
 *   PATCH /platform/sites/:id         edit a brand's identity/branding
 *   PATCH /platform/sites/:id/config  tune a brand's economy (feasibility enforced by the DB CHECK)
 * Thin transport over the engine PlatformService; the invariants + audit live in the fn_platform_* RPCs.
 */

const BASE = "/api/v1";

const PLATFORM_STATUS: Readonly<Record<string, number>> = {
  NOT_AUTHORIZED: 403,
  INVALID_BRAND: 400,
  INVALID_PATCH: 400,
  INVALID_RANGE: 400,
  OVERRIDE_FAVORS_PLAYER: 422,
  INVALID_OVERRIDE: 400,
  SLUG_TAKEN: 409,
  DOMAIN_NOT_FOUND: 404,   // F-47: a platform admin probing a domain outside its platform
  DOMAIN_TAKEN: 409,       // F-47: a domain already claimed by another brand (case-insensitive)
  SITE_NOT_FOUND: 404,
  site_cfg_feasible: 422, // the economy-feasibility CHECK (RTP/win-rate) rejected the tuning
  // Task R — cross-brand marketer rollup
  INVALID_LABEL: 400,
  INVALID_AFFILIATE: 400,
  INVALID_GLOBAL: 400,
  MARKETER_GLOBAL_NOT_FOUND: 404,
  NOT_AFFILIATE: 404,
  OWNER_NOT_FOUND: 404,
  OWNER_NOT_MARKETER: 422,
  OWNER_WRONG_SITE: 422,
  // Gateway config (migration 0130)
  VALIDATION: 400,
  PROVIDER_NOT_FOUND: 404,
  PROVIDER_NOT_CONFIGURABLE: 400,
  PROVIDER_NOT_PLAYER_READY: 422,
  ENC_KEY_NOT_CONFIGURED: 503,
  INVALID_ARGS: 400,
};

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // Surface the Postgres CHECK name for an infeasible economy as a clean 422.
    const code = /site_cfg_feasible/.test(message) ? "site_cfg_feasible" : message.split(":")[0]!.trim();
    const status = PLATFORM_STATUS[code];
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("VALIDATION", "request body must be a JSON object", 400);
  return body as Record<string, unknown>;
}

/** Parse the optional dynamic-pool-demand query params (all optional; engine applies defaults). */
function parsePoolDemandQuery(ctx: Ctx) {
  const g = ctx.query;
  const numOrU = (k: string) => { const v = g.get(k); return v == null || v === "" ? undefined : Number(v); };
  return {
    lookbackDays: numOrU("lookbackDays"), totalCents: numOrU("totalCents"),
    alpha: numOrU("alpha"), floorFrac: numOrU("floorFrac"), capMult: numOrU("capMult"),
  };
}

/**
 * Fold the flat per-(affiliate, site) rollup rows (Task R) into one entry per marketer — grouped by
 * `marketerGlobalId` when linked, else standalone per affiliate — with a per-site breakdown and the
 * cross-brand totals. This is the "which marketer brought which client on which site, and their
 * total" single view.
 */
interface MarketerGroup {
  marketerGlobalId: string | null; label: string | null;
  sites: Array<{ affiliateUserId: string; siteId: string; siteSlug: string; siteName: string; clients: number; ggrCents: number; commissionCents: number }>;
  totals: { clients: number; ggrCents: number; commissionCents: number };
}
function groupMarketerRollup(rows: MarketerRollupRow[]): MarketerGroup[] {
  const groups = new Map<string, MarketerGroup>();
  for (const r of rows) {
    const key = r.marketerGlobalId ?? `aff:${r.affiliateUserId}`;
    let g = groups.get(key);
    if (!g) {
      g = { marketerGlobalId: r.marketerGlobalId, label: r.label, sites: [], totals: { clients: 0, ggrCents: 0, commissionCents: 0 } };
      groups.set(key, g);
    }
    g.sites.push({ affiliateUserId: r.affiliateUserId, siteId: r.siteId, siteSlug: r.siteSlug, siteName: r.siteName, clients: r.clients, ggrCents: r.ggrCents, commissionCents: r.commissionCents });
    g.totals.clients += r.clients;
    g.totals.ggrCents += r.ggrCents;
    g.totals.commissionCents += r.commissionCents;
  }
  return [...groups.values()];
}

export function registerPlatformRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const platform = requireRole("platform_superadmin");        // SYSTEM owner only
  const platformAdmin = requireRole("platform_admin");        // PLATFORM admin (+ system, higher rank)

  // Platform-scope guard for any /platform/sites/:id route: a platform_admin may only act on a site
  // in ITS OWN platform (system owner is unrestricted). Reads the site's platform and refuses a
  // cross-platform target with 403 PLATFORM_SCOPE_FORBIDDEN. The platform-aware DB RPCs are the deeper
  // guard; this stops a platform_admin at the door of the per-site drill-downs (users/audit/etc.).
  const scopeSiteParam: Middleware = async (ctx: Ctx) => {
    if (adminScopePlatform(ctx) === null) return;             // system: unrestricted
    const siteId = ctx.params.id;
    if (!siteId) return;
    assertTargetPlatformInScope(ctx, await deps.platform.platformOfSite(siteId));
  };

  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
  const DEFAULT_PLATFORM_ID = "10000000-0000-0000-0000-000000000001";

  // Instant client onboarding: create/upsert the brand + economy and optionally provision its
  // domain (Cloudflare zone + DNS + Pages custom domain, Namecheap nameservers) in one call.
  router.post(`${BASE}/platform/onboard`, auth, platformAdmin, async (ctx: Ctx) => {
    if (!deps.platformOnboard) throw new ApiError("NOT_CONFIGURED", "onboarding is not configured on this deployment", 503);
    const b = asObject(ctx.body);
    if (typeof b.slug !== "string" || !SLUG_RE.test(b.slug)) throw new ApiError("VALIDATION", "slug must be lowercase letters, digits and hyphens", 400);
    if (typeof b.name !== "string" || !b.name.trim()) throw new ApiError("VALIDATION", "name is required", 400);
    const str = (k: string): string | undefined => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim() : undefined);
    const colors = (b.colors && typeof b.colors === "object" && !Array.isArray(b.colors)) ? b.colors as OnboardColors : undefined;
    const game = (b.game && typeof b.game === "object" && !Array.isArray(b.game)) ? b.game as OnboardGame : undefined;
    const primaryDomain = str("primaryDomain"), currency = str("currency"), locale = str("locale"), theme = str("theme");
    const wordmarkText = str("wordmarkText"), licenceLine = str("licenceLine"), supportEmail = str("supportEmail");
    const input: OnboardInput = {
      slug: b.slug, name: b.name.trim(),
      ...(primaryDomain ? { primaryDomain } : {}),
      ...(currency ? { currency } : {}),
      ...(locale ? { locale } : {}),
      ...(theme ? { theme } : {}),
      ...(wordmarkText ? { wordmarkText } : {}),
      ...(licenceLine ? { licenceLine } : {}),
      ...(supportEmail ? { supportEmail } : {}),
      ...(colors ? { colors } : {}),
      ...(game ? { game } : {}),
      provisionDomain: b.provisionDomain === true,
    };
    // A platform admin's new client is stamped into ITS platform (body ignored — secure); the system
    // owner may target a specific platform via body.platformId (else the default platform).
    const scoped = adminScopePlatform(ctx);
    const targetPlatform = scoped ?? (typeof b.platformId === "string" && b.platformId.trim() ? b.platformId.trim() : null);
    // F-47: `scoped` bounds re-onboarding of an EXISTING slug to the caller's own platform.
    const res = await domain(() => deps.platformOnboard!.onboard(input, targetPlatform, scoped));
    return { status: 201, body: res };
  });

  // Poll a domain's provisioning status (zone active + Pages custom domains validated).
  router.get(`${BASE}/platform/onboard/domain-status`, auth, platformAdmin, async (ctx: Ctx) => {
    if (!deps.platformOnboard) throw new ApiError("NOT_CONFIGURED", "onboarding is not configured on this deployment", 503);
    const d = ctx.query.get("domain");
    if (!d || !d.trim()) throw new ApiError("VALIDATION", "domain is required", 400);
    return domain(() => deps.platformOnboard!.domainStatus(d.trim(), adminScopePlatform(ctx)));   // F-47: own platform's domains only
  });

  // Onboarding capabilities so the console can be HONEST up-front about what will happen — per platform
  // (a platform admin may have configured its OWN registrar even when the global env has none).
  router.get(`${BASE}/platform/onboard/capabilities`, auth, platformAdmin, async (ctx: Ctx) => {
    if (!deps.platformOnboard) return { domainConfigured: false, registrarConfigured: false };
    return domain(() => deps.platformOnboard!.capabilities(adminScopePlatform(ctx)));
  });

  // Import: list the registrar (Namecheap) account's domains for the caller's platform, annotated with
  // which are already clients, so the console can offer bulk onboarding of the not-yet-used domains.
  router.get(`${BASE}/platform/domains/registrar`, auth, platformAdmin, async (ctx: Ctx) => {
    if (!deps.platformOnboard) throw new ApiError("NOT_CONFIGURED", "onboarding is not configured on this deployment", 503);
    return domain(() => deps.platformOnboard!.listRegistrarDomains(adminScopePlatform(ctx)));
  });

  // Real per-domain health (Cloudflare Pages custom-domain status), so the Clients table shows the TRUE
  // state (Live / Pending / Not provisioned) instead of a fake "✓ Domain" just because a string is set.
  router.get(`${BASE}/platform/domains/health`, auth, platformAdmin, async (ctx: Ctx) => {
    if (!deps.platformOnboard) return { configured: false, statuses: {} };
    // F-47: was every platform's domains (the system Cloudflare account) — now the caller's own only.
    return domain(() => deps.platformOnboard!.domainHealth(adminScopePlatform(ctx)));
  });

  // ── Per-platform registrar (Namecheap) configuration (Issue 1 #3) ──────────────────────────────
  // A platform admin manages ITS OWN registrar credentials (scoped in the RPC); the system owner may
  // target a specific platform via ?platform=<id> (defaults to the default platform). The GET also
  // returns the egress IP to whitelist in Namecheap and whether server-side encryption is configured.
  const registrarPlatformId = (ctx: Ctx): string =>
    adminScopePlatform(ctx) ?? ((ctx.query.get("platform")?.trim()) || DEFAULT_PLATFORM_ID);
  const draftFrom = (b: Record<string, unknown>): { apiUser?: string; userName?: string; clientIp?: string; apiKey?: string } => {
    const d: { apiUser?: string; userName?: string; clientIp?: string; apiKey?: string } = {};
    if (typeof b.apiUser === "string") d.apiUser = b.apiUser;
    if (typeof b.userName === "string") d.userName = b.userName;
    if (typeof b.clientIp === "string") d.clientIp = b.clientIp;
    if (typeof b.apiKey === "string") d.apiKey = b.apiKey;
    return d;
  };

  router.get(`${BASE}/platform/registrar/config`, auth, platformAdmin, async (ctx: Ctx) => {
    if (!deps.registrarConfig) throw new ApiError("NOT_CONFIGURED", "registrar configuration is not available on this deployment", 503);
    return domain(() => deps.registrarConfig!.get(ctx.claims!.userId, ctx.claims!.role ?? "player", registrarPlatformId(ctx)));
  });

  router.put(`${BASE}/platform/registrar/config`, auth, platformAdmin, async (ctx: Ctx) => {
    if (!deps.registrarConfig) throw new ApiError("NOT_CONFIGURED", "registrar configuration is not available on this deployment", 503);
    return domain(() => deps.registrarConfig!.set(ctx.claims!.userId, ctx.claims!.role ?? "player", registrarPlatformId(ctx), draftFrom(asObject(ctx.body))));
  });

  router.post(`${BASE}/platform/registrar/config/test`, auth, platformAdmin, async (ctx: Ctx) => {
    if (!deps.registrarConfig) throw new ApiError("NOT_CONFIGURED", "registrar configuration is not available on this deployment", 503);
    return domain(() => deps.registrarConfig!.test(ctx.claims!.userId, ctx.claims!.role ?? "player", registrarPlatformId(ctx), draftFrom(asObject(ctx.body))));
  });

  // ── Platform tier governance (Issue 1) — SYSTEM owner only (platform_superadmin). ──────────────
  // Manage platforms (the grouping above sites) and appoint/revoke the platform admins that run them.
  router.get(`${BASE}/platform/platforms`, auth, platform, async () =>
    ({ platforms: await domain(() => deps.platform.listPlatforms()) }));

  router.get(`${BASE}/platform/platforms/overview`, auth, platform, async (ctx: Ctx) =>
    ({ platforms: await domain(() => deps.platform.platformsOverview(ctx.claims!.role ?? "player")) }));

  router.post(`${BASE}/platform/platforms`, auth, platform, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    if (typeof b.slug !== "string" || !SLUG_RE.test(b.slug)) throw new ApiError("VALIDATION", "slug must be lowercase letters, digits and hyphens", 400);
    if (typeof b.name !== "string" || !b.name.trim()) throw new ApiError("VALIDATION", "name is required", 400);
    const owner = typeof b.ownerUserId === "string" && b.ownerUserId.trim() ? b.ownerUserId.trim() : null;
    const id = await domain(() => deps.platform.createPlatform(ctx.claims!.userId, ctx.claims!.role ?? "player", b.slug as string, (b.name as string).trim(), owner));
    return { status: 201, body: { platformId: id } };
  });

  router.patch(`${BASE}/platform/platforms/:id`, auth, platform, async (ctx: Ctx) => {
    const patch = asObject(ctx.body) as Record<string, unknown>;
    return domain(() => deps.platform.updatePlatform(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, patch));
  });

  // Re-parent a brand into a platform.
  router.post(`${BASE}/platform/sites/:id/assign`, auth, platform, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    if (typeof b.platformId !== "string" || !b.platformId) throw new ApiError("VALIDATION", "platformId is required", 400);
    return domain(() => deps.platform.assignSiteToPlatform(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, b.platformId as string));
  });

  // Appoint a user as platform_admin of a platform.
  router.post(`${BASE}/platform/platform-admins`, auth, platform, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    if (typeof b.userId !== "string" || !b.userId) throw new ApiError("VALIDATION", "userId is required", 400);
    if (typeof b.platformId !== "string" || !b.platformId) throw new ApiError("VALIDATION", "platformId is required", 400);
    return { status: 201, body: await domain(() => deps.platform.appointPlatformAdmin(ctx.claims!.userId, ctx.claims!.role ?? "player", b.userId as string, b.platformId as string)) };
  });

  // Revoke a platform_admin back to a site-level role (default 'admin').
  router.post(`${BASE}/platform/platform-admins/:uid/revoke`, auth, platform, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const newRole = typeof b.newRole === "string" && b.newRole ? b.newRole : "admin";
    return domain(() => deps.platform.revokePlatformAdmin(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.uid!, newRole));
  });

  // Per-brand KPIs — platform-scoped: a platform_admin sees only ITS platform's sites (the 2-arg
  // RPC resolves the actor's platform); the system owner sees every brand.
  router.get(`${BASE}/platform/overview`, auth, platformAdmin, async (ctx: Ctx) =>
    ({ sites: await domain(() => deps.platform.overview(ctx.claims!.userId, ctx.claims!.role ?? "player")) }));

  // Per-brand performance within a [from, to) window (docs/24 performance filters). `from`/`to` are
  // epoch-ms (or ISO); defaults to the last 24h when omitted. Read-only. docs/42 UI-5: platform admins
  // too, scoped to THEIR platform's brands (adminScopePlatform: owner -> null = all; claimless -> 403).
  router.get(`${BASE}/platform/performance`, auth, platformAdmin, async (ctx: Ctx) => {
    const scope = adminScopePlatform(ctx);
    const parse = (raw: string | null): number | null => {
      if (!raw || !raw.trim()) return null;
      const n = Number(raw);
      const ms = Number.isFinite(n) ? n : Date.parse(raw);
      return Number.isFinite(ms) ? ms : null;
    };
    const now = Date.now();
    const toMs = parse(ctx.query.get("to")) ?? now;
    const fromMs = parse(ctx.query.get("from")) ?? toMs - 24 * 60 * 60 * 1000;
    if (toMs <= fromMs) throw new ApiError("VALIDATION", "`to` must be after `from`", 400);
    return { fromMs, toMs, sites: await domain(() => deps.platform.performance(fromMs, toMs, scope)) };
  });

  // Brands + economy — platform-scoped: a platform_admin sees only ITS platform's brands.
  router.get(`${BASE}/platform/sites`, auth, platformAdmin, async (ctx: Ctx) =>
    ({ sites: await deps.platform.listSites(adminScopePlatform(ctx)) }));

  // Impersonation (docs/24 §370): an operator "logs into" a client brand's admin console, fenced to
  // that ONE brand. The SUBJECT stays the operator (every admin_actions row audits the real actor);
  // the `site` claim is the TARGET brand, so requireSite + adminScopeSite fence every read/write to it.
  //
  // The minted ROLE matches the operator's TIER — this fixes the leak where a platform_admin was
  // offered (and, if the gate were widened, granted) a 'superadmin' session:
  //   - platform_superadmin (system owner) -> 'admin' as well since F1/Option B (governance lives in the console);
  //   - platform_admin                     -> 'admin'      (site Operations only, fenced to the brand —
  //                                                         NEVER superadmin governance, so a platform
  //                                                         admin can never escalate on a client).
  // Gated to platform_admin+ (admin/superadmin are refused by the rank gate); `scopeSiteParam` refuses
  // any site outside a platform_admin's own platform (403 PLATFORM_SCOPE_FORBIDDEN). Audited either way.
  router.post(`${BASE}/platform/sites/:id/impersonate`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    const siteId = ctx.params.id!;
    const brand = (await deps.platform.listSites(adminScopePlatform(ctx))).find((s) => s.siteId === siteId);
    if (!brand) throw new ApiError("SITE_NOT_FOUND", "brand not found", 404);
    // Issue 1 / F1 (Option B): impersonation ALWAYS mints a day-to-day `admin` + `site` token — for
    // BOTH the system owner and a platform admin. Owner-tier brand config no longer lives in the site
    // back-office; it is reached from the platform/system console (docs/38). This removes the legacy
    // site-fenced `superadmin` token entirely. The site claim scopes the impersonated session to the
    // one brand; the action is audited with the caller's REAL role below.
    const impersonatedRole = "admin";
    // docs/42 UI-3: the token itself records the impersonation (RFC 8693-style `act` claim).
    const token = await deps.auth.issueToken(ctx.claims!.userId, impersonatedRole, siteId, undefined,
      { sub: ctx.claims!.userId, role: ctx.claims!.role ?? "player", brand: brand.name });
    await deps.admin.recordAction(
      ctx.claims!.userId, ctx.claims!.role ?? "player",
      "platform.impersonate", "site", siteId, { slug: brand.slug, name: brand.name, as: impersonatedRole },
    );
    return {
      token, role: impersonatedRole, site: siteId,
      brand: { siteId: brand.siteId, slug: brand.slug, name: brand.name, primaryDomain: brand.primaryDomain },
    };
  });

  // Create a brand — a platform_admin's new brand is stamped into ITS platform (enforced by the RPC).
  router.post(`${BASE}/platform/sites`, auth, platformAdmin, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const slug = body.slug, name = body.name;
    if (typeof slug !== "string" || typeof name !== "string") throw new ApiError("VALIDATION", "slug and name are required", 400);
    const input = {
      slug, name,
      currency: typeof body.currency === "string" ? body.currency : undefined,
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : undefined,
    };
    const siteId = await domain(() => deps.platform.createSite(ctx.claims!.userId, ctx.claims!.role ?? "player", input));
    return { status: 201, body: { siteId } };
  });

  router.patch(`${BASE}/platform/sites/:id`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    const patch = asObject(ctx.body);
    // The price chart + trade interface are SYSTEM-admin-assigned add-ons (Issue 2): a platform admin
    // may not set them via a site patch — it requests them (addon flow) and the system admin grants.
    if ((ctx.claims?.role ?? "") !== "platform_superadmin" && ("chart_style" in patch || "trade_ui" in patch))
      throw new ApiError("ADDON_SYSTEM_ADMIN_ONLY", "price chart and trade interface are assigned by the system admin — request the change instead", 403);
    return domain(() => deps.platform.updateSite(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, patch));
  });

  router.patch(`${BASE}/platform/sites/:id/config`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    const patch = asObject(ctx.body);
    return domain(() => deps.platform.setSiteConfig(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, patch));
  });

  // Assign / change the brand's marketer (site-owner commission model). ownerUserId null clears it.
  router.patch(`${BASE}/platform/sites/:id/owner`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const owner = body.ownerUserId === null ? null : (typeof body.ownerUserId === "string" ? body.ownerUserId : undefined);
    if (owner === undefined) throw new ApiError("VALIDATION", "ownerUserId (string or null) is required", 400);
    return domain(() => deps.platform.setSiteOwner(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, owner));
  });

  // Persist a brand's full design-token palette (from the console's seed-hue → derived palette).
  // A platform admin may theme brands in ITS OWN platform (scopeSiteParam + fn_platform_site_in_scope);
  // brand OWNERSHIP above stays system-only.
  router.patch(`${BASE}/platform/sites/:id/theme`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const tokens = body.tokens ?? body;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new ApiError("VALIDATION", "tokens object is required", 400);
    return domain(() => deps.platform.setSiteTheme(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, tokens as Record<string, unknown>));
  });

  // ── Global configuration console (migration 0092): master switches + global pool distribution ──
  // The platform owner's single control plane over EVERY brand. platform_superadmin-gated + audited.
  router.get(`${BASE}/platform/global-config`, auth, platform, async () =>
    ({ config: await domain(() => deps.platform.getGlobalConfig()) }));

  router.patch(`${BASE}/platform/global-config`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    // Whitelist the master switches + banner; ignore anything else. Booleans validated per key.
    const patch: Record<string, unknown> = {};
    for (const k of ["deposits_enabled", "withdrawals_enabled", "play_enabled", "marketers_enabled", "registrations_enabled"]) {
      if (k in body) { if (typeof body[k] !== "boolean") throw new ApiError("VALIDATION", `${k} must be boolean`, 400); patch[k] = body[k]; }
    }
    if ("maintenance_message" in body) {
      const m = body.maintenance_message;
      if (m !== null && typeof m !== "string") throw new ApiError("VALIDATION", "maintenance_message must be string or null", 400);
      patch.maintenance_message = m;
    }
    // Economy blocks (migration 0099): structural validation here (known keys + {v:number,on:boolean}
    // shape); authoritative BOUNDS + cross-field feasibility are enforced by the DB RPC / engine.
    const validateEconomyBlock = (raw: unknown, allowed: readonly string[], label: string): Record<string, { v: number; on: boolean }> => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("VALIDATION", `${label} must be an object`, 400);
      const out: Record<string, { v: number; on: boolean }> = {};
      for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
        if (!allowed.includes(k)) throw new ApiError("VALIDATION", `unknown ${label} field: ${k}`, 400);
        if (val === null || typeof val !== "object" || Array.isArray(val)) throw new ApiError("VALIDATION", `${label}.${k} must be {v,on}`, 400);
        const f = val as Record<string, unknown>;
        if (typeof f.v !== "number" || !Number.isFinite(f.v)) throw new ApiError("VALIDATION", `${label}.${k}.v must be a finite number`, 400);
        if (typeof f.on !== "boolean") throw new ApiError("VALIDATION", `${label}.${k}.on must be boolean`, 400);
        out[k] = { v: f.v, on: f.on };
      }
      return out;
    };
    if ("player_economy" in body) patch.player_economy = validateEconomyBlock(body.player_economy, COHORT_KEYS, "player_economy");
    if ("marketer_economy" in body) patch.marketer_economy = validateEconomyBlock(body.marketer_economy, COHORT_KEYS, "marketer_economy");
    if ("payments" in body) patch.payments = validateEconomyBlock(body.payments, PAYMENT_KEYS, "payments");
    if (Object.keys(patch).length === 0) throw new ApiError("VALIDATION", "no recognised fields to update", 400);
    return { config: await domain(() => deps.platform.setGlobalConfig(ctx.claims!.userId, ctx.claims!.role ?? "player", patch)) };
  });

  // ── Payment-gateway provider switches (migration 0116) ──
  // The superadmin's control over WHICH deposit gateways players see: a platform-global on/off per
  // provider, plus an optional per-brand override. platform_superadmin-gated + audited in the RPCs.
  router.get(`${BASE}/platform/payment-providers`, auth, platform, async (ctx: Ctx) =>
    domain(() => deps.platform.listPaymentProviders(ctx.claims!.role ?? "player")));

  router.post(`${BASE}/platform/payment-providers/:code/global`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    if (typeof body.enabled !== "boolean") throw new ApiError("VALIDATION", "enabled must be boolean", 400);
    await domain(() => deps.platform.setProviderGlobal(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.code!, body.enabled as boolean));
    return domain(() => deps.platform.listPaymentProviders(ctx.claims!.role ?? "player"));
  });

  router.post(`${BASE}/platform/payment-providers/:code/site`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const siteId = typeof body.siteId === "string" ? body.siteId.trim() : "";
    if (!siteId) throw new ApiError("VALIDATION", "siteId is required", 400);
    // enabled:boolean sets the override; enabled:null clears it (revert to the global default).
    const enabled = body.enabled;
    if (enabled === null) {
      await domain(() => deps.platform.clearProviderSite(ctx.claims!.userId, ctx.claims!.role ?? "player", siteId, ctx.params.code!));
    } else if (typeof enabled === "boolean") {
      await domain(() => deps.platform.setProviderSite(ctx.claims!.userId, ctx.claims!.role ?? "player", siteId, ctx.params.code!, enabled));
    } else {
      throw new ApiError("VALIDATION", "enabled must be boolean or null", 400);
    }
    return domain(() => deps.platform.listPaymentProviders(ctx.claims!.role ?? "player"));
  });

  // ── Gateway CONFIGURATION (migration 0130): credentials + settings, secrets encrypted at rest ──
  // GET the field schema + current MASKED config for every configurable gateway in one call.
  router.get(`${BASE}/platform/payment-providers/config`, auth, platform, async (ctx: Ctx) => {
    const role = ctx.claims!.role ?? "player";
    const schemas = deps.platform.gatewaySchemas();
    const codes = Object.keys(schemas);
    const providers = await domain(() => Promise.all(codes.map(async (code) => ({
      code, schema: schemas[code], config: await deps.platform.getProviderConfig(role, code, null),
    }))));
    return { providers };
  });

  // PUT saves one gateway's config (flat {field: value}). Secrets are encrypted; blanks leave them as-is.
  router.put(`${BASE}/platform/payment-providers/:code/config`, auth, platform, async (ctx: Ctx) => {
    const values = asObject(ctx.body);
    const code = ctx.params.code!;
    return domain(async () => {
      try {
        const config = await deps.platform.setProviderConfig(ctx.claims!.userId, ctx.claims!.role ?? "player", code, null, values);
        return { config };
      } catch (e) {
        const issues = (e as { issues?: { field: string; message: string }[] }).issues;
        if (Array.isArray(issues)) throw new ApiError("VALIDATION", issues.map((i) => `${i.field}: ${i.message}`).join("; "), 400);
        throw e;
      }
    });
  });

  // POST runs a SAFE, read-only connectivity test using stored config overlaid with any draft values.
  router.post(`${BASE}/platform/payment-providers/:code/config/test`, auth, platform, async (ctx: Ctx) => {
    const values = ctx.body ? asObject(ctx.body) : {};
    const code = ctx.params.code!;
    return domain(async () => ({ result: await deps.platform.testProviderConnection(ctx.claims!.role ?? "player", code, null, values) }));
  });

  // Distribute a global withdrawal-pool total across every active brand's daily cap.
  //   { totalCents, mode: 'equal' } | { mode: 'per_site', overrides: { <siteId>: cents } }
  router.post(`${BASE}/platform/pool/distribute`, auth, platformAdmin, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const mode = body.mode === "per_site" ? "per_site" : "equal";
    let totalCents: number | null = null;
    let overrides: Record<string, number> | null = null;
    if (mode === "equal") {
      const n = Number(body.totalCents);
      if (!Number.isInteger(n) || n < 0) throw new ApiError("VALIDATION", "totalCents must be a non-negative integer", 400);
      totalCents = n;
    } else {
      const o = asObject(body.overrides);
      overrides = {};
      for (const [k, v] of Object.entries(o)) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw new ApiError("VALIDATION", `override for ${k} must be a non-negative integer`, 400);
        overrides[k] = n;
      }
      if (Object.keys(overrides).length === 0) throw new ApiError("VALIDATION", "per_site mode requires a non-empty overrides map", 400);
    }
    return { result: await domain(() => deps.platform.distributePool(ctx.claims!.userId, ctx.claims!.role ?? "player", totalCents, mode, overrides, adminScopePlatform(ctx))) };
  });

  router.get(`${BASE}/platform/pool/distributions`, auth, platformAdmin, async (ctx: Ctx) => {
    const limit = Math.min(Math.max(Number(ctx.query.get("limit")) || 20, 1), 100);
    return { distributions: await domain(() => deps.platform.listPoolDistributions(limit, adminScopePlatform(ctx))) };
  });

  // ── Dynamic (demand-based) pool distribution (docs/25 §15) ──
  // Preview: forecasts each active pool-mode brand's demand and returns the suggested allocation. No apply.
  router.get(`${BASE}/platform/pool/demand`, auth, platformAdmin, async (ctx: Ctx) => {
    const opts = parsePoolDemandQuery(ctx);
    return { preview: await domain(() => deps.platform.poolDemand(opts, adminScopePlatform(ctx))) };
  });
  // Apply: computes the demand-based allocation and applies it via the audited per-site distributor.
  router.post(`${BASE}/platform/pool/distribute-dynamic`, auth, platformAdmin, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const opts = {
      lookbackDays: body.lookbackDays != null ? Number(body.lookbackDays) : undefined,
      totalCents: body.totalCents != null ? Number(body.totalCents) : undefined,
      alpha: body.alpha != null ? Number(body.alpha) : undefined,
      floorFrac: body.floorFrac != null ? Number(body.floorFrac) : undefined,
      capMult: body.capMult != null ? Number(body.capMult) : undefined,
    };
    if (opts.totalCents != null && (!Number.isFinite(opts.totalCents) || opts.totalCents < 0))
      throw new ApiError("VALIDATION", "totalCents must be a non-negative number", 400);
    return { result: await domain(() => deps.platform.distributePoolDynamic(ctx.claims!.userId, ctx.claims!.role ?? "player", opts, adminScopePlatform(ctx))) };
  });

  // ── Task R: cross-brand marketer rollup (reporting only; money stays per site) ──
  // The one view: per marketer -> which clients on which site + the cross-brand total.
  router.get(`${BASE}/platform/marketers/rollup`, auth, platform, async (ctx: Ctx) => {
    const rows = await domain(() => deps.platform.marketerRollup(ctx.claims!.role ?? "player"));
    return { marketers: groupMarketerRollup(rows), rows };
  });

  // Create a global marketer identity (a real person spanning brands).
  router.post(`${BASE}/platform/marketers`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    if (typeof body.label !== "string") throw new ApiError("VALIDATION", "label is required", 400);
    const marketerGlobalId = await domain(() => deps.platform.createMarketerGlobal(ctx.claims!.userId, ctx.claims!.role ?? "player", body.label as string));
    return { status: 201, body: { marketerGlobalId } };
  });

  // Link (or unlink with null) one brand's affiliate row to a global marketer identity.
  router.patch(`${BASE}/platform/affiliates/:userId/marketer`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const raw = body.marketerGlobalId;
    if (raw !== null && typeof raw !== "string") throw new ApiError("VALIDATION", "marketerGlobalId must be a string or null", 400);
    await domain(() => deps.platform.linkMarketer(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.userId!, raw ?? null));
    return { ok: true, affiliateUserId: ctx.params.userId, marketerGlobalId: raw ?? null };
  });

  // ── Phase 2 (docs/24): per-brand PLAYER management + AUDIT, cross-brand via an explicit :id ──
  // The platform_superadmin actor is unrestricted; the DB RPCs enforce owner-protection + validation
  // (0058/0059). Reuse the existing site-scoped admin domain methods with the TARGET site/user.
  const pageQ = (ctx: Ctx) => {
    const n = Number(ctx.query.get("limit"));
    return { limit: Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 200) : undefined, cursor: ctx.query.get("cursor") ?? undefined };
  };
  const actorOf = (ctx: Ctx) => [ctx.claims!.userId, ctx.claims!.role ?? "player"] as const;

  // Players in a brand (reuses the site-scoped admin list with an explicit target site).
  router.get(`${BASE}/platform/sites/:id/users`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    const num = (k: string) => { const r = ctx.query.get(k); const n = r == null || r === "" ? NaN : Number(r); return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined; };
    return deps.admin.listUsers({
      ...pageQ(ctx),
      role: ctx.query.get("role") ?? undefined,
      status: ctx.query.get("status") ?? undefined,
      q: ctx.query.get("q") ?? undefined,
      minBalanceCents: num("minBalanceCents"), maxBalanceCents: num("maxBalanceCents"),
      minDepositsCents: num("minDepositsCents"), minWithdrawalsCents: num("minWithdrawalsCents"),
      minTurnoverCents: num("minTurnoverCents"), minBets: num("minBets"),
      siteId: ctx.params.id,
    });
  });

  router.get(`${BASE}/platform/sites/:id/users/:uid`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    // The user must belong to a site in the caller's platform (uid is not covered by scopeSiteParam,
    // which only validates the :id site) — resolve the user's brand and platform-check it.
    assertTargetPlatformInScope(ctx, await deps.platform.platformOfSite((await deps.admin.siteOfUser(ctx.params.uid!)) ?? ""));
    return domain(() => deps.admin.getUserDetail(ctx.params.uid!));
  });

  // Per-brand audit trail (admin_actions filtered by site).
  router.get(`${BASE}/platform/sites/:id/audit`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) =>
    deps.admin.listAudit(pageQ(ctx), ctx.params.id));

  router.post(`${BASE}/platform/sites/:id/users/:uid/status`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    assertTargetPlatformInScope(ctx, await deps.platform.platformOfSite((await deps.admin.siteOfUser(ctx.params.uid!)) ?? ""));
    const b = asObject(ctx.body);
    const status = String(b.status ?? "");
    if (!["active", "suspended", "banned"].includes(status)) throw new ApiError("VALIDATION", "status must be active|suspended|banned", 400);
    const [a, r] = actorOf(ctx);
    return domain(() => deps.admin.setUserStatus(a, r, ctx.params.uid!, status, typeof b.reason === "string" ? b.reason : ""));
  });

  router.post(`${BASE}/platform/sites/:id/users/:uid/role`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const role = String(b.role ?? "");
    if (!["player", "marketer", "admin"].includes(role)) throw new ApiError("VALIDATION", "role must be player|marketer|admin", 400);
    assertTargetPlatformInScope(ctx, await deps.platform.platformOfSite((await deps.admin.siteOfUser(ctx.params.uid!)) ?? ""));
    const [a, r] = actorOf(ctx);
    return domain(() => deps.admin.setUserRole(a, r, ctx.params.uid!, role));
  });

  router.post(`${BASE}/platform/sites/:id/users/:uid/balance`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const amount = Number(b.amountCents);
    if (!Number.isFinite(amount) || amount === 0) throw new ApiError("VALIDATION", "amountCents must be a non-zero integer", 400);
    const reason = typeof b.reason === "string" ? b.reason : "";
    const kind = b.kind === "bonus" ? "bonus" : b.kind === "real" ? "real" : undefined;
    assertTargetPlatformInScope(ctx, await deps.platform.platformOfSite((await deps.admin.siteOfUser(ctx.params.uid!)) ?? ""));
    const [a, r] = actorOf(ctx);
    if (kind) return domain(() => deps.admin.adjustBalanceKind(a, r, ctx.params.uid!, Math.round(amount), kind, reason));
    return domain(() => deps.admin.adjustBalance(a, r, ctx.params.uid!, Math.round(amount), reason));
  });

  router.patch(`${BASE}/platform/sites/:id/users/:uid/overrides`, auth, platformAdmin, scopeSiteParam, async (ctx: Ctx) => {
    const patch = asObject(ctx.body);
    assertTargetPlatformInScope(ctx, await deps.platform.platformOfSite((await deps.admin.siteOfUser(ctx.params.uid!)) ?? ""));
    const [a, r] = actorOf(ctx);
    return domain(() => deps.admin.setUserOverrides(a, r, ctx.params.uid!, patch));
  });
}
