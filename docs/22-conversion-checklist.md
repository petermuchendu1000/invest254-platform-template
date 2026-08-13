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
  ✅ Re-run harness against a fresh project: 38/38 pass on a fresh Postgres 17 (Supabase shim +
  all migrations) via `packages/db/_testkit/e2e_multitenant.py`. (A fresh managed-Supabase run is still recommended before pointing a NEW brand at its own project.)

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
- ✅ `fn_accrue_affiliate_commissions` / payout RPCs — grouped/stamped by `(site_id, affiliate_id,
  period)` (`0050_site_affiliate_accrual_payouts.sql`). Accrual takes an optional `p_site_id`
  (null = all brands) and only ever credits an affiliate for GGR on THEIR OWN brand (join
  `affiliate.site = position.site`); bucket unique is now `(site_id, affiliate_id, referred_user,
  period)`. `fn_affiliate_request_payout` scopes available commission + the reservation to the
  affiliate's brand and stamps the payout's `site_id`. Threaded through the engine
  (`accrueCommissions(period, siteId?)`) + the admin accrue route (optional `site`). Tested:
  `packages/db/_testkit/e2e_affiliate_sites.py` (21 adversarial scenarios: per-brand isolation,
  the cross-brand join guard, idempotency, and the full scoped payout lifecycle).
- **Done when:** ✅ every money RPC on two sites never collides and every row shows the correct
  `site_id`. Register/open/settle/enroll/deposit/withdraw/game-day + affiliate accrual/payout are
  proven by the 38- and 21-scenario e2e harnesses. **Task B complete.**

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
- ✅ Thread `ctx.siteId` into every service/repository call. **Player money core:** history reads
  (`/wallet/ledger`, `/positions`, `/positions/:id`, `/transactions`) + wallet/deposits/withdrawals
  run under `requireSite` and pass `ctx.siteId` into the site-aware RPCs + site-filtered wallet
  reads. **Affiliate:** the marketer routes (`/affiliate/enroll|summary|referrals|commissions|
  payouts`) run under `requireSite` (identity is brand-bound, so reads are self-scoped by userId +
  the cross-brand `?site=` guard); the accrual is site-grouped in the RPC (Task B). **Admin:** the
  list reads (`/admin/users|transactions|withdrawals|deposits`) are scoped by the admin token's
  optional `site` claim — a site-operator token sees only its brand, a platform-admin token (no
  claim) sees all (forward-compatible with the Task H role model). null site → default brand
  everywhere, so single-tenant is unchanged. Tested (`app.admin.sites.test.ts`).
  ✅ Admin *mutation* write-path per-brand enforcement now lands too: `assertTargetSiteInScope`
  (`http.ts`) rejects a site-scoped admin acting on another brand's target (403 `SITE_SCOPE_FORBIDDEN`);
  a platform admin (no `site` claim) and `platform_superadmin` stay unrestricted. Target brand is
  resolved by `AdminService.siteOfUser`/`siteOfTransaction` and `AffiliateService.siteOfPayout`
  (null/legacy → default brand; unknown → the site-aware RPC remains the ultimate guard). Applied to
  status/role/rate/adjust/clear/reset/overrides + the bulk handler (per-row) + withdrawal and
  affiliate-payout approve/reject. Tested (`app.admin.writepath.test.ts`).
- ✅ M-Pesa callback routes accept the `/s/<slug>` prefix and resolve the site (`app.payments.ts`):
  `POST /s/<slug>/deposits/mpesa/callback` and `.../withdrawals/mpesa/result/:txId` resolve the
  slug → `ctx.siteId` before the handler; unprefixed routes stay for the default brand.
- ✅ **Aggressive e2e** (`apps/api/src/app.multitenant.e2e.test.ts`, 8 scenarios): full HTTP
  deposit/withdrawal/position lifecycles across two brands proving transaction/position/ledger
  ISOLATION, `/s/<slug>` callback ROUTING (+ unknown-slug 404), `AUTH_SITE_MISMATCH` on every
  site-scoped route, legacy-token default-site fallback, and brand resolution by host/slug.
- **Done when:** ✅ every player/affiliate list + admin list read is implicitly filtered to the
  caller's site; the brand route returns correct per-host branding. Player/affiliate/admin-read
  threading + callback prefix + e2e ✅. Admin write-path per-brand enforcement ✅ (Task H roles).

