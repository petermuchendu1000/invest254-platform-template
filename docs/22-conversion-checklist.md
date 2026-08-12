# 22 — Conversion Checklist (single-tenant → multi-tenant)

> The template ships the **foundation** (sites, site_id, per-site config, seed helper, brand
> resolver). This doc is the exact, ordered work to finish threading `site_id` through the
> money core, engine, RLS, and UI. Each task: **files**, **what to do**, **done when**.
>
> Rule: money touches a real-money DB — apply + test each DB task against a fresh Supabase
> project before the next. Nothing here should be pushed to a live brand untested.

Legend: ✅ shipped in template · 🔲 to do

---

## A. Database foundation
- ✅ `sites` registry + default site — `packages/db/migrations/0044_sites.sql`
- ✅ `site_id` threading + per-site identity uniqueness — `0045_site_scoping.sql`
- ✅ per-site game config + versions + notify — `0046_site_game_config.sql`
- ✅ **Applied & verified** — all migrations 0001→0047 apply cleanly and idempotently on a local
  Postgres 17; existing data backfills to the default site; per-site uniques hold. Proven by
  `packages/db/_testkit/e2e_multitenant.py` (23 scenarios). See TESTING.md.
  🔲 Re-run the same harness against a fresh **Supabase** project before any live use.

## B. Money RPCs — stamp/accept `site_id`
File: `packages/db/migrations/0047_site_money_rpcs.sql` (shipped) + more to extend 0014/0018/0019.
- ✅ `fn_open_position` — accepts `p_site_id`; stamps `positions` + stake ledger; stake bounds read
  from that site's `site_game_config`; locks the wallet **within its site**. Tested (2 sites).
- ✅ `fn_settle_position` — stamps the payout ledger with the POSITION's site (not the default).
  Tested (no cross-site ledger leakage).
- ✅ `fn_register_user` — per-site insert + `unique(site_id, phone/username)`; referral resolved
  **within the site**; also guarantees `profiles.id` self-generates. Tested.
- ✅ `fn_affiliate_enroll` — stamps the affiliate row with the enrolling user's site. Tested.
- ✅ `fn_create_deposit` / `fn_complete_deposit` — deposit stamps `transactions.site_id`; the
  credit ledger derives the site from the tx row. Tested (credit, idempotency, failed-no-credit,
  cross-site rejection). File: `0048_site_payment_fairness_rpcs.sql`.
- ✅ `fn_create_withdrawal` / `fn_reject_withdrawal` / `fn_complete_withdrawal` — hold + reversal
  stamped with the site; per-site `min` enforced; cross-site wallet blocked. Tested.
- ✅ `fn_ensure_game_day` / `fn_reveal_game_day` — per-site (`on conflict (site_id, trade_date)`);
  reveal scoped to one brand. (Also fixes a latent break: 0045 dropped the old trade_date unique.) Tested.
- 🔲 `fn_accrue_affiliate_commissions` / payout RPCs — group GGR by `(site_id, affiliate_id, period)`.
- **Done when:** every money RPC on two sites never collides and every row shows the correct
  `site_id`. Register/open/settle/enroll/deposit/withdraw/game-day are ✅ proven by the 38-scenario e2e.

## C. Engine — multiplex by site
Files: `apps/engine/src/sitecontext.ts` (✅ shipped), `server.ts`, `game.ts`, `daycontext.ts`,
`gameconfig.ts`, `recovery.ts`, new `apps/engine/src/siteregistry.ts`.
- ✅ **Per-site pricing context** (`sitecontext.ts` + `buildSiteContext`): composes the proven
  `CurveGenerator`/`SettlementEngine` with the per-site seed; each brand calibrates RTP to its own
  economy. Tested: decorrelated curves + independent RTP (A≈0.25, B≈0.10) + deterministic rebuild.
- ✅ `SiteRegistry` (`siteregistry.ts`): lazily builds + caches one `{ seeds: SeedManager, game:
  GameServer }` per brand; concurrent builds coalesce. Tested.
