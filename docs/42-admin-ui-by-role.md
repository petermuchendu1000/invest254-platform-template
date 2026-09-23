# 42 — What each operator sees and can do in the UI (authoritative)

Companion to `docs/41-roles-scope-authoritative.md` (who may do what — enforced by the API/DB). This document
defines what each tier's **screens** show and let them touch, why, and every place the current UI
departs from that. Findings are verified against code (file:line) and, where it matters, production data.
Status: audit complete 2026-09-23; fixes land one at a time (register §5).

Tiers: **Owner** (`platform_superadmin`, the system admin) → **Platform admin** (`platform_admin`, one
platform of many brands) → **Site admin** (`admin`, one brand) → **Marketer** → **Player**.
**Impersonation** = an Owner/Platform admin opening one brand's back office with a token of role `admin`,
`site = <brand>` (minted by `POST /platform/sites/:id/impersonate`).

---

## 1. Design principles (and the evidence behind them)

| # | Principle | Why (psychology / standard) |
|---|---|---|
| P1 | **Show only what the tier can do.** A capability a tier will never have is *hidden*, not disabled. Disable-with-a-reason only for a *temporary* state (e.g. "request pending"). | Dead controls teach users the interface lies; every 403 after a click is a broken promise. Hidden permanently-unavailable actions reduce noise (Hick's law) and dead ends. |
| P2 | **One source of truth for permissions.** The UI decides visibility from the *same* capability map the API enforces, and a contract test proves they agree. | Every "dead control" and "hidden-but-allowed control" in §4 is drift between two hand-maintained lists. RBAC guidance: centralise permissions, never scatter role string checks. [Stop hardcoding roles](https://dev.to/d_lynol/stop-hardcoding-roles-a-practical-guide-to-roles-permissions-and-scalable-authorization-1cf) |
| P3 | **Scope is always visible.** Every back-office screen names the brand/platform the operator is acting on. Impersonation is a *mode*: persistent banner + scope chip + distinct accent, and **effective permissions are the impersonated role's, never the actor's.** | Mode errors happen "because the system doesn't clearly indicate its status"; NN/g recommends at least two visual indicators. [NN/g — Modes](https://www.nngroup.com/articles/modes/). GitHub Enterprise impersonation grants "the same access as the user being impersonated", is banner-marked and audited. [GitHub docs](https://docs.github.com/en/enterprise-server@3.18/admin/managing-accounts-and-repositories/managing-users-in-your-enterprise/impersonating-a-user) |
| P4 | **Real money moves only with deliberate confirmation, the same way on every rail** (owner password for payouts; typed/confirmed destructive actions). | Consistency prevents slips; an inconsistent gate is a bypass. NN/g: confirm before destructive actions. [NN/g — Preventing mistakes](https://www.nngroup.com/articles/user-mistakes/) |
| P5 | **Links never act.** A URL may select, highlight or pre-open a confirmation — never execute a state change. | HTTP safe-method semantics: following a link must not request a state change. [RFC 9110 §9.2.1](https://datatracker.ietf.org/doc/html/rfc9110#section-9.2.1) |
| P6 | **Honest data.** Never show a "Live" indicator, zeros or totals the tier cannot actually read; show scoped data or omit the widget. | Visibility of system status (Nielsen #1); false "live" states destroy trust in every other number. |
| P7 | **Say exactly what a control changes.** Global settings live in a global context; brand settings only after a brand is chosen, and labels name the scope. | Accurate mental models (NN/g) — a label that says "every brand" while writing one brand is a guaranteed wrong decision. |

---

## 2. Target UI per tier

### 2.1 Owner (`platform_superadmin`) — system console `/platform`
- **Sees:** all platforms and brands; global economy/master switches; payment providers; add-on catalog,
  pricing and requests; billing of every platform; tickets escalated to System; system logs; global audit;
  engine (Fly) status.
- **Does:** create/edit platforms; appoint/revoke platform admins (**picked from a list, never a raw
  UUID**); onboard brands into a **chosen** platform (single and bulk); edit any brand's identity, theme,
  economy and owner-only brand settings (chart style, trade UI, site owner/default marketer); grant/revoke
  add-ons; set plans/payments; global pool; registrar config **per platform**.
- **Brand back office:** only through **Open brand** (impersonation) with a brand picker, so every
  brand-level action has an explicit brand. Effective role inside = `admin` (P3).
- **Never:** an unscoped back office that mixes all brands in lists while writing brand #1 (§4 UI-2).

### 2.2 Platform admin (`platform_admin`) — platform console `/platform`
- **Sees:** its platform's name (always, in the shell); its brands only; per-brand performance for its
  brands; live activity **for its platform only** (or no live card); its own subscription (read-only);
  its tickets; its registrar; domain health for its brands.
- **Does:** onboard brands into its platform; edit its brands' identity, theme, economy (within the
  feasibility CHECK), legal copy; distribute its platform's pool; manage its brands' players (status,
  role player↔marketer↔admin, balance with real/bonus kind, user detail); request add-ons; raise/escalate
  tickets; open any of its brands (impersonation).
- **Never sees:** other platforms, global switches, provider credentials, owner-only brand settings
  (chart style, trade UI, site owner/default marketer), performance or live feeds of other platforms.

### 2.3 Site admin (`admin`) — brand back office `/admin` (also the impersonated view)
- **Sees:** its brand name in the shell; its brand's users, withdrawals, deposits, transactions,
  marketers and marketer finance, support inbox, tickets, reports, announcements, add-ons.
- **Does:** player/marketer operations within its brand; approve payouts **with the owner password on
  every real-money rail**; brand withdrawal kill switch; announcements to its brand; tickets to its
  platform.
- **Never sees:** owner governance (game economy writes, M-Pesa, Fly, logs, audit), per-user overrides
  (owner-only at the API), other brands, affiliate/referral enrolment for itself.

### 2.4 Marketer / Player
- Marketer: `/dashboard` (own summary, referrals, commissions, expenses, advances). Player: game,
  wallet, history, account. Neither sees any back-office entry point.

---

## 3. Capability matrix (single source of truth: `packages/shared/src/capabilities.ts` — enforced against the API by `apps/api/src/capabilities.contract.test.ts` and in the browser by `apps/web/e2e/roles.e2e.mjs`)

Legend: ✅ allowed & shown · — hidden · (P) own platform only · (B) own brand only.

| Capability | Owner | Platform admin | Site admin / impersonated |
|---|---|---|---|
| Console: platforms, payment providers, global config, add-on catalog/pricing/grants | ✅ | — | — |
| Console: brands list, onboarding, brand identity/theme/economy | ✅ | ✅ (P) | — |
| Console: brand chart style / trade UI / site owner & default marketer | ✅ | — | — |
| Console: performance & live feed | ✅ | ✅ (P) — since UI-5 | — |
| Console: brand players (status, role, balance incl. kind, detail) | ✅ | ✅ (P) | — |
| Console: per-user overrides | ✅ | ✅ (P) | — |
| Registrar config | ✅ (any platform) | ✅ (P) | — |
| Pool distribution | ✅ | ✅ (P) | — |
| Open brand (impersonate) | ✅ | ✅ (P) | — |
| Back office: users, withdrawals, finance, marketers, support, tickets, reports, announcements, add-on requests | via Open brand | via Open brand | ✅ (B) |
| Back office: per-user overrides | — (use console) | — | — |
| Back office: game economy writes, withdrawal-pool budget, M-Pesa, Fly, logs, audit | — (console) | — | — |
| Approve any real-money payout (withdrawal, commission, **affiliate**) | owner password | owner password | owner password |
| Affiliate/referral enrolment for self | — | — | — |

---

## 4. Findings register (verified)

Severity: P1 = money, wrong-scope writes or security-relevant; P2 = broken/misleading core screens; P3 = gaps, wording, hygiene.

| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| UI-1 | **P1** | **Affiliate payout approval dispatches real M-Pesa B2C with no owner password** — every other payout rail (withdrawals, commission payouts) requires it. A site-admin session alone can send affiliate money. | api `app.affiliate.ts:140,163` (no `requireApprovalPassword`; `affiliateservice.ts:82` calls `b2cPayment`); UI `AffiliatePayoutsPanel.tsx:165,222`. Prod: 0 affiliate payouts so far (latent). | ✅ **Fixed** (BUGLOG #50): password required on approve + bulk approve; UI uses the withdrawal password control. |
| UI-2 | **P1** | **Owner's unscoped `/admin` writes brand #1 while labelled global.** Pool-mode switch says "Default for every brand" but `fn_admin_set_pool_mode` updates one site; game-config, withdrawal-pool budget and the withdrawal kill switch all fall back to `DEFAULT_SITE_ID`; lists mix all brands; no brand indicator anywhere. | web `admin/game/page.tsx:159`; api `app.admin.ts:631` (`configSiteId`), `0156:552`; AdminShell has no brand label. | ✅ **Fixed** (BUGLOG #56; owner decision: brand picker): API requires `?site=` from the owner; `/admin` = brand picker for the owner; Pool & payouts on the console brand page; governance moved to the console. |
| UI-3 | **P1** | **Impersonation mode is not authoritative in the UI.** Pages use the *actor* role (`/auth/me`) instead of the impersonated token role, and the impersonation flag lives in per-tab `sessionStorage` while the token is shared in `localStorage`: opening `/admin` in a new tab makes `SessionBootstrap` "heal" the token back to the actor's own (dropping the brand fence for the original tab too), and gives an impersonating owner the full governance nav on an `admin` brand token. | `AdminShell.tsx:88-123`, `SuperadminOnly.tsx:12`, `users/[id]/view.tsx:280,325,405,436`, `impersonate.ts:29-31`, `SessionBootstrap.tsx:33`. | ✅ **Fixed** (BUGLOG #52): `act` claim in the token; token role everywhere via the shared capability list; no re-mint; exit from any tab. |
| UI-4 | P2 | **A link executes a state change.** `/admin/withdrawals?highlight=<tx>&do=reject` rejects the withdrawal on page load (used by the push notification's Reject action). | `admin/withdrawals/page.tsx:91-116`; `public/sw.js:113`. | ✅ **Fixed** (BUGLOG #51): the link highlights + pre-opens a confirmation; the click executes. |
| UI-5 | P2 | **Platform admin's Overview is broken by default:** the period filter calls owner-only `/platform/performance` (default "today") → KPIs and columns render 0; the live card/feed uses an owner-only socket and still shows a pulsing "Live" with 0 online. | web `platform/page.tsx:49,64`, `live.ts:88,112`; api `app.platform.ts:335` (`platform` = owner); engine `multiengine.ts:192`. | ✅ **Fixed** (BUGLOG #53): performance scoped to the caller's platform; engine live feed scoped per platform; client honest about granted/refused. |
| UI-6 | P2 | **Dead owner-only controls shown to platform admins in ClientDetail:** site owner / default marketer select and buttons (server owner-only); chart style / trade UI selects (server 403 `ADDON_SYSTEM_ADMIN_ONLY`) — and because every changed field goes in one PATCH, *any* Identity save that touches them fails. Onboarding page calls owner-only `GET /platform/platforms` for everyone. | `ClientDetail.tsx:97-112,316-333,379-397`; api `app.platform.ts:404,415,286`; `onboard/page.tsx:34`. | ✅ **Fixed** (BUGLOG #52): owner-only settings hidden (read-only line) for platform admins; the form already sent only changed fields; platforms fetched only for the owner. |
| UI-7 | P2 | **Back-office controls disagree with the API per effective role:** "Save overrides" shown to site admins (API owner-only); impersonating platform admin loses Edit details / Role / Delete / Default marketer (API allows); impersonating owner offers `admin` role and admin deletion (API refuses as `admin`); `/admin/audit` and `/admin/logs` open by URL into an error state; governance pages open by URL for an impersonating owner with 403 controls. | `users/[id]/view.tsx:280,325-330,405-409,436,960`; api `app.admin.ts:539,607,612`. | ✅ **Fixed** (BUGLOG #52): capability list + contract test + browser role e2e; owner-only pages gate before loading. |
| UI-8 | P3 | **No scope indicator:** platform admin never sees which platform it is on; back office shows no brand name. | `PlatformShell.tsx:202`; `AdminShell.tsx`. | ✅ **Fixed** (BUGLOG #54): `/auth/me` scope + names; both shells name the brand/platform. |
| UI-9 | P3 | **Owner console gaps:** registrar has no platform picker (always default platform); bulk domain import cannot choose a platform; no add-on grant/revoke UI (hooks exist); appoint/revoke platform admins by raw UUID with no current-admin list; tickets show "New ticket → your platform admin" and "Escalate to System" to the System itself; `/platform/pool` duplicates the global pool with "your brands" copy. | `registrar/page.tsx`, `DomainImport.tsx:62`, `addons/hooks.ts:182`, `platforms/page.tsx:95,210`, `TicketsView.tsx:109,184`. | Platform pickers; grant/revoke UI; admin list with search; owner-appropriate ticket actions. **FIXED** (BUGLOG #59): platform-admin list + cross-brand search (no uuids), owner platform picker on registrar / onboarding + import / pool (`?platform=`, platform admins pinned), default-platform registrar now honoured, owner Assign/Remove add-ons on the brand page, role-aware tickets (owner names the platform; no self-escalation). |
| UI-10 | P3 | **Platform admin capability gaps:** no player detail page, no per-user overrides UI (API exists), balance adjust never sends real/bonus kind, no platform-wide audit view. | api `app.platform.ts:633,667,674`; `ClientDetail.tsx:405`. | Add the screens. **FIXED** (BUGLOG #60): player summary, wallet-explicit balance adjust with before→after confirm, per-player overrides (read route + validated write, brand limits shown), platform-wide **Brand audit** page (`/platform/audit-log`, platform-pinned). |
| UI-11 | P3 | **Removed `superadmin` tier still in the UI:** sent to the API as an announcement audience role; `MeDto.role` union; role checks in overview/user detail; "Superadmin password" / "Superadmin only." copy; ~20 stale comments ("owner-only gating", "SUPERADMIN session"). | `announcements/page.tsx:22`, `lib/api/types.ts:12`, `admin/page.tsx:24`, `ui.tsx:217`, `fly/page.tsx:43`, … | ✅ **Fixed** (BUGLOG #55): literals removed, wording and comments corrected; CI guard. |
| UI-12 | P3 | **Operators offered affiliate enrolment / referral invites** (`/affiliate` treats `admin` as marketer and offers "Apply" to platform tiers; `/account` shows the referral card to operators) — an operator earning revenue share on players they can manage is a conflict of interest. Enrol never changes an operator's role (only player→marketer). | `affiliate/page.tsx:50`; `account` `ReferralInviteCard`; `0047` enrol RPC. | **Decided 2026-09-23 (owner): hide for ALL operators** — no enrolment or referral card for admin / platform admin / owner, and the API refuses enrolment for operator roles. **FIXED** (BUGLOG #58, migration 0159): API `requireEarningRole` on enrol, `/me/referral*` and every marketer earning route (an admin could previously file a cash-advance request); DB refuses operator enrolment, attribution, 5% perk and GGR accrual; enrolment keeps the player's shared code; web `/affiliate` shows a staff notice and `/account` hides the invite card (capabilities `earn.referrals` / `earn.marketer_dashboard`). |
| UI-13 | P3 | Platform admin's impersonate button reads "Log in as **platform admin**" — the session is a brand admin session. | `clients/[id]/view.tsx:25`. | ✅ **Fixed** (BUGLOG #52). |
| UI-14 | P3 | **Brand M-Pesa fields editable by platform admins but not used for routing** (the tab itself says live STK/B2C uses the platform-wide config) — a control with no effect. docs/41 §3 lists brand M-Pesa as not-platform-admin. | `ClientDetail.tsx:441-482,458-462`. | **Decided 2026-09-23 (owner): make it real → PAY-1.** Platform admins manage M-Pesa and every payment-gateway configuration for their whole platform and per brand, and live payments (STK, C2B, B2C, Mega Pay, PayHero) must route with that configuration. Needs its own design (credential encryption, resolution order brand → platform → system, callbacks, payout routing, audit) before code. |

Also recorded (no change needed): a raw platform admin cannot enter `/admin` (matches the API); console
pages scoped server-side never leaked other platforms' data (F-44/F-47); `enroll` cannot demote an operator.

---

## 5. Implementation order (one at a time: branch → failing test → fix → full suites → main → deploy → verify live)

1. UI-1 money gate · 2. UI-4 links never act · 3. capability map + effective role + token `act` claim (UI-3, UI-7, UI-6 partial, UI-13)
· 4. UI-5 platform dashboard · 5. UI-6 remainder · 6. UI-8 scope chips · 7. UI-11 remnants
· 8. UI-2 owner brand picker (decided) · 9. UI-12 operators never affiliates (decided) · 10. UI-9 / UI-10 gaps
· 11. **PAY-1** per-platform / per-brand payment-gateway configuration honoured by live payments (decided; design first). **DONE** — docs/43, BUGLOG #63.

Interposed before UI-12: **DRIFT-1** (BUGLOG #57) — production's affiliate functions did not match the migrations; migration 0158 reconciles them and a nightly/post-deploy schema-drift gate now guards it. UI-12 builds on the reconciled (production-equal) definitions.