## F. RLS — second dimension
Files: `packages/db/migrations/0051_rls_site.sql`.
- ✅ Player/affiliate policies extended to `auth.uid() = <owner> AND site_id = current_site()`
  (`0051_rls_site.sql`) on profiles, wallets, ledger_entries, positions, transactions, bonuses,
  affiliates, referrals, affiliate_commissions, affiliate_payouts. `current_site()` reads the JWT
  `site` claim (per-claim GUC or full-claims JSON), defaulting to the default brand for legacy
  tokens. This closes the anon/authenticated PostgREST cross-brand hole (the app itself connects
  as service_role — RLS-bypassed — and enforces site in the service layer, proven by the money e2e).
  Tested: `packages/db/_testkit/e2e_rls_sites.py` (18 scenarios: own-brand visible, a valid uid with
  the wrong brand claim sees nothing, symmetric brand isolation, cross-user isolation, legacy
  default-brand fallback).
- ✅ Admin RLS policies (`0056_rls_admin.sql`): `jwt_role()` reads the JWT `role` claim and
  `is_site_admin(site_id)` gates a permissive `sel_admin` SELECT policy on every admin-read table
  (profiles, wallets, ledger_entries, positions, transactions, bonuses, affiliates, referrals,
  affiliate_commissions, affiliate_payouts, user_overrides, audit_log). A site-scoped admin
  (`admin`/`superadmin`/`finance_admin`/`support`) reads ONLY rows of its JWT `site` brand;
  `platform_superadmin` reads every brand. OR-ed with 0051's `sel_own`, so player/marketer tokens
  are unaffected; the app still connects as service_role (RLS-bypassed) and stays authoritative.
  Writes remain service_role-only (no authenticated write policies exist). Tested:
  `packages/db/_testkit/e2e_rls_admin_sites.py` (21 scenarios: per-brand admin read isolation, the
  site-claim-follows-scope invariant, platform cross-brand read, no leak to player/empty-role
  tokens, and admin-only `user_overrides` scoping).
- **Done when:** ✅ a brand's anon/authenticated client cannot read another brand's rows via
  PostgREST; app-layer admin reads are site-scoped; **DB-role admin RLS is now enforced too
  (0056).** **Task F complete.**

## G. Web — brand + site context end-to-end
Files: `apps/web/src/lib/brand/*`, `app/layout.tsx`, `app/globals.css`, `lib/game/GameSocketProvider.tsx`,
`components/layout/{Logo,Footer}.tsx`.
- ✅ Resolve brand by host in the root layout (server component: `resolveBrand(env.apiBaseUrl,
  requestHost())` from the proxy-aware host header) and apply `brandRootStyle` (CSS vars) on `<html>`
  before paint. `generateMetadata`/`generateViewport` derive title/description/icons/theme-colour
  from the brand, and a `BrandProvider` (`lib/brand/BrandProvider.tsx`) hands the brand to every
  client component. `Logo` renders the brand logo/wordmark; `Footer` renders the brand name +
  licence line + support email.
- ✅ WS carries the site: `GameSocketProvider` connects to `wsUrlForSite(env.wsUrl, brand.siteId)`
  (`?site=<siteId>`), so the multiplexed engine binds the socket to the brand at connect (before the
  token) and the post-auth JWT `site` claim must then match. REST carries the site implicitly via the
  token post-login; brand resolution is host-based via the public `/site/brand` route.
- ✅ Tailwind tokens read the `--brand-*` CSS variables: `globals.css` maps `--brand-primary` →
  `--pp-brand` and `--brand-accent` → `--pp-accent` (both themes, with default fallbacks), so the
  whole design system re-skins per brand from the vars the layout sets.
- ✅ Tested: `lib/brand/brand.test.ts` (wsUrlForSite query composition, brandCssVars/rootStyle,
  brandWordmark fallback, resolveBrand fetch-merge + non-ok/network fallback). `next build` green
  (all routes SSR per-request for per-brand rendering; server/client boundaries valid).
- **Done when:** ✅ two domains on one deployment render two distinct brands (colours, logo/wordmark,
  title/favicon/theme-colour, licence) with no rebuild — brand is DB data served by `/site/brand`.
  **Task G complete.**

