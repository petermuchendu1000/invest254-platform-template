import { Router, ApiError, requireAuth, requireRole, type Ctx } from "./http.js";
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
export interface PlatformOnboardDeps {
  /** True when the Cloudflare + Namecheap secrets are present so a domain can be auto-provisioned. */
  domainConfigured: boolean;
  onboard(input: OnboardInput): Promise<OnboardResult>;
  domainStatus(domain: string): Promise<DomainStatus>;
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
  const platform = requireRole("platform_superadmin");

  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

  // Instant client onboarding: create/upsert the brand + economy and optionally provision its
  // domain (Cloudflare zone + DNS + Pages custom domain, Namecheap nameservers) in one call.
  router.post(`${BASE}/platform/onboard`, auth, platform, async (ctx: Ctx) => {
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
    const res = await domain(() => deps.platformOnboard!.onboard(input));
    return { status: 201, body: res };
  });

  // Poll a domain's provisioning status (zone active + Pages custom domains validated).
  router.get(`${BASE}/platform/onboard/domain-status`, auth, platform, async (ctx: Ctx) => {
    if (!deps.platformOnboard) throw new ApiError("NOT_CONFIGURED", "onboarding is not configured on this deployment", 503);
    const d = ctx.query.get("domain");
    if (!d || !d.trim()) throw new ApiError("VALIDATION", "domain is required", 400);
    return domain(() => deps.platformOnboard!.domainStatus(d.trim()));
  });

  router.get(`${BASE}/platform/overview`, auth, platform, async (ctx: Ctx) =>
    ({ sites: await domain(() => deps.platform.overview(ctx.claims!.role ?? "player")) }));

  // Per-brand performance within a [from, to) window (docs/24 performance filters). `from`/`to` are
  // epoch-ms (or ISO); defaults to the last 24h when omitted. Read-only; platform_superadmin-gated.
  router.get(`${BASE}/platform/performance`, auth, platform, async (ctx: Ctx) => {
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
    return { fromMs, toMs, sites: await domain(() => deps.platform.performance(fromMs, toMs)) };
  });

  router.get(`${BASE}/platform/sites`, auth, platform, async () =>
    ({ sites: await deps.platform.listSites() }));

  // Impersonation (docs/24 §370): the platform owner "logs into" any client's admin console AS its
  // superadmin — no signup, no per-brand credential. We mint a superadmin JWT whose SUBJECT stays the
  // platform admin (so every admin_actions row is audited to the real actor) but whose `role` is
  // 'superadmin' and `site` claim is the TARGET brand — so requireSite + adminScopeSite scope every
  // read and write to that brand only (a superadmin, rank 4, is site-restricted; the platform owner,
  // rank 5, is not — minting 'superadmin' deliberately fences the session to one brand). The action
  // itself is platform_superadmin-gated and audited.
  router.post(`${BASE}/platform/sites/:id/impersonate`, auth, platform, async (ctx: Ctx) => {
    const siteId = ctx.params.id!;
    const brand = (await deps.platform.listSites()).find((s) => s.siteId === siteId);
    if (!brand) throw new ApiError("SITE_NOT_FOUND", "brand not found", 404);
    const token = await deps.auth.issueToken(ctx.claims!.userId, "superadmin", siteId);
    await deps.admin.recordAction(
      ctx.claims!.userId, ctx.claims!.role ?? "player",
      "platform.impersonate", "site", siteId, { slug: brand.slug, name: brand.name },
    );
    return {
      token, role: "superadmin", site: siteId,
      brand: { siteId: brand.siteId, slug: brand.slug, name: brand.name, primaryDomain: brand.primaryDomain },
    };
  });

  router.post(`${BASE}/platform/sites`, auth, platform, async (ctx: Ctx) => {
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

  router.patch(`${BASE}/platform/sites/:id`, auth, platform, async (ctx: Ctx) => {
    const patch = asObject(ctx.body);
    return domain(() => deps.platform.updateSite(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, patch));
  });

  router.patch(`${BASE}/platform/sites/:id/config`, auth, platform, async (ctx: Ctx) => {
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
  router.patch(`${BASE}/platform/sites/:id/theme`, auth, platform, async (ctx: Ctx) => {
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

  // Distribute a global withdrawal-pool total across every active brand's daily cap.
  //   { totalCents, mode: 'equal' } | { mode: 'per_site', overrides: { <siteId>: cents } }
  router.post(`${BASE}/platform/pool/distribute`, auth, platform, async (ctx: Ctx) => {
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
    return { result: await domain(() => deps.platform.distributePool(ctx.claims!.userId, ctx.claims!.role ?? "player", totalCents, mode, overrides)) };
  });

  router.get(`${BASE}/platform/pool/distributions`, auth, platform, async (ctx: Ctx) => {
    const limit = Math.min(Math.max(Number(ctx.query.get("limit")) || 20, 1), 100);
    return { distributions: await domain(() => deps.platform.listPoolDistributions(limit)) };
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
  router.get(`${BASE}/platform/sites/:id/users`, auth, platform, async (ctx: Ctx) => {
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

  router.get(`${BASE}/platform/sites/:id/users/:uid`, auth, platform, async (ctx: Ctx) =>
    domain(() => deps.admin.getUserDetail(ctx.params.uid!)));

  // Per-brand audit trail (admin_actions filtered by site).
  router.get(`${BASE}/platform/sites/:id/audit`, auth, platform, async (ctx: Ctx) =>
    deps.admin.listAudit(pageQ(ctx), ctx.params.id));

  router.post(`${BASE}/platform/sites/:id/users/:uid/status`, auth, platform, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const status = String(b.status ?? "");
    if (!["active", "suspended", "banned"].includes(status)) throw new ApiError("VALIDATION", "status must be active|suspended|banned", 400);
    const [a, r] = actorOf(ctx);
    return domain(() => deps.admin.setUserStatus(a, r, ctx.params.uid!, status, typeof b.reason === "string" ? b.reason : ""));
  });

  router.post(`${BASE}/platform/sites/:id/users/:uid/role`, auth, platform, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const role = String(b.role ?? "");
    if (!["player", "marketer", "admin"].includes(role)) throw new ApiError("VALIDATION", "role must be player|marketer|admin", 400);
    const [a, r] = actorOf(ctx);
    return domain(() => deps.admin.setUserRole(a, r, ctx.params.uid!, role));
  });

  router.post(`${BASE}/platform/sites/:id/users/:uid/balance`, auth, platform, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const amount = Number(b.amountCents);
    if (!Number.isFinite(amount) || amount === 0) throw new ApiError("VALIDATION", "amountCents must be a non-zero integer", 400);
    const reason = typeof b.reason === "string" ? b.reason : "";
    const kind = b.kind === "bonus" ? "bonus" : b.kind === "real" ? "real" : undefined;
    const [a, r] = actorOf(ctx);
    if (kind) return domain(() => deps.admin.adjustBalanceKind(a, r, ctx.params.uid!, Math.round(amount), kind, reason));
    return domain(() => deps.admin.adjustBalance(a, r, ctx.params.uid!, Math.round(amount), reason));
  });

  router.patch(`${BASE}/platform/sites/:id/users/:uid/overrides`, auth, platform, async (ctx: Ctx) => {
    const patch = asObject(ctx.body);
    const [a, r] = actorOf(ctx);
    return domain(() => deps.admin.setUserOverrides(a, r, ctx.params.uid!, patch));
  });
}
