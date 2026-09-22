# 38 — Roles & Scope: the Platform tier (Issue 1)

> Authoritative design for the three-tier admin model and its **strict** cross-scope isolation.
> Extends [docs/20 §6](20-multitenant-architecture.md) (which defined only System → Site) with the
> missing **Platform** tier in the middle. Built on branch `issue1-platform-tier`.

---

## 1. The tier model (basics first)

```
SYSTEM ADMIN        role = platform_superadmin   ← one owner (zrinok). Global. Every platform.
  └─ PLATFORM ADMIN  role = platform_admin        ← a set of sites grouped into ONE platform.
       └─ SITE ADMIN  role = admin                 ← exactly one site (brand).
            └─ marketer / player                    ← per site (unchanged).
```

- A **platform** is a grouping of sites (brands). One row in `public.platforms`.
- A **platform admin** manages ONLY the sites in its platform — its sites, their settings/economy,
  and their site-admins/marketers/players. It can never see or touch another platform's data.
- The **system admin** (`platform_superadmin`, singleton — see migration 0026 lineage) sits above all
  platforms: create/suspend platforms, appoint platform admins, drill into any brand, global config.

### Naming decision (Issue 1)
We **kept the existing DB role strings** and added exactly one new role, to minimise blast radius:

| Tier          | DB role value          | Scope key                         |
|---------------|------------------------|-----------------------------------|
| System admin  | `platform_superadmin`  | global (no scope key)             |
| Platform admin| `platform_admin` (NEW) | `profiles.platform_id`            |
| Site admin    | `admin`                | `profiles.site_id`                |
| (legacy)      | `superadmin`           | per-site full control (dormant)   |
| marketer/player| `marketer` / `player` | `profiles.site_id`                |

---

## 2. Schema (migration `0131_platform_tier.sql`)

- `public.platforms (id, slug, name, owner_user_id, status, notes, created_at, updated_at)`.
- One **default platform** `10000000-0000-0000-0000-000000000001`, owned by the system owner if one
  exists. **All existing sites are assigned to it** on migrate → zero visibility change on day one.
- `sites.platform_id` — `NOT NULL DEFAULT <default platform>`, FK, indexed (backfills existing rows).
- `profiles.platform_id` — nullable; set for a `platform_admin` (the platform it administers).
- `profiles.role` CHECK gains `platform_admin`.
- CHECK `role <> 'platform_admin' OR platform_id IS NOT NULL` — a platform_admin can never be unscoped
  (fail-closed).

## 3. RLS — the platform dimension (migration `0132_rls_platform.sql`)

The app connects as `service_role` (BYPASSes RLS); the app layer + RPCs are authoritative. RLS is the
**defense-in-depth** gate for the public anon/authenticated keys reaching PostgREST directly.

- `current_platform()` — the caller's platform, from JWT `platform` claim → else the platform of
  `current_site()` → else default. (So players/site-admins need no explicit claim.)
- `site_platform(site)` — the platform a site belongs to.
- `is_site_admin(row_site)` gains a `platform_admin` branch: **true iff the row's site is in the
  caller's platform** (`site_platform(row_site) = current_platform()`). This transparently upgrades
  every `sel_admin` policy from 0056 across `profiles, wallets, ledger_entries, positions,
  transactions, bonuses, affiliates, referrals, affiliate_commissions, affiliate_payouts,
  user_overrides, audit_log`.

## 4. Governance RPCs (migration `0133_platform_governance.sql`) — SECURITY DEFINER, service_role

**System-only** (`platform_superadmin`): `fn_platform_create_platform`, `fn_platform_update_platform`,
`fn_platform_assign_site` (re-parent a brand), `fn_platform_appoint_platform_admin`,
`fn_platform_revoke_platform_admin`, `fn_platforms_overview`.

**Platform-aware** role/status management: `fn_admin_set_user_role` / `fn_admin_set_user_status` now
accept a `platform_admin` actor that may manage `player/marketer/admin` users **only inside its own
platform** (enforced in-definer by reading the actor's `platform_id`; cross-platform →
`PLATFORM_SCOPE_FORBIDDEN`). A `platform_admin` target is protected (`PLATFORM_ADMIN_PROTECTED`) and
can only be minted/revoked via the dedicated RPCs, by the system owner.

## 5. Platform-scoped site management (migration `0134_platform_scoped_site_rpcs.sql`)