## H. Platform superadmin console
Files: `packages/db/migrations/0052_platform_superadmin.sql`, `apps/engine/src/platform.ts`,
`apps/api/src/app.platform.ts`, `apps/web/src/app/platform/*`, `apps/web/src/lib/platform/*`,
`apps/web/src/components/admin/AdminShell.tsx`.
- ✅ `platform_superadmin` role: added to `profiles_role_check` (0052) + `ROLE_RANK` (rank 5, above
  the per-brand superadmin singleton). AdminShell admits it, treats it as ≥ superadmin, and shows a
  Platform nav section (platform-only).
- ✅ All-sites overview (per-brand KPIs) at `/platform`: `fn_platform_overview` (users, deposits,
  withdrawals, GGR, open positions, bets per brand) → `GET /platform/overview` → a KPI table.
- ✅ Site management (brand onboarding): `fn_platform_create_site` (site + default feasible economy),
  `fn_platform_update_site` (branding), `fn_platform_set_site_config` (economy; the 0046 notify
  hot-reloads the engine, the DB CHECK rejects an infeasible economy) → `POST /platform/sites`,
  `PATCH /platform/sites/:id`, `PATCH /platform/sites/:id/config` → a create form + per-brand cards
  on `/platform`. Every mutation is platform_superadmin-gated + writes an admin_actions audit row.
- ✅ Override console: the per-user override WRITE (`POST /admin/users/:id/overrides`) is now
  superadmin-gated; `fn_admin_set_user_overrides` stamps the override with the target's brand
  (`user_overrides.site_id`) and also accepts `platform_superadmin`. Confirm + audit already present.
- ✅ Tested: `packages/db/_testkit/e2e_platform_console.py` (18 scenarios: gating, onboard + default
  economy, slug uniqueness, branding/economy edits, infeasible-economy rejection, per-brand KPI
  isolation, override brand-stamping), `apps/api/src/app.platform.test.ts` (route gating, onboard →
  list → overview, tune + validation, override superadmin gate). `next build` green (/platform route).
- **Done when:** ✅ you can create a brand, tune its economy, and override a user — all from the one
  admin/platform console UI. **Task H complete.**

## R. Reporting — cross-brand marketer rollup (per-site identity)
Files: `packages/db/migrations/0053_marketer_global.sql`, `apps/engine/src/platform.ts`,
`apps/api/src/app.platform.ts`, `apps/web/src/app/platform/page.tsx` + `lib/platform/*`.
- ✅ Optional `marketer_global_id` on `affiliates` (nullable FK → new `marketer_globals`) links a
  person's per-site affiliate rows. Reporting only — accrual/payouts stay strictly per site (0050
  untouched). `fn_platform_create_marketer_global` + `fn_platform_link_marketer` (link/unlink),
  both platform_superadmin-gated + audited (0053).
- ✅ Platform report `fn_platform_marketer_rollup` → per (affiliate, site) clients / GGR / commission;
  `GET /platform/marketers/rollup` folds it into one entry per marketer (grouped by global id, else
  standalone) with the cross-brand totals. `POST /platform/marketers` + `PATCH
  /platform/affiliates/:userId/marketer` manage identities/links. A read-only rollup table renders on
  `/platform`.
- ✅ Tested: `packages/db/_testkit/e2e_marketer_rollup.py` (21 scenarios: role gating, link
  validation, per-brand facts + isolation, cross-brand totals, reporting-only invariant, unlink,
  audit), `apps/api/src/app.platform.marketers.test.ts` (gating, grouped totals, link/unlink errors).
  Suite 297/297 · tsc clean (engine/api + web) · `next build` green (/platform route).
- **Done when:** ✅ "which marketer brought which client on which site, and their total" is one view.
  **Task R complete.**

---

## Suggested execution order
`A → B → D → C → E → F → G → H → R`. (DB + auth first so the engine and API have a site to bind
to; RLS after the service layer is site-aware; UI last; reporting rollup any time after B.)

## Testing posture
Mirror the existing test suites **across two sites**: every money/affiliate test should run for
Site A and Site B and assert no cross-contamination. Add a Playwright two-domain smoke test
(Brand A and Brand B render differently and isolate data). Wire into the existing CI
(`.github/workflows/ci.yml`).
