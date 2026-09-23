# 41 — Roles, Scope & Responsibility: the authoritative model (Issue 1, independent re-audit)

> **Status:** living reference. Supersedes the role sections of docs/20 §6 (stale: describes a
> `site_superadmin / finance_admin / support` ladder that never shipped) and corrects docs/40 §0.
> **Method:** every statement is tagged with its evidence level. Nothing here is inferred from naming.
>
> | Tag | Meaning |
> |---|---|
> | **[DB-proven]** | reproduced by an executable test against a real Postgres built from all migrations |
> | **[code-proven]** | read in the source, with file:line |
> | **[unverified-prod]** | true for the repo; the live DB could not be read from the audit sandbox (egress policy) |
>
> Audited at `invest254@49069df` (+ #41 merge `7135cf9`), 2026-09-23.

---

## 1. The tier model (exactly five human tiers)

```
SYSTEM ADMIN     platform_superadmin   global — every platform, every brand
  └─ PLATFORM    platform_admin        ONE platform (a group of brands) — profiles.platform_id
       └─ SITE   admin                 ONE brand — profiles.site_id — day-to-day operations only
            └─ MARKETER  marketer      own affiliate funnel within one brand
                 └─ PLAYER  player     own wallet/positions within one brand
```

`ROLE_RANK` (apps/api/src/http.ts:58): player 1 < marketer 2 < admin 3 < platform_admin 4 <
platform_superadmin 5 **[code-proven]**. `profiles_role_check` allows exactly these five (0152)
**[DB-proven]**. The legacy `superadmin` is gone from the CHECK, but its string literal remains inert in
~29 `fn_*` allow-lists and in `v_mfa_status` (which therefore lists no MFA state for platform tiers).

### 1.1 How scope travels — and the one rule everything depends on
Scope is carried in the signed JWT: `role`, `site` (brand) and, for a platform admin, `platform`.

> **Invariant S1 — every token must carry the scope of its holder.** A site-tier token without a
> `site` claim, or a platform-tier token without a `platform` claim, is *not* "unrestricted" — it is
> malformed and must be refused (fail-closed).

BUGLOG #38 enforced S1 for `platform_admin` only. §5 shows S1 is violated for `admin` today (F-43).

### 1.2 The four enforcement layers (and where they disagree)
| # | Layer | Scope source | Status |
|---|---|---|---|
| 1 | JWT claims (`AuthService.issueToken` / `issueSessionToken`) | live profile | ✅ every mint path stamps site/platform (F-43) |
| 2 | API rank gate (`requireRole`, `requireSiteAdmin`) | token `role` | ✅ |
| 3 | API scope gate (`scope.ts` → `assertSiteTarget`/`assertUserTarget`) | token `site`/`platform` vs the TARGET's brand | ✅ fail-closed on all id-addressed operator routes (F-43, F-44); guarded by the route-registry attack matrix |
| 4a | DB RPCs (SECURITY DEFINER, `p_actor_role`) | **actor's profile** (`fn_actor_target_sites`, 22 fns) | ⚠️ disagrees with layer 3 during impersonation (F-46) |
| 4b | DB RLS for PostgREST (anon key) | JWT GUCs | ✅ after 0153 (was: 36 tables without RLS + 14 owner-run views, #42) |

---

## 2. Roles — the 5 W's, with gaps and over-grants

### 2.1 SYSTEM ADMIN — `platform_superadmin`
- **Who:** the operator of the whole SaaS (singleton by design, migration 0026 lineage).
- **What:** create/suspend platforms; appoint/revoke platform admins; re-parent brands; global config &
  kill switches; payment-provider global config; billing/subscriptions; add-on catalog/pricing/grants;
  owner-tier brand economy (game config, seed rotation, M-Pesa, per-brand pool, per-user overrides);
  Fly ops; system logs; impersonate any brand.
- **Where:** global. `adminScopeSite`/`adminScopePlatform` → `null` **[code-proven http.ts:456,475]**.
- **When:** tenant lifecycle, incidents, economy governance.
- **Why:** one accountable authority must provision and police tenants.
- **Gaps / over-grants:**
  - ✅ No over-grant: global scope is the job.
  - ⚠️ **Missing responsibility — credential hygiene.** The production `DATABASE_URL` sat in the public
    repo for 7 weeks (BUGLOG #41). Owner-only duty: rotate secrets; keep the upstream private or secret-free.
  - ⚠️ Owner-tier levers are reached via `/admin/*?site=` (F1d, docs/40) — no brand picker; error-prone.

### 2.2 PLATFORM ADMIN — `platform_admin`
- **Who:** an operator running ONE platform (a portfolio of brands); appointed only by System.
- **What:** its brands: onboard/create/edit/theme, economy config via `/platform/sites/:id/config`,
  users (status/role/balance/overrides) of its brands, pool distribution, registrar config, tickets to
  System, add-on requests, own subscription view, impersonate its brands.
- **Where:** `profiles.platform_id` = JWT `platform`. Fail-closed on a missing claim (#38)
  **[code-proven http.ts:480]**. Barred from `/admin/*` (`PLATFORM_ADMIN_NO_SITE_BACKOFFICE`).
- **When:** daily portfolio operations.
- **Why:** the middle tier that makes 10k platforms independent.
- **Gaps / over-grants:**
  - ❌ **Over-grant (leak): `GET /platform/domains/health`** returns the Cloudflare status of **every
    platform's** brand domains (the system Cloudflare account), i.e. every other tenant's client list
    **[code-proven server.ts:671]** (F-47).
  - ❌ **Over-grant: `GET /platform/onboard/domain-status?domain=`** probes any domain on the system
    Cloudflare account, not just its own (F-47).
  - ⚠️ Routes guarded by `requireRole("admin")` (notifications, push, tickets, add-ons) also admit a raw
    `platform_admin`; they are safe only where the RPC re-derives scope (tickets, broadcast, add-ons ✅;
    per-user notifications ❌ — F-44).
  - ⚠️ **Impersonation mis-scope in the DB (F-46):** while impersonating brand X, RPCs that re-derive an
    `admin` actor's site from its **profile** act on the platform admin's **home** brand, not X.

### 2.3 SITE ADMIN — `admin`
- **Who:** the day-to-day operator of exactly one brand.
- **What:** its brand's users (list/status/role player↔marketer/balance adjust/reset/clear/details),
  withdrawals/deposits moderation, marketers & marketer finance, affiliate payouts/advances/expenses,
  support chat, reports, announcements to its brand, per-brand withdrawal kill switch, tickets to
  its platform.
- **Where:** `profiles.site_id` = JWT `site`.
- **When:** daily brand operations.
- **Why:** brand-local work must not need platform authority, and must never see another brand.
- **Gaps / over-grants (this tier has the largest surface and the most defects):**
  - ❌ **CRITICAL — scope loss via token refresh (F-43).** `POST /auth/refresh` re-mints the token
    **without `site`** **[code-proven app.auth.ts:329]**; `adminScopeSite()` returns `claims.site ?? null`
    **[http.ts:465]**, and `null` means *unrestricted*. The web calls refresh automatically when the
    token role ≠ live role (i.e. on every promotion) **[SessionBootstrap.tsx:35]**. Result: a newly
    promoted site admin — or any site admin who calls the endpoint — becomes an admin of **every brand on
    every platform**. Same class as #38, which fixed only `platform_admin`; a partial fix (`03c269c`,
    branch `fix/issue1-platform-admin-refresh-scope-leak`) was never merged.
  - ❌ **CRITICAL — missing target checks (F-44).** Routes that take a target id but never check its brand:
    `GET /admin/users/:id`, `/:id/activity`, `/:id/overrides`; `POST|GET /admin/users/:id/notifications`;
    `POST /admin/notifications/:id/resolve` (integer id — enumerable); **all of**
    `GET|PATCH /admin/marketers/:id`, `/credit`, `/withdraw`, `/fuliza`, `/airtime`, `/statement`,
    **`/pin`** (→ marketer account takeover in any tenant), `/status`, `/bulk`;
    `POST|GET /admin/affiliate/expenses` (the RPC never checks the marketer's brand, and the expense
    total nets the marketer's withdrawable across brands — cross-tenant financial sabotage)
    **[code-proven + DB fn reviewed]**.
  - ❌ **HIGH — global reads:** `GET /admin/audit` ignores scope (the service supports `siteId`; the route
    never passes it) — every site admin reads every platform's admin trail. `GET /admin/mpesa-config`
    returns the global M-Pesa config to every site admin. `POST /admin/affiliate/accrue` lets a site admin
    run the commission accrual for **any** brand or **all** brands.
  - ⚠️ Audit attribution is broken (F-45): 26 of 50 DB functions and the API's `recordAction` insert
    `admin_actions` without `site_id` → the row defaults to the **default brand**. Scoping the audit view
    by site is only correct after attribution is fixed.
  - ⚠️ Missing responsibility: none essential; the tier is over-exposed, not under-powered.

### 2.4 MARKETER — `marketer` (two identity types!)
- **Who:** (a) a player promoted to marketer (`profiles.role='marketer'`, the web affiliate dashboard);
  (b) a **marketer-app** identity whose token subject is `marketers.id` (a different table) with role
  `marketer` **[code-proven app.marketers.ts:349,404]**.
- **What:** own funnel, commissions, advances, expenses; marketer-app: own simulated wallet/PIN.
- **Where:** own rows within one brand.
- **When:** promoting, requesting payouts/advances.
- **Why:** growth needs its own surface with zero read into others.
- **Gaps:**
  - ❌ Both marketer mint paths and `/affiliate/enroll` issue tokens **without `site`** (F-43); for
    site-scoped routes `requireSite` then falls back to the **default brand**.
  - ⚠️ Two identities share one role string. Safe today (UUIDs don't collide; `requireMarketer` loads by
    `marketers.id`), but it is a clarity debt: a future route that treats `role=marketer` as a profile id
    would silently mis-resolve. Recommend a distinct claim (e.g. `kind: "marketer_app"`).

### 2.5 PLAYER — `player`
- **Who / What / Where / When / Why:** an end user of one brand; own wallet/positions/transactions/
  bonuses/notifications; own rows only (`sel_own` = `auth.uid()` AND `site = current_site()`).
- **Gaps:** ❌ a refreshed token (F-43) loses `site` → `requireSite` defaults to the default brand.
  Support chat checks the brand but not the conversation owner (anyone holding a conversation UUID can
  post into it; LOW, UUIDs are unguessable) (F-48).

### 2.6 Non-human principals (easy to forget, must be scoped too)
| Principal | Scope today | Finding |
|---|---|---|
| Public anon key (PostgREST) | RLS only | ✅ #42 → closed by 0153 |
| Anyone on the internet (public repo) | the repo | ❌ #41 → `.e2e.env` removed + CI secret-scan; **rotation pending (owner)** |
| Impersonation session | token `site` at API; actor **profile** at DB | ⚠️ F-46 |
| Payment callbacks (`/deposits/*/callback`) | STKPushQuery verify + optional CIDR | ✅ (not re-audited in depth here) |
| Telegram / email approval links | password-gated approve | ✅ (not re-audited in depth here) |

---

## 3. UI — what each role must SEE, what must be HIDDEN, and why

Principle (psychology of scope): an operator should only ever *perceive* the tenant they act for.
Hiding other tenants prevents **mode errors** (acting on the wrong brand — the most common and costly
operator error in multi-tenant consoles) and preserves the **felt independence** each platform is sold
on. UI hiding is presentation only: every rule below is also enforced by the API (the fixes in §5).

| Surface | System | Platform | Site | Marketer | Player |
|---|---|---|---|---|---|
| System console (platforms, appoint admins, global config, providers, billing admin, add-on grants, logs) | ✅ | ❌ hidden | ❌ | ❌ | ❌ |
| Platform console (own brands, onboarding, pool, registrar, own billing, tickets) | ✅ all platforms | ✅ **own platform only** — no other tenant's names, domains or counts | ❌ | ❌ | ❌ |
| Site back-office `/admin/*` (users, finance, withdrawals, marketers, support, reports, announcements) | via impersonation | via impersonation | ✅ own brand | ❌ | ❌ |
| Owner-tier brand config (game, seeds, M-Pesa, pool budget, Fly) | ✅ | ❌ (F1b deferred) | ❌ hidden | ❌ | ❌ |
| Audit log | ✅ global | own platform (to build) | own brand (after F-45) | ❌ | ❌ |
| Marketer dashboard / app | ❌ | ❌ | ❌ | ✅ own | ❌ |
| Player app | via impersonation | via impersonation | via impersonation | ✅ own | ✅ own |

Verified today in the web: `AdminShell.tsx` hides the owner-tier section and Audit log from site admins
(`systemOnly`, `ownerOnly`, lines 43–61, 106–123) and `PlatformShell.tsx` hides system-only items from
platform admins. **The API does not match the UI** for Audit log, M-Pesa config and all F-44 routes —
hidden in the UI, but reachable by calling the API directly.

---

## 4. Responsibility matrix (who is accountable for each lever)

| Lever | Accountable | Also allowed | Never |
|---|---|---|---|
| Create platform / appoint platform admin | System | — | Platform, Site |
| Create/edit/theme a brand | Platform (own) | System | Site |
| Brand economy (RTP, stakes, seeds) | System | Platform (own) — F1b | Site |
| Per-user balance adjust / status | Site (own brand) | Platform (own), System | Marketer, Player |
| Marketer money & PIN | Site (own brand) | System | other brands' admins (F-44) |
| Withdrawal approval (real money) | Site (own brand) | System | — |
| Withdrawal kill switch (brand) | Site (own) | Platform, System | — |
| Global kill switches | System | — | everyone else |
| Commission accrual run | System (all) | Site (own brand) | Site on other brands (F-44) |
| Audit trail read | System (all) | Platform (own), Site (own) | cross-tenant (F-44/45) |
| Secret rotation / repo visibility | System | — | — (BUGLOG #41) |

---

## 5. Findings register (ordered for implementation; one at a time)

| ID | Severity | Finding | Evidence | Fix | Status |
|---|---|---|---|---|---|
| #41 | P0 | Prod `DATABASE_URL` public in repo | raw.githubusercontent → 200 | removed + CI secret-scan | ✅ merged `7135cf9`; **owner must rotate** |
| #42 | P0 | PostgREST table/view surface open to anon key | e2e_postgrest_surface (37 fails pre-fix) | migration 0153 + CI guard | ✅ approved & merged 2026-09-23 — applied by the deploy's migrate step (fails safe if its ownership guard trips) |
| F-43 | P0 | Tokens minted without `site`/`platform`; claimless `admin` = unrestricted | app.auth.ts:329, app.affiliate.ts:87, app.marketers.ts:349,404; http.ts:465 | `issueSessionToken` choke point; `adminScopeSite` fail-closed; `adminListSite` | ✅ BUGLOG #43, branch `fix/issue1-f43-token-scope-claims` |
| F-44 | P0/P1 | 25+ admin routes lacked target-scope checks; global audit/M-Pesa reads; cross-tenant accrual & expenses | §2.3 | `scope.ts` single fail-closed tier rule on all 72 id-addressed operator routes; owner-only audit/M-Pesa; migration 0154; route-registry attack matrix | ✅ BUGLOG #44 |
| F-45 | P1 | Audit rows mis-attributed to the default brand (cross-platform leak via `/platform/sites/:id/audit`) | 26/50 fns + `recordAction` omitted `site_id`; prod: 801 rows on the wrong brand | migration 0155: derived attribution trigger + backfill; NULL = platform-level | ✅ BUGLOG #45 |
| F-46 | P1 | DB scope ≠ API scope during impersonation | 22 fns re-derive from actor profile | carry the effective site into the RPC scope | after F-45 |
| F-47 | P2 | Platform admin sees all tenants' domains | server.ts:647,671 | filter to own platform's brands | queue |
| F-48 | P3 | Support conversation not owner-bound; push unsubscribe by endpoint; `v_mfa_status` stale | app.support.ts:162; app.push.ts:64 | owner binding; scope | queue |

Cross-references: BUGLOG #41–#42 (and the F-IDs as they land), docs/38, docs/40.