- ✅ Per-site seeds: `SeedManager` now takes an optional `siteId` and derives via
  `deriveSiteDaySeed`, committing/revealing game-day rows per brand; `masterSeedFor` resolves
  `sites.master_seed_ref` else the platform `MASTER_SEED`. Tested (decorrelated brands).
- ✅ Site-aware repo methods: `openPosition` (site-stamped, 10-arg RPC), `ensureGameDay` /
  `revealSeed` / `getSeedVersion` (per-site), `listOpenPositions` returns `siteId`. Tested.
- ✅ `GameServer` stamps `ctx.siteId` on every open; positions tracked per site (one GameServer
  per brand via the registry). Tested.
- ✅ WS layer (`multiengine.ts`): binds each socket to its brand at connect (`resolveSite` from
  `?site=`/Host), verifies the JWT `site` claim matches (`AUTH_SITE_MISMATCH`), and fans out
  `tick/online/balance/position_*` **per brand**. Proven by a real two-client integration test
  (`multiengine.test.ts`): decorrelated ticks, isolated auth/open/settle, per-brand stake bounds.
- ✅ `RecoveryService` gained a `siteId` filter; `SiteRegistry.recoverAll()` groups open positions
  by brand and recovers each under its own context. 
- ✅ `server.ts` rewritten as the multiplexed entrypoint (Pg per-site config + in-memory dev
  fallback + per-brand UTC rotation); boot smoke-tested (in-memory → WS `hello`).
- ✅ `SiteGameConfigStore` — per-brand LISTEN `site_game_config_changed` (payload-filtered to the
  brand) + a poll fallback for instant hot-reload; historical versions from
  `site_game_config_versions`; infeasible saves rejected (last good stays live). The `SiteRegistry`
  subscribes and, on a pricing-affecting edit, rebuilds that brand's pricing seeds and re-arms the
  tick loop (non-pricing edits — stake bounds — are read live). `server.ts` wires one store per
  brand via `pool.connect()`. Tested (`sitegameconfig.test.ts`, `siteregistry.test.ts`).
- **Done when:** ✅ two brands with different RTP/curve run in one process; per-brand isolation of
  ticks/balances/settlement/stake-bounds proven; recovery replays each brand; a live config edit
  re-prices only the edited brand's next round. **Task C complete.**

## D. Auth — put the site in the token
Files: `apps/engine/src/authservice.ts`, `auth.ts`, `identity.ts`, `apps/api/src/app.auth.ts`.
- ✅ `issueToken(userId, role, siteId?)` adds a `site` claim; `register`/`login` thread an optional
  `siteId`; `IdentityRepository.register` (5-arg RPC) + `findByPhone(phone, siteId?)` are per-site
  (same phone → two brands, duplicate-within-brand rejected). Tested (`authservice.site.test.ts`)
  + live-DB verified (4-arg→default site, 5-arg→brand; site-scoped login).
- ✅ Verifier (`auth.ts`) surfaces `claims.site`; the multiplex WS `AUTH_SITE_MISMATCH` guard now
  runs on real tokens.
- ✅ API resolves the brand from the request `host` and passes it into `register`/`login`
  (`resolveSiteId` in `app.auth.ts`); the returned session carries `site`. Landed with Task E.
- **Done when:** ✅ a token minted for Brand A carries `site=A` and login is per-brand (proven);
  the API host→site resolution is wired (Task E). **Task D complete.**

## E. API — site scoping + public brand route
Files: `apps/api/src/http.ts`, `app.ts`, `app.site.ts`, `app.auth.ts`, `server.ts`, `testutil.ts`.
- ✅ `requireSite` middleware (`http.ts`): derives `ctx.siteId` from the JWT `site` claim (default
  site for legacy tokens) and rejects a request naming a different brand (`?site=` →
  `AUTH_SITE_MISMATCH`). Surfaced by `GET /site/me`. Tested (`app.site.test.ts`).
