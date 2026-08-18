/**
 * Referral routes — available to EVERY authenticated user (players + marketers), brand-scoped.
 *   GET /me/referral              -> code + link + headline earnings + counts
 *   GET /me/referral/commissions  -> paginated instant-commission feed
 *   GET /me/referral/referred     -> per-referred-player breakdown (deposited vs played vs unplayed)
 */
import { Router, requireAuth, requireSite, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";

const BASE = "/api/v1";

function pageQuery(ctx: Ctx) {
  const limitRaw = ctx.query.get("limit");
  return { limit: limitRaw === null ? undefined : Number(limitRaw), cursor: ctx.query.get("cursor") };
}

export function registerReferralRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const site = requireSite();

  router.get(`${BASE}/me/referral`, auth, site, async (ctx: Ctx) => {
    const uid = ctx.claims!.userId, sid = ctx.siteId!;
    const [info, earnings] = await Promise.all([
      deps.referral.info(uid, sid),
      deps.referral.earnings(uid, sid),
    ]);
    const link = info.code
      ? (info.primaryDomain ? `https://${info.primaryDomain}${info.referralPath}` : info.referralPath)
      : null;
    return {
      code: info.code, link, referralPath: info.referralPath,
      referredCount: info.referredCount, downlineMarketers: info.downlineMarketers,
      earnings,
    };
  });

  router.get(`${BASE}/me/referral/commissions`, auth, site, async (ctx: Ctx) =>
    deps.referral.history(ctx.claims!.userId, ctx.siteId!, pageQuery(ctx)));

  router.get(`${BASE}/me/referral/referred`, auth, site, async (ctx: Ctx) =>
    ({ items: await deps.referral.referred(ctx.claims!.userId, ctx.siteId!) }));
}
