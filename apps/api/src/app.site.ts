import { PLATFORM_ALL_ON, resolveDisplayCurrency } from "@invest254/shared";
import { Router, ApiError, requireAuth, requireSite, type Ctx } from "./http.js";
import { kesToCurrencyRate } from "./fx.js";
import type { ApiDeps } from "./app.js";

const BASE = "/api/v1";

/**
 * Site (brand) routes — docs/22 Task E.
 *
 *  - `GET /site/brand?host=<host|slug>` (public): the brand DTO the web layout renders. Many
 *    domains point at one deployment, so the frontend resolves its brand by host here before
 *    login (see apps/web/src/lib/brand/brand.ts).
 *  - `GET /site/me` (auth + requireSite): the brand the caller's token is scoped to — a cheap way
 *    for a client to confirm which brand it's operating under, and the end-to-end proof that the
 *    JWT `site` claim drives `ctx.siteId`.
 */
export function registerSiteRoutes(router: Router, deps: ApiDeps): void {
  // Public platform master switches + maintenance banner (migration 0092). The web reads this to
  // show a maintenance notice and disable deposit/withdraw/play/register/marketer-login controls
  // when the platform owner turns a system off. Fail-open on the server side (all-ON by default).
  router.get(`${BASE}/config`, async () => ({ body: deps.platformGate ? await deps.platformGate.flags() : PLATFORM_ALL_ON }));

  router.get(`${BASE}/site/brand`, async (ctx: Ctx) => {
    const host = ctx.query.get("host")?.trim().toLowerCase();
    if (!host) throw new ApiError("VALIDATION", "host query parameter is required", 400);
    const brand = await deps.brandByHost(host);
    if (!brand) throw new ApiError("SITE_NOT_FOUND", `no active brand for host '${host}'`, 404);
    // #10 geo-currency (presentation only; money of record stays KES cents). The web may pass:
    //   - `country`  = the visitor's ISO country (Cloudflare CF-IPCountry) → a geo-default currency;
    //   - `currency` = the user's saved/selected preference (top priority).
    // Resolution: preference → geo → the brand's own currency. When the resolved currency differs
    // from the brand default AND we can price it live, override the DTO's `currency`+`fxRateFromKes`
    // so every downstream renderer/deposit converts against the right rate. A currency we cannot
    // price (rate ≤ 0) is ignored — the brand currency stands, so amounts never render at a wrong
    // implicit rate. These params vary the CDN cache key, so each currency caches independently.
    const country = ctx.query.get("country");
    const preferred = ctx.query.get("currency");
    const resolved = resolveDisplayCurrency({ userPreference: preferred, countryCode: country, brandCurrency: brand.currency });
    if (resolved !== brand.currency) {
      const fxRateFromKes = await kesToCurrencyRate(resolved);
      if (fxRateFromKes > 0) return { ...brand, currency: resolved, fxRateFromKes };
    }
    return brand;
  });

  const auth = requireAuth(deps.verifier);
  const site = requireSite();
  router.get(`${BASE}/site/me`, auth, site, (ctx: Ctx) => ({ siteId: ctx.siteId }));
}