- ✅ `GET /site/brand?host=` (public, `app.site.ts`): host/slug → the `sites` brand DTO the web
  resolver (`apps/web/src/lib/brand/brand.ts`) renders — Pg query in `server.ts`, in-memory in
  `testutil.ts`. Tested (host, slug case-insensitive, 400 missing, 404 unknown).
- ✅ Brand-scoped auth: `register`/`login` resolve the brand from the request `host` and pass
  `site_id`, returning the session's `site`; identity is isolated per brand. Tested (two-brand
  register + login isolation).
- 🔲 Thread `ctx.siteId` into every service/repository call (wallet, positions, transactions,
  payments, affiliate, admin reads/writes). The mechanism is in place — `requireSite` populates
  `ctx.siteId` — so this is the remaining per-handler bulk (apply `requireSite` to each group and
  pass `ctx.siteId` down).
- 🔲 M-Pesa callback routes accept the `/s/<slug>` prefix and resolve the site.
- **Done when:** every list/mutation is implicitly filtered to the caller's site; the brand route
  returns correct per-host branding. (Brand route + auth scoping + middleware ✅; per-handler
  threading + callback prefix remain.)

## F. RLS — second dimension
Files: new `packages/db/migrations/00XX_rls_site.sql`.
- 🔲 Extend player policies to `auth.uid() = user_id AND site_id = current_site()` (or enforce
  site in the service layer if RLS stays service-role-bypassed for money paths, as today).
- 🔲 Admin policies: `site_superadmin`/`finance_admin`/`support` see only their `site_id`;
  `platform_superadmin` sees all.
- **Done when:** a site operator cannot read another site's rows via any path.

## G. Web — brand + site context end-to-end
Files: `apps/web/src/lib/brand/*` (resolver shipped), `app/layout.tsx`, `lib/env.ts`,
`lib/api/client.ts`, `lib/game/GameSocketProvider.tsx`.
- 🔲 Resolve brand by host in the root layout; apply `brandRootStyle` (CSS vars) + logo/title.
- 🔲 API client + WS carry the site implicitly via the token (post-login) and via host for
  public calls.
- 🔲 Tailwind tokens read the `--brand-*` CSS variables so components re-skin per brand.
- **Done when:** two domains on one deployment render two distinct brands with no rebuild.

## H. Platform superadmin console
Files: `apps/web/src/app/admin/*`, new `app/platform/*`.
- 🔲 Add `platform_superadmin` to the role rank; a site switcher in `AdminShell`.
- 🔲 All-sites overview (per-site KPIs) at `/platform`.
- 🔲 Site management (create/edit `sites` + `site_game_config`) — the brand-onboarding form.
- 🔲 **Override console:** per-user win-rate control writing `user_overrides(site_id,…)` via the
  existing `overrides.ts` path; confirm dialog + `admin_actions` audit; superadmin-gated.
- **Done when:** you can create a brand, tune its economy, and override a user — all from one UI.

## R. Reporting — cross-brand marketer rollup (per-site identity)
Files: new `packages/db/migrations/00XX_marketer_global.sql`, admin reads.
- 🔲 Optional `marketer_global_id` linking a person's per-site `affiliates` rows (reporting only;
  money stays per site).
- 🔲 Platform report: marketer → per-site clients/GGR/commission + totals.
- **Done when:** "which marketer brought which client on which site, and their total" is one view.

---

## Suggested execution order
`A → B → D → C → E → F → G → H → R`. (DB + auth first so the engine and API have a site to bind
to; RLS after the service layer is site-aware; UI last; reporting rollup any time after B.)

## Testing posture
Mirror the existing test suites **across two sites**: every money/affiliate test should run for
Site A and Site B and assert no cross-contamination. Add a Playwright two-domain smoke test
(Brand A and Brand B render differently and isolate data). Wire into the existing CI
(`.github/workflows/ci.yml`).
