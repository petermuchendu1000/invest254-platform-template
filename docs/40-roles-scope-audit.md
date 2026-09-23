# Invest254 — Roles, Scope & Responsibility Audit (Issue 1)

> **Status:** read-only forensic audit. **No code changed, no commits.** Every claim below is backed by
> live-DB inspection (Supabase, migration `0151`, read-only) and code in `invest254@19f0870` (main).
> Method: reconcile **code ⇄ live DB ⇄ docs**; zero assumptions.

---

## 0. Baseline health (what is already correct — evidence first)

| Check | Result | Evidence |
|---|---|---|
| Live schema in sync with repo HEAD | ✅ | `schema_migrations` max = `0151_revoke_public_function_execute.sql` (applied 2026‑09‑22 by `issue1-buglog39`); repo HEAD = `19f0870` "Merge Issue 1 (#38,#39)". |
| Cross‑tenant "missing platform claim = unrestricted" hole (#38) | ✅ FIXED & LIVE | `adminScopePlatform()` throws `PLATFORM_CLAIM_MISSING`; `assertTargetPlatformInScope()` refuses unresolved targets. |
| PrivEsc: anon/authenticated executing admin `fn_*` with spoofed `p_actor_role` (#39) | ✅ FIXED & LIVE | Live grant check: **anon/authenticated can EXECUTE 0 of 152 SECURITY DEFINER fns**. Spot‑checked `fn_admin_adjust_balance`, `fn_admin_set_user_role`, `fn_platform_appoint_platform_admin`, `fn_admin_delete_user` → all `anon=no, authenticated=no`. |
| Direct PostgREST writes to money/PII | ✅ deny‑all | 70 RLS tables; money/PII tables have **only SELECT** policies (no INSERT/UPDATE/DELETE for `authenticated`) → writes only via `service_role` RPCs. |
| `sites` / `platforms` / `marketers` direct read | ⚠️ **CORRECTED 2026‑09‑23 (BUGLOG #42)** | No migration ever enabled RLS on these (or on 33 other tables), and all 14 views ran as owner. Under Supabase default privileges the anon key could read **and write** them. Closed by migration `0153` (RLS everywhere, invoker views, least‑privilege grants) + CI guard `packages/db/migrations.guard.test.ts`. |

**Conclusion:** the platform‑isolation core is sound and the two most recent critical leaks are closed in
production. The remaining work is **structural cleanliness** (the role model the user asked for), not an
active breach. Findings F1–F3 below are the deltas.

---

## 1. The enforcement architecture (4 independent layers)

A request is scoped at **four** layers; each is fail‑closed and independently sufficient for the
PostgREST path:

```
1. JWT claims        role + site (+ platform for platform_admin)   ← minted by AuthService.issueToken
2. API role gate     requireRole / requireSiteAdmin  (ROLE_RANK)   ← apps/api/src/http.ts
3. API scope gate    adminScopeSite / adminScopePlatform +
                     assertTargetSiteInScope / assertTargetPlatformInScope
4. DB (defense-in-depth)
     • RLS policies  sel_own (auth.uid()) OR sel_admin (is_site_admin(site_id))
     • RPC in-definer p_actor_role + fn_platform_site_in_scope (PLATFORM_SCOPE_FORBIDDEN)
```

**`is_site_admin(row_site)`** (the workhorse behind every `sel_admin` policy) resolves scope by JWT role:

| JWT role | Row visible when… | Scope |
|---|---|---|
| `platform_superadmin` | always `true` | **global** |
| `platform_admin` | `site_platform(row_site) = current_platform()` | **one platform** |
| `admin` | `row_site = current_site()` | **one site** |
| `superadmin` | `row_site = current_site()` | one site *(legacy — see F1)* |
| `finance_admin`, `support` | `row_site = current_site()` | **dead branches — see F2** |
| else (player/marketer/anon) | `false` | own rows only (via `sel_own`) |

**`ROLE_RANK`** (`apps/api/src/http.ts`): `player 1 < marketer 2 < admin 3 < superadmin 4 <
platform_admin 5 < platform_superadmin 6`.

---

## 2. Roles — the 5 W's (Who / What / Where / When / Why)

### 2.1 SYSTEM ADMIN — `platform_superadmin`  *(live holders: 1 — `@zrinok`)*
- **Who:** the platform owner/operator (the company running the 10k‑platform SaaS). Singleton by design (migration `0052`/`0026` lineage).
- **What:** everything, globally. Create/suspend **platforms**, appoint/revoke **platform admins**, re‑parent sites, global config & master switches (`platform_global_config`), payment‑provider global config, marketers rollup, subscriptions/billing, impersonate into any brand, read `/admin/logs`.
- **Where (scope):** **global** — no scope key; `adminScopeSite()`/`adminScopePlatform()` both return `null` (unrestricted); `is_site_admin` → `true` for every row.
- **When:** platform lifecycle, onboarding a new operator (platform admin), incident response, global maintenance.
- **Why:** one accountable global authority is required to provision and police tenants; concentrating tenant‑creation + admin‑appointment here is the least‑privilege home for those powers.
- **API home:** `/platform/platforms*`, `/platform/platform-admins*`, `/platform/global-config`, `/platform/payment-providers*` (guard = `requireRole("platform_superadmin")`).

### 2.2 PLATFORM ADMIN — `platform_admin`  *(live holders: 1 — `@thegenius`, platform NDUATI)*
- **Who:** an operator who runs **one platform** = a group of brands/sites. Appointed only by the System Admin.
- **What:** manage **only its own platform's** sites — onboard/create/edit/tune brands, theme them, distribute its pool, and manage its brands' users (status/role/balance/overrides) — all bounded to its platform.
- **Where (scope):** **one platform** = `profiles.platform_id`, surfaced as the JWT `platform` claim. Enforced by `adminScopePlatform()` (throws `PLATFORM_CLAIM_MISSING` if unscoped) + `scopeSiteParam` + `assertTargetPlatformInScope()` + `fn_platform_site_in_scope` (`PLATFORM_SCOPE_FORBIDDEN`). RLS: `is_site_admin` platform branch.
- **When:** day‑to‑day running of its brand portfolio.
- **Why:** the missing middle tier that makes 10k platforms feel isolated; a platform admin must never see another platform (root cause of #38).
- **API home:** `/platform/overview`, `/platform/sites*`, `/platform/sites/:id/users*`, `/platform/pool*`, `/platform/onboard*` (guard = `requireRole("platform_admin")` + scope middleware). **Explicitly barred from** `/admin/*` single‑brand back‑office (`requireSiteAdmin` throws `PLATFORM_ADMIN_NO_SITE_BACKOFFICE`) — it drills into a brand via **impersonation**, which mints a proper `admin`+`site` token.

### 2.3 SITE ADMIN — `admin`  *(live holders: 3)*
- **Who:** the day‑to‑day operator of **exactly one brand/site**.
- **What:** brand back‑office — users of its site (list/status/role within site), support, wallet adjustments/overrides for its players, brand reports. (Owner‑tier brand config today is split with `superadmin` — see F1.)
- **Where (scope):** **one site** = `profiles.site_id` = JWT `site` claim. Enforced by `requireSite()` (rejects `?site=` mismatch, `AUTH_SITE_MISMATCH`), `adminScopeSite()` = the site claim, `assertTargetSiteInScope()` (`SITE_SCOPE_FORBIDDEN`). RLS: `is_site_admin` admin branch (`row_site = current_site()`).
- **When:** daily brand operations.
- **Why:** brand‑local operations must not require platform authority; a site admin must never see another brand.
- **API home:** `/admin/*` (guard = `requireSiteAdmin("admin")`).

### 2.4 MARKETER — `marketer`  *(live holders: 17)*
- **Who:** a promoter/affiliate operating **within one site**; technically a player with a marketer flag (demo‑isolated — docs 27/29).
- **What:** own affiliate/referral funnel, commissions, advances, expenses, demo (social‑proof, non‑withdrawable) balance. **No admin surface.**
- **Where (scope):** **own rows within one site** (`profiles.site_id`); RLS `sel_own` only (rank 2 < admin → `is_site_admin` = false).
- **When:** promoting a brand, requesting payouts/advances.
- **Why:** growth function needs its own economic surface without any read into other users/brands.

### 2.5 PLAYER — `player`  *(live holders: 2,522)*
- **Who:** an end user of one brand.
- **What:** own wallet/positions/transactions/bonuses/referrals/notifications; play, deposit, withdraw.
- **Where (scope):** **own rows only** — every money/PII table's `sel_own` = `auth.uid() = user_id/id/affiliate_id`; `is_site_admin` = false.
- **When:** gameplay.
- **Why:** strict self‑scope is the outermost isolation guarantee.

---

## 3. UI visibility matrix (what each role SEES / what is HIDDEN, and why)

| Surface | System (`platform_superadmin`) | Platform (`platform_admin`) | Site (`admin`) | Marketer | Player |
|---|---|---|---|---|---|
| **System console** (`/platform/platforms`, appoint admins, global config, provider global cfg) | ✅ full | ❌ hidden | ❌ | ❌ | ❌ |
| **Platform console** (`/platform/overview`, brand CRUD, pool, brand users) | ✅ (all platforms) | ✅ (own platform only) | ❌ | ❌ | ❌ |
| **Site back‑office** (`/admin/*`) | ✅ (any, cross‑brand) | ❌ *(uses impersonation)* | ✅ (own site) | ❌ | ❌ |
| **Owner‑tier brand config** (game config, seed, mpesa, fly) — `SuperadminOnly.tsx` | ✅ | via impersonation | ⚠️ *split with `superadmin` — see F1* | ❌ | ❌ |
| **Player app** (wallet/play) | ✅ (impersonate) | ✅ (impersonate) | ✅ (impersonate) | ✅ own | ✅ own |

*Why hidden:* nav is scope‑framed to prevent mode‑errors (operating the wrong brand) and to avoid leaking
the existence of other platforms/brands — the psychological core of "each platform feels independent."

---

## 4. FINDINGS — gaps / over‑grants / drift (each with evidence, severity, and fix)

### 🔴 F1 — Legacy `superadmin` tier is redundant (the user's explicit removal target)
- **Evidence (concrete):**
  - Live holders of `superadmin`: **0** (`select role,count(*) from profiles`).
  - `superadmin` still allowed by `profiles_role_check` and wired into: `ROLE_RANK` (rank 4), `is_site_admin` (site branch), `authservice.PRIVILEGED_ROLES`, **273 non‑test references** across API/engine/web/migrations, and web owner‑tier gates (`SuperadminOnly.tsx`, `role==='superadmin' || 'platform_superadmin'`).
  - `apps/engine/src/authservice.ts` comment: *"the production role set is player/marketer/admin/platform_superadmin — there is no [superadmin]."* The code itself flags it as non‑production.
- **Why it's wrong:** it is a **6th, out‑of‑hierarchy tier** duplicating the site level (its RLS scope is identical to `admin`) while also holding "brand‑owner" powers. The target model is exactly 5 tiers: `platform_superadmin → platform_admin → admin → marketer → player`. Two site‑level admin tiers (`admin` rank 3 **and** `superadmin` rank 4) violate "roles must be completely clear."
- **Blast radius:** DB (CHECK constraint, `is_site_admin` branch, ~15 migrations reference it), API (`http.ts` ROLE_RANK, `app.admin.ts` 24 refs, payments, telegram), engine (authservice, adminservice), web (`SuperadminOnly.tsx` + owner‑tier pages), and ~500 test references.
- **Decision required (see §5):** where do `superadmin`'s *owner‑tier* powers go? Recommended: **up**, not down — retain them at `platform_superadmin` (system) / `platform_admin` (platform), and keep `admin` = day‑to‑day Site Admin. Because 0 users hold `superadmin`, **no live user loses access**; this is a pure structural collapse that *preserves* least‑privilege (site admins do NOT inherit brand‑config powers).

### 🟠 F2 — Dead role branches `finance_admin` / `support` in `is_site_admin()`
- **Evidence:** `is_site_admin()` has `when 'finance_admin'` and `when 'support'` branches, but these values are **not in `profiles_role_check`** and are **never minted** by `AuthService.issueToken` (only profiles.role is used, and it's constrained). Unreachable.
- **Severity:** low (dead code, not a live leak) but it is **drift** that muddies "clear roles" and invites a future footgun (if someone ever adds those values to the CHECK, the branch silently grants site‑wide read).
- **Fix:** remove the two branches (or, if a finance/support tier is desired later, design it explicitly). Fold into the F1 migration.

### 🟡 F3 — Stale documentation: BUGLOG #39 says "MIGRATION PREPARED (pending prod approval)"
- **Evidence:** migration `0151` is **applied in prod** (`schema_migrations`, 2026‑09‑22) and EXECUTE is revoked. The BUGLOG status line is out of date.
- **Fix:** update `docs/BUGLOG.md` #39 → FIXED & DEPLOYED; note the live grant verification.

### ✅ F4 — No active scope leak found (stated for completeness, with evidence)
- Every money/PII RLS table is `sel_own` OR `sel_admin(is_site_admin)`; no cross‑tenant SELECT path for a player.
- All admin/financial `fn_*` are unexecutable by anon/authenticated (post‑0151).
- Platform‑scope guards are fail‑closed on both missing‑claim and unresolved‑target (post‑#38).

---

## 5. Recommended implementation order (one issue at a time) — with approval gates

1. **F3 (docs)** — zero‑risk, do immediately (no approval needed): correct BUGLOG #39 status.
2. **F1 (remove `superadmin`)** — **needs your explicit approval** (production auth change; irreversible‑ish CHECK migration). Plan, on a sub‑branch, additive & reversible:
   - New migration: (a) assert 0 `superadmin` rows (fail‑closed guard), (b) drop `superadmin` from `profiles_role_check`, (c) remove the `superadmin` branch from `is_site_admin` (its behavior merges into `admin`).
   - Code: remove `superadmin` from `ROLE_RANK`, `PRIVILEGED_ROLES`; re‑gate the ~24 owner‑tier `app.admin.ts` routes + web `SuperadminOnly` surfaces to `platform_superadmin` (and `platform_admin` where brand‑scoped) per the mapping we agree.
   - Tests: full DB e2e isolation + TS suite must stay green; add a regression that `superadmin` is rejected by the CHECK and by `issueToken`.
3. **F2 (dead branches)** — fold into the F1 migration/PR (low risk, but ships with auth change).

**I will not implement F1/F2 until you approve the owner‑tier power mapping below.**

### The one decision I need from you (F1 owner‑tier mapping)
Today `superadmin` (site‑owner tier) gates: **game config edit, seed rotation, mpesa/paybill config, Fly ops, default‑pool config**. In the 5‑tier model these are brand/platform concerns, not day‑to‑day site‑admin. Recommended mapping:

| Current `superadmin`-gated power | Recommended new home | Rationale |
|---|---|---|
| Game/economy config edit, seed rotation | `platform_superadmin` (+ `platform_admin` for own brands) | Economy integrity is a platform‑tier lever in a 10k‑platform system. |
| M‑Pesa / paybill / provider config | `platform_superadmin` (global) / `platform_admin` (own brands) | Money rails are platform‑controlled (matches existing `/platform/payment-providers`). |
| Fly ops / infra | `platform_superadmin` only | Infra is system‑tier. |
| Default withdrawal‑pool config | `platform_admin` (own platform) + system | Pool is already platform‑scoped (`0143`). |

If you agree with this mapping (or want site admins to retain any of these), say so and I'll implement F1 exactly to that spec.

---

## 6. Implementation status (updated)

- ✅ **F1 — `superadmin` removed (Option B).** Owner-tier brand config moved to the System console;
  impersonation always mints a day-to-day `admin`; migration `0152_remove_superadmin_role.sql`.
- ✅ **F2 — dead `finance_admin`/`support` branches removed** from `is_site_admin` (folded into 0152).
- ✅ **F3 — BUGLOG #39 status corrected** to FIXED & DEPLOYED (migration 0151 is live; anon/authenticated
  execute 0/152 SECURITY DEFINER fns).
- 📌 Deferred (tracked in BUGLOG #40): **F1b** platform_admin manages its own brands' economy;
  **F1c** sweep inert `superadmin` literals from the 29 remaining `fn_*`; **F1d** brand selector on the
  System-console owner-tier pages.

Cross-references: `docs/38 §13`, `docs/BUGLOG.md #40`, migration `packages/db/migrations/0152_*`.
Verification at merge: DB e2e 25/25 files, TS 1035/1035, `tsc -b` + web `tsc` clean.