`fn_platform_create_site` / `fn_platform_update_site` / `fn_platform_set_site_config` now accept a
`platform_admin`, bounded to its platform via `fn_platform_site_in_scope` (cross-platform →
`PLATFORM_SCOPE_FORBIDDEN`); a platform_admin's new site is stamped into its own platform. A **new**
2-arg `fn_platform_overview(actor, actor_role)` returns only the caller's platform sites (system: all)
— the original 1-arg overload is left intact so a not-yet-redeployed API keeps working (no SQL/code
ordering hazard, cf. BUGLOG #24). Bodies are byte-for-byte copies of the current definitions with only
the authorization widened — zero regression for the system-owner path.

## 6. Auth — the `platform` claim

`AuthService.issueToken(userId, role, siteId?, platformId?)` mints a `platform` claim **only for a
platform_admin** (`profiles.platform_id`, surfaced through `CredentialRecord.platformId` in
`identity.ts`). Every other role derives its platform from its site, so no claim is minted. The engine
verifier (`auth.ts`) surfaces `AuthClaims.platform`. `/auth/login` returns `platform` when present.

## 7. API guards (`apps/api/src/http.ts`)

- `ROLE_RANK`: `player 1 < marketer 2 < admin 3 < superadmin 4 < platform_admin 5 <
  platform_superadmin 6`.
- `adminScopeSite`: a `platform_admin` returns `null` (it is NOT a single-site admin — its bound is a
  platform), so it is never mis-scoped to one brand.
- `adminScopePlatform(ctx)`: the platform a caller is bounded to (`platform_admin` → its claim; system
  → null; everyone else → null).
- `assertTargetPlatformInScope(ctx, targetPlatform)`: refuses a known cross-platform target with 403
  `PLATFORM_SCOPE_FORBIDDEN` (tolerant of null scope/target, like `assertTargetSiteInScope`).

## 8. Testing

- **`packages/db/_testkit/e2e_platform_isolation.py`** — 32 scenarios, both layers:
  governance/RPC (system-only ops; platform_admin bounded to its platform for site + user management;
  protections) **and** RLS (platform_admin reads every row of its platform and ZERO outside; site
  admin sees one brand; system sees all; player sees only itself).
- **`apps/api/src/http.platform.test.ts`** — unit coverage of the scope primitives.
- Full DB e2e suite **18/18 green**; full `shared+engine+api` TS suite **930/930 + 6 green**; typecheck
  clean. (Also fixed the pre-existing harness staleness that had masked regressions — BUGLOG #37.)

## 9. Rollout & what is intentionally staged next

- **Migrations 0131–0134 are additive + idempotent.** Apply BEFORE deploying new code (the migrate
  runner enforces this ordering). On apply: nothing changes operationally — all sites sit in the
  default platform owned by the system owner, who still sees everything; no platform admins exist yet.
- **Staged next increments:**
  1. ✅ DONE — platform_admin can operate its OWN platform's sites via `/platform/*` (see §11).
  2. ✅ DONE — money/PII levers extended to platform admins, platform-bounded (see §12).

## 11. Platform-admin console scoping (shipped in this branch)

- **`/platform/*` is now platform-scoped**, not system-only. A `platform_admin` (JWT `role` +
  `platform` claim) may: read its platform overview + brands (`GET /platform/overview`,
  `GET /platform/sites` — filtered to its platform), create/edit/tune its brands
  (`POST /platform/sites`, `PATCH /platform/sites/:id`, `/:id/config`), and manage its brands'
  users (`/:id/users`, `/:id/audit`, `/:id/users/:uid`, `.../status`, `.../role`).
- **Enforcement:** `adminScopeSite` returns null for a platform_admin (not single-site-bound);
  `adminScopePlatform` + a `scopeSiteParam` middleware refuse any `/platform/sites/:id` whose site
  is outside the caller's platform (403 `PLATFORM_SCOPE_FORBIDDEN`); the user drill-downs
  additionally platform-check the target user's own brand. System-only tools (platforms CRUD,
  appoint admins, onboard, payments, global config, pool, marketers, impersonate, owner/theme,
  balance, overrides) stay `platform_superadmin`-gated.
- **Web:** the operator shell admits platform_admin with a SCOPED nav (system-only items hidden);
  Overview + brand drill-downs render only the caller's platform.
- **Tests:** `apps/api/src/app.platform.scope.test.ts` (sees only own platform; cross-platform →
  403; system-only → 403; system unrestricted). Full suite: DB 18/18, engine+api 719/719, web build
  clean.

## 12. Money/PII levers for platform admins (shipped in this branch)

- Migration `0135` extends `fn_admin_adjust_balance`, `fn_admin_adjust_balance_kind`, and
  `fn_admin_set_user_overrides` to accept a `platform_admin` actor, **bounded to its own platform**
  in-definer (`fn_user_platform(target)` = actor's `platform_id`, else `PLATFORM_SCOPE_FORBIDDEN`).
  Every existing guard is preserved: `OVERRIDE_FAVORS_PLAYER`/range checks, `INSUFFICIENT_FUNDS`,
  `REASON_REQUIRED`, and platform-tier staff-wallet protection (`SUPERADMIN_PROTECTED` now also
  covers `platform_admin` targets). Also fixed a latent gap where `fn_admin_adjust_balance_kind`
  rejected even `platform_superadmin`.
- API: `POST /platform/sites/:id/users/:uid/balance` and `PATCH .../overrides` are now
  `platform_admin`-reachable (+ `scopeSiteParam` + target-user platform check). The existing client
  drill-down UI consumes them unchanged.
- Tests: `e2e_platform_isolation.py` now 39 scenarios (in-platform balance/bonus/override OK;
  cross-platform → `PLATFORM_SCOPE_FORBIDDEN`; favors-player guard still enforced for a platform
  admin). Full suite: DB 18/18 (39-scenario isolation), engine+api 719/719.

## 10. Console (shipped in this branch)

- **API (system-gated):** `GET/POST /platform/platforms`, `GET /platform/platforms/overview`,
  `PATCH /platform/platforms/:id`, `POST /platform/sites/:id/assign`,
  `POST /platform/platform-admins`, `POST /platform/platform-admins/:uid/revoke` — all wrap the 0133
  RPCs (`PlatformService` + repo, Pg + in-memory). Tests: `app.platform.platforms.test.ts`.
- **Web (System console):** `apps/web/src/app/platform/platforms/page.tsx` + a "Platforms" nav item —
  per-platform KPI table, create platform, re-parent a site, appoint/revoke platform admins. Built on
  the existing operator design system (React Query hooks + shared UI). `next build` clean.
  UX/psychology: scope framing to prevent mode-errors, pre-attentive status colour, consequence-salient
  confirmation copy on appoint/revoke/suspend, single-CTA empty states.

---

## 13. Issue 1 / F1 — the legacy `superadmin` tier removed (Option B, branch `issue1-remove-superadmin`)

The authoritative model is now exactly **five** tiers — the 6th, out-of-hierarchy `superadmin` role is
gone (migration `0152_remove_superadmin_role.sql`):

```
SYSTEM ADMIN   platform_superadmin   global — every platform
  └─ PLATFORM  platform_admin        one platform (a group of brands)
       └─ SITE admin                 one brand — DAY-TO-DAY ops only
            └─ marketer / player     per brand
```

### What changed
- **DB (`0152`):** fail-closed guard (0 `superadmin` rows), `profiles_role_check` drops `superadmin`,
  and `is_site_admin` is simplified to `{platform_superadmin → true; platform_admin → same-platform;
  admin → same-site}` (the redundant `superadmin` branch and the unreachable `finance_admin`/`support`
  branches — F2 — are removed).
- **Impersonation (Option B):** `/platform/sites/:id/impersonate` now ALWAYS mints a **day-to-day
  `admin` + `site`** token — for BOTH the system owner and a platform admin. There is no longer a
  site-fenced owner-tier session.
- **Owner-tier brand config is System-tier.** Game/economy config, seed rotation, M-Pesa config, the
  per-brand withdrawal-pool budget, Fly ops, and per-user statistical overrides are gated
  `requireRole("platform_superadmin")` — reachable only from the platform/system console (the system
  owner targets a specific brand via `?site=`), never from the site back-office or an `admin`
  impersonation token. The web "Governance" section is System-owner-only.
- **Site admin = day-to-day only.** A site `admin` manages its brand's users (status/role/balance),
  support and reports — but CANNOT touch owner-tier levers (they moved up, not down).

### Why (least privilege, evidence-backed)
`superadmin` had **0 live holders**, yet duplicated the site tier in RLS and concentrated owner-tier
powers behind a role no one held — and, worse, was minted at runtime as the owner's impersonation
token. Collapsing to five tiers makes "who can do what" unambiguous and keeps owner-tier economy
levers at the system tier, where they belong for a 10k-platform operator.

### Scope preserved / no regression
0 users held `superadmin`; the owner-tier `/admin/*` routes were only ever reachable by the system
owner in practice, so no live user loses (or gains) access. Verified: **DB e2e 25/25, TS 1035/1035,
typechecks clean.**

### Deliberately deferred (tracked in BUGLOG #40)
- **F1b** — let a `platform_admin` manage its OWN brands' owner-tier economy (needs the economy RPCs
  widened with platform scope + tests).
- **F1c** — sweep the inert `superadmin` allow-list/protected-target literals from the 29 remaining
  `fn_*` bodies (harmless dead code today; the CHECK forbids the role).
- **F1d** — a brand selector on the System-console owner-tier pages (so the owner picks the target
  brand instead of relying on `?site=`).
