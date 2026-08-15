# 24 — Platform Console (platform_superadmin control plane)

> **Status: DESIGN / SPEC (not yet implemented).** This document is the authoritative design for a
> comprehensive, professional `platform_superadmin` console that gives the platform owner **total
> control over every client (brand) and every system setting** — the fields implemented today and a
> declarative structure for fields we add later. No code is written from this doc yet; it is the
> blueprint the phased build (see §10) will follow.
>
> Companion docs: `20-multitenant-architecture.md` (tenancy), `21-brand-onboarding.md` (onboarding),
> `22-conversion-checklist.md` (Task H platform surface), `23-brand-theme-presets.md` (theming),
> `10-admin-panel.md` (per-brand operator console). Governance parity migration: `0058`.

---

## 1. Purpose & scope

The current `/platform` page (`apps/web/src/app/platform/page.tsx`, ~400 lines) is a **single flat
page**: an onboarding form, a sites list, a seed-hue palette editor, and a marketer rollup. It works,
but it is **too basic** for real platform operations — most of a client's configurable surface is not
reachable for an arbitrary brand, there is no per-client deep view, no audit, no payments/seeds/player
management across brands, and no structure for growth.

This spec defines a **control plane** where the platform owner can:

- See **all clients** at a glance (KPIs, health, status) and drill into **any one client** in depth.
- Read and edit **every stored detail** of a client — identity, branding, economy, payments,
  fairness, locale/legal, players, affiliates — organised into clear forms and expandable sections.
- Perform **cross-brand** operations (onboarding, marketer identities, global reporting).
- **Override any system setting** for any brand or user (the platform owner is unrestricted; see §2).
- Do all of the above with **auditability, validation, safe confirmations, and a professional UI**.

**Non-goals:** this console does not replace the per-brand operator console (`/admin`, doc 10) used by
site-scoped `admin`/`superadmin` operators. It is the *superset* control plane for the platform owner.

---

## 2. Authority model (who can do what)

Role hierarchy (`apps/api/src/http.ts` → `ROLE_RANK`), higher rank satisfies any lower gate:

```
player(1) < marketer(2) < admin(3) < superadmin(4) < platform_superadmin(5)
```

| Role | Scope | Console |
|------|-------|---------|
| `admin` | one brand (JWT `site` claim); day-to-day ops | `/admin` (Operations) |
| `superadmin` | one brand; full governance of that brand | `/admin` (Operations + Governance) |
| `platform_superadmin` | **all brands, unrestricted** (`adminScopeSite()` → `null`) | **`/platform` (this console)** |

**"platform_superadmin can override any system setting."** This is the governing principle:

- Every write path admits `platform_superadmin` as an actor (governance parity restored in migration
  `0058_platform_superadmin_governance_parity.sql` — it was previously locked out of role/status/
  balance RPCs by strict `= 'superadmin'` checks).
- `assertTargetSiteInScope()` returns early for the platform owner → **no brand is off-limits**.
- The platform owner's own account is **protected** (`SUPERADMIN_PROTECTED`) from demotion, ban, or
  balance mutation by any lower admin (also `0058`).
- Minting a **new** `superadmin`/`platform_superadmin` remains an out-of-band DB/script operation
  (`scripts/make_operator.ts`) — deliberately *not* a console button, to keep owner provisioning a
  physical-access act. The console MAY promote up to `admin`.

Every mutation writes an `admin_actions` audit row (actor, role, action, target, detail, site_id).

---

## 3. Current state (baseline) vs. target

### 3.1 What exists today

- **API** (`apps/api/src/app.platform.ts`, gated `requireRole("platform_superadmin")`):
  `GET /platform/overview`, `GET /platform/sites`, `POST /platform/sites`, `PATCH /platform/sites/:id`,
  `PATCH /platform/sites/:id/config`, `PATCH /platform/sites/:id/theme`,
  `GET /platform/marketers/rollup`, `POST /platform/marketers`,
  `PATCH /platform/affiliates/:userId/marketer`, `POST /platform/onboard`,
  `GET /platform/onboard/domain-status`.
- **DB RPCs**: `fn_platform_create_site`, `fn_platform_update_site`, `fn_platform_set_site_config`,
  `fn_platform_set_site_theme`, `fn_platform_overview`, `fn_platform_marketer_rollup`,
  `fn_platform_create_marketer_global`, `fn_platform_link_marketer`.
- **Web**: one page with onboarding, sites list, seed-hue theme editor, marketer rollup
  (`lib/platform/{endpoints,hooks}.ts`).

### 3.2 Why it is "too basic"

- No **per-client deep view** — everything is inline on one page; you cannot see or edit the full
  surface of a single brand.
- **Missing cross-brand reach** for: M-Pesa/payments, fairness seeds, players + per-user overrides,
  brand status lifecycle, per-brand audit log, balance operations.
- Branding editor is **seed-hue only** — does not expose the full token contract (neutrals, mono
  font, heading weight, radius) nor the **56-theme mirror library** (`lib/brand/siteThemes.ts`).
- No search/sort/filter, no health signals, no confirmations/danger-zone, no audit trail surfacing.
- No **extensibility structure** — adding a field means editing a monolithic page.

---

## 4. The complete client data model ("every possible detail")

Everything the console must let the owner read/override, grounded in the live schema.

### 4.1 `sites` (31 columns) — identity, branding, locale, payment refs

| Group | Columns |
|-------|---------|
| Identity | `id`, `slug`, `name`, `status` (`active`/`paused`/…), `primary_domain`, `owner_user_id`, `notes`, `created_at`, `updated_at` |
| Branding | `logo_url`, `favicon_url`, `wordmark_text`, `color_primary`, `color_bg`, `color_accent`, `theme` (dark/light/auto), `theme_tokens` (jsonb — full palette + `fontTitle`/`fontBody`/`fontMono`/`headingWeight`/`radius`) |
| Locale & legal | `currency`, `locale`, `licence_line`, `support_email`, `legal_copy` (jsonb) |
| Payments (M-Pesa) | `mpesa_env`, `mpesa_shortcode`, `mpesa_callback_base`, `mpesa_b2c_initiator`, and secret **refs** (write-only, never returned): `mpesa_consumer_key_ref`, `mpesa_consumer_secret_ref`, `mpesa_passkey_ref`, `mpesa_b2c_credential_ref` |
| Fairness | `master_seed_ref` |

### 4.2 `site_game_config` (per brand economy)

`house_edge`, `max_multiplier`, `min_stake`, `max_stake`, `min_withdrawal`, `default_duration_s`,
`tick_rate_ms`, `drift_bias`, `volatility`, `target_win_rate`, `version`, `updated_by`, `updated_at`.
Feasibility is enforced by a DB `CHECK` (`site_cfg_feasible`) mirrored client-side by
`checkFeasible()` (`@invest254/shared/config`).

### 4.3 `user_overrides` (per-player economy override, brand-scoped)

`user_id`, `site_id`, `win_rate`, `house_edge`, `trade_duration_s`, `max_win_multiplier`,
`min_stake`, `max_stake`, `notes`, `updated_by`, `updated_at`. RPC `fn_admin_set_user_overrides`
(already admits `platform_superadmin`).

### 4.4 Payments — `mpesa_config` (+ per-site refs)

Legacy single-tenant `mpesa_config` table (`environment`, `shortcode`, `consumer_key`,
`consumer_secret`, `passkey`, `stk_callback_url`, `b2c_initiator`, `b2c_security_credential`,
`b2c_result_url`, `b2c_timeout_url`). RPCs `fn_admin_get_mpesa_config` (masked read) /
`fn_admin_update_mpesa_config` (write; secrets write-only). Per-site config lives on `sites.mpesa_*`.

### 4.5 Fairness — `game_days`, `seed_overrides`

`game_days` (`trade_date`, `server_seed_hash`, `server_seed` (revealed), `revealed_at`, `site_id`);
`seed_overrides` (`trade_date`, `version`, `requested_by`). RPC `fn_admin_rotate_seed`.

### 4.6 Affiliates / marketers

`affiliates` (`user_id`, `referral_code`, `commission_rate`, `status`, `site_id`,
`marketer_global_id`). RPCs `fn_admin_set_commission_rate`, `fn_platform_create_marketer_global`,
`fn_platform_link_marketer`, `fn_platform_marketer_rollup`.

### 4.7 Players & money

`profiles` (`role`, `status`, `phone`, `username`, `site_id`), `wallets` (`real_balance`,
`bonus_balance`). RPCs: `fn_admin_set_user_role`, `fn_admin_set_user_status`,
`fn_admin_adjust_balance`, `fn_admin_adjust_balance_kind`, `fn_admin_clear_balance`,
`fn_admin_reset_balance_to_last_funded` (all admit `platform_superadmin` after `0058`; owner accounts
protected).

### 4.8 Audit — `admin_actions`

`actor_id`, `actor_role`, `action`, `target_type`, `target_id`, `detail` (jsonb), `site_id`,
`created_at`. Surfaced as a per-brand and platform-wide activity trail.

---

## 5. Information architecture

```
/platform
├── Dashboard            KPI tiles across all brands + alerts (infeasible economy, paused brands,
│                        unresolved domains, pending withdrawals, revealed-seed gaps)
├── Clients              data-table of all brands  ──▶  Client Detail (see §6)
│     └── [brand]        full-screen detail with expandable/tabbed sections
├── Onboard client      guided wizard (identity → branding → economy → payments → domain)
├── Marketers           cross-brand marketer identities + rollup + link/unlink
├── Audit               platform-wide admin_actions stream (filter by brand/actor/action)
└── Platform settings   global defaults, feature flags, owner account, danger zone
```

### 5.1 Clients table

Columns: brand (logo + name + slug), status pill, primary domain (+ resolve state), users, deposits,
withdrawals, GGR, open positions, theme swatch, last updated. Features: search, multi-sort,
status/health filters, column density toggle, row → Client Detail. Data: `GET /platform/overview`
(KPIs) joined with `GET /platform/sites` (config/identity).

### 5.2 Client Detail (the core surface)

A full-height view with a sticky header (brand identity + status + quick actions: visit site, pause,
impersonate-read) and a left rail of **expandable sections** (accordion on narrow, tabbed on wide).
Each section is an independent form with: load/skeleton, dirty-tracking, inline validation, **Save
N changes / Reset**, optimistic update + toast, and a "last updated by / at" line. Sections in §6.

---

## 6. Section-by-section specification

Each section lists: fields, controls, validation, backend, and future-field notes. Legend for
backend: **[live]** already available, **[gap]** needs a new platform endpoint (see §7).

### 6.1 Identity & status
- Fields: `name`, `slug` (read-only after create), `status` (active/paused), `primary_domain`,
  `wordmark_text`, `logo_url`, `favicon_url`, `owner_user_id` (picker), `notes`.
- Controls: text inputs, status segmented control (with confirm on pause), image URL preview.
- Validation: slug immutable; domain format; URL format for logo/favicon.
- Backend: `PATCH /platform/sites/:id` **[live]** (arbitrary column patch via `fn_platform_update_site`).
- Future: multiple domains/aliases, brand tags, account manager, contract dates.

### 6.2 Branding & theme
- Fields: `theme` (dark/light/auto), full `theme_tokens` (bg/surface/surface2/border/fg/muted/
  brand/brandHover/brandText/accent/accentFg/up/down/warn/info + `fontTitle`/`fontBody`/`fontMono`/
  `headingWeight`/`radius`), `color_primary/bg/accent` (kept in sync).
- Controls: (1) **56-theme mirror picker** (`SITE_THEMES` from `lib/brand/siteThemes.ts`) — one click
  applies a complete, WCAG-checked identity; (2) seed-hue derive (existing `deriveMinimalPalette`);
  (3) advanced token editor with **live preview** (mini trade-card) and contrast readouts.
- Validation: hex tokens, fonts ∈ `BRAND_FONTS`, radius CSS length, WCAG fg/bg ≥ 4.5 / accent ≥ 3.
- Backend: `PATCH /platform/sites/:id/theme` **[live]** + `PATCH /platform/sites/:id` for mode/colors.
- Future: logo upload to R2, gradients, per-brand favicon generation.

### 6.3 Economy (game config)
- Fields: `target_win_rate`, `house_edge`, `min_stake`, `max_stake`, `min_withdrawal`,
  `default_duration_s`, `max_multiplier`, `drift_bias`, `volatility`, `tick_rate_ms`, `version`.
- Controls: percentage inputs (win rate / house edge as %), KES inputs (cents ↔ KES), advanced group.
- Validation: **live feasibility preview** via `checkFeasible()`; block save if infeasible (mirrors
  the DB `site_cfg_feasible` CHECK → 422). Show resulting RTP + mean winning multiple.
- Backend: `PATCH /platform/sites/:id/config` **[live]**.
- Future: scheduled config changes, A/B economy, per-segment tuning.

### 6.4 Payments (M-Pesa)  **[gap]**
- Fields: `mpesa_env` (sandbox/production), `mpesa_shortcode`, `mpesa_callback_base`,
  `mpesa_b2c_initiator`; secret **refs** write-only (consumer key/secret, passkey, B2C credential) —
  masked read, never returned in plaintext.
- Controls: env toggle, text inputs, "set secret" write-only fields (blank = unchanged), a
  **connection test** action (STK dry-run against sandbox).
- Backend gap: `GET /platform/sites/:id/mpesa` (masked) + `PATCH /platform/sites/:id/mpesa` —
  wrap `fn_admin_get_mpesa_config` / `fn_admin_update_mpesa_config` with an explicit target `site_id`.
- Future: per-brand payment providers beyond M-Pesa, payout schedules.

### 6.5 Fairness (provably-fair seeds)  **[gap]**
- Fields: per `trade_date`: `server_seed_hash` (committed), `revealed_at`, `version`.
- Controls: seeds table, **rotate seed** (confirm) for a date, reveal state badges.
- Backend gap: `GET /platform/sites/:id/seeds` + `POST /platform/sites/:id/seeds/rotate`
  (wrap `fn_admin_rotate_seed` / seed listing with explicit `site_id`).
- Future: scheduled auto-rotation policy, downloadable fairness proof bundle.

### 6.6 Locale & legal
- Fields: `currency`, `locale`, `licence_line`, `support_email`, `legal_copy` (jsonb: terms,
  privacy, responsible-gaming, about).
- Controls: currency/locale selects, text inputs, structured JSON/markdown editors per legal doc.
- Backend: `PATCH /platform/sites/:id` **[live]** (partial today) — extend to accept `legal_copy`.
- Future: multi-language legal copy, versioned legal docs with effective dates.

### 6.7 Players & per-user overrides  **[gap]**
- Views: brand's players table (search by phone/username, role, status, balance); player detail →
  role, status (suspend/ban), balance ops (adjust/clear/reset-to-last-funded), **economy override**
  (`user_overrides` fields), affiliate commission rate.
- Backend gap: `GET /platform/sites/:id/users`, `GET /platform/sites/:id/users/:uid`, and
  platform wrappers routing to the (now platform-capable) `fn_admin_*` RPCs with the target user's
  brand context. Owner accounts remain `SUPERADMIN_PROTECTED`.
- Future: bulk actions, KYC review, notes/timeline per player.

### 6.8 Affiliates & marketers
- Views: brand affiliates (code, commission rate, status, linked global marketer); cross-brand
  marketer rollup (clients/GGR/commission per site + totals); create global marketer; link/unlink.
- Backend: `GET /platform/marketers/rollup`, `POST /platform/marketers`,
  `PATCH /platform/affiliates/:userId/marketer` **[live]**; `fn_admin_set_commission_rate` for rate.
- Future: payout runs, commission tiers, marketer logins.

### 6.9 Audit & danger zone  **[gap]**
- Views: per-brand `admin_actions` stream (filter by actor/action/date); danger zone (pause/resume,
  archive, transfer ownership — flagged as out-of-band where applicable).
- Backend gap: `GET /platform/sites/:id/audit` (filtered `admin_actions` by `site_id`).
- Future: export audit, alerting rules.

---

## 7. Backend gaps → new endpoints to build

All gated `requireRole("platform_superadmin")`; all parameterised by an explicit **target `site_id`**
(the platform owner is unrestricted, so the endpoint carries the brand instead of relying on a JWT
`site` claim). Each wraps an existing, already-`platform_superadmin`-capable RPC.

| New endpoint | Wraps | Notes |
|--------------|-------|-------|
| `GET  /platform/sites/:id/mpesa` | `fn_admin_get_mpesa_config` | masked; secrets never returned |
| `PATCH /platform/sites/:id/mpesa` | `fn_admin_update_mpesa_config` | secrets write-only (blank = keep) |
| `GET  /platform/sites/:id/seeds` | seed listing (`game_days`) | per-brand |
| `POST /platform/sites/:id/seeds/rotate` | `fn_admin_rotate_seed` | confirm; audited |
| `GET  /platform/sites/:id/users` | users list | search/sort/paginate |
| `GET  /platform/sites/:id/users/:uid` | user detail | profile + wallet + overrides |
| `POST /platform/sites/:id/users/:uid/role` | `fn_admin_set_user_role` | ≤ admin; owner protected |
| `POST /platform/sites/:id/users/:uid/status` | `fn_admin_set_user_status` | owner protected |
| `POST /platform/sites/:id/users/:uid/balance` | `fn_admin_adjust_balance*` / `clear` / `reset` | owner protected |
| `PATCH /platform/sites/:id/users/:uid/overrides` | `fn_admin_set_user_overrides` | per-user economy |
| `GET  /platform/sites/:id/audit` | `admin_actions` (by site) | filter/paginate |
| extend `PATCH /platform/sites/:id` | `fn_platform_update_site` | ensure `legal_copy`, all identity cols |

The engine layer needs matching `PlatformService`/repository methods; the DB RPCs are already in
place (no new migrations expected, except possibly a thin `fn_platform_*` wrapper if we prefer the
platform RPC naming convention over calling `fn_admin_*` with an explicit site).

---

## 8. UX & design system

- **Aesthetic:** a dense, professional **enterprise-admin** UI modelled on Linear/Stripe dashboards,
  built on the existing Tailwind design tokens (no external paid template). *Decision to confirm:
  Linear-style dark & dense (recommended) vs. Stripe-style light & airy vs. match current console.*
- **Layout primitives:** app shell (existing `AdminShell` Platform section) → workspace → detail.
  Clients table with sticky header, virtualised rows for scale (50+ brands). Client Detail = sticky
  brand header + section rail + scrollable form area.
- **Components to build/extend:** `DataTable` (sort/filter/search/density), `Section`/`Accordion`
  (expandable, remembers open state), `Field` (label + control + hint + error), `FormCard` (dirty
  tracking + Save/Reset bar), `SecretField` (write-only), `JsonEditor`, `ThemePicker`
  (56-theme grid + preview), `ConfirmDialog`, `StatusPill`, `AuditList`, `StatCard`, `EmptyState`,
  `Toast` (existing).
- **Patterns:** optimistic saves with rollback on error; per-section dirty state; keyboard-first
  (⌘K command palette to jump to a brand/section — future); confirmations for destructive/visible
  actions (pause brand, ban user, rotate seed, balance clear); consistent loading/empty/error states.
- **Responsive:** table collapses to cards < 640px; Client Detail sections switch accordion↔tabs;
  forms single-column at narrow, two-column at md+.
- **A11y:** labelled controls, focus rings, `aria-current`, contrast from the token system, reduced-
  motion respected.

---

## 9. Extensibility (future-proofing)

To make "fields we may add in future" cheap, the Client Detail is driven by a **declarative section
registry** rather than hand-built pages:

```ts
// pseudo-shape
type FieldSpec = { key; label; kind: 'text'|'number'|'pct'|'kes'|'select'|'secret'|'json'|'color'|'toggle';
                   hint?; validate?; options?; advanced?; };
type SectionSpec = { id; title; icon; endpoint; fields: FieldSpec[]; permission; };
const CLIENT_SECTIONS: SectionSpec[] = [ identity, branding, economy, payments, fairness, locale,
                                         players, marketers, audit ];
```

Adding a field = append a `FieldSpec` (+ ensure the column/RPC accepts it). Adding a section = append
a `SectionSpec`. The renderer, dirty-tracking, validation, and save bar are generic. This keeps the
console comprehensive today and trivially extensible tomorrow.

---

## 10. Phased delivery plan (build order)

Each phase is shipped only after **end-to-end verification** (see §11).

1. **Foundation** — Clients `DataTable`, Client Detail shell (section registry, generic form/save),
   and the three **[live]**-backed sections: Identity, Branding (incl. 56-theme picker), Economy.
2. **Payments (M-Pesa)** — new `/platform/sites/:id/mpesa` endpoints + engine methods + form.
3. **Fairness (seeds)** — seeds endpoints + UI.
4. **Players & overrides** — users/user-detail endpoints + role/status/balance/overrides + UI.
5. **Locale/Legal + Audit + Danger zone**.
6. **Platform-wide** — Dashboard KPIs + alerts, Onboarding wizard, Marketer console, Platform settings.

Acceptance per phase: all fields in scope readable + writable for **any** brand; validation +
feasibility enforced; audit rows written; owner-protection intact; UI passes build + a11y + responsive.

---

## 11. Testing strategy (end-to-end, per feature)

- **DB layer:** rolled-back dry-runs of each RPC as `platform_superadmin` against a target brand/user
  (pattern already used for `0058`), asserting success + `SUPERADMIN_PROTECTED`/authz negatives.
- **API layer:** contract tests per endpoint (authz: admin → 403, platform → 200; validation; masked
  secrets never leak) against the live API with a `platform_superadmin` token.
- **UI layer:** Next build (typecheck) + component unit tests for the generic form/validation, and
  **Playwright** happy-path against the deployed console (load brand → edit a field in each section →
  save → reflect + audit row) before moving to the next feature.
- **Regression:** existing brand-lib and admin tests stay green; each phase adds tests.

---

## 12. Open questions / decisions

1. Visual direction (§8): Linear-dense (recommended) vs Stripe-light vs match-current.
2. Impersonation: read-only "view as brand" now, or later?
3. Ownership transfer & brand archival: console action vs out-of-band only?
4. Secret storage: continue with `*_ref` indirection (current) — confirm the ref backend for writes.
5. Naming: expose new cross-brand endpoints as `fn_platform_*` wrappers, or call `fn_admin_*` with an
   explicit `site_id`? (Leaning: thin `/platform/...` HTTP routes over existing `fn_admin_*`.)

---

*End of spec. Implementation begins only after this document is reviewed/approved.*

---

## 13. IMPLEMENTED — Logo & favicon pipeline (autonomous, Workers AI)

**Status: shipped.** `scripts/generate_brand_assets.py` generates a unique, professional brand MARK
per client using **Cloudflare Workers AI** (`@cf/black-forest-labs/flux-1-schnell`) — server-side,
using the platform's existing Cloudflare account (no fal/replicate key), so it runs autonomously.

- **Engine decision:** evaluated fal (Ideogram 3 / Recraft V3 — best quality but needs a new
  account/key) vs Cloudflare Workers AI (Flux, already-owned creds, callable from Fly). Chose Workers
  AI for autonomy with zero new credentials; Ideogram/Recraft remain a future "premium mark" upgrade.
- **Light/dark responsive:** the mark is a self-contained rounded tile (reads on any theme); the app
  renders the wordmark text in the theme foreground colour (`Logo` component), so the lockup adapts
  to light/dark with no baked-in text and no second asset.
- **Storage decision:** assets are stored as compact PNG **data URIs** in `sites.favicon_url` /
  `sites.logo_url` (favicon 64px ≈ 2–4 KB, logo 96px ≈ 4–8 KB). Zero infra, no R2 egress dependency,
  served LIVE by `GET /site/brand` with **no redeploy**. (For very large asset libraries, swap to an
  R2/S3 upload from the Fly API — which can reach R2 — and store the URL instead.)
- **Applied live** to the 3 current clients (tamutraders, lucky7, invest254) and verified via the
  live API. Idempotent; `--force` regenerates; `--all` backfills any client missing assets.

**Automate at client creation (options):**
1. Call the generator from the `/platform/onboard` flow (best; needs a Fly API deploy to add the
   Workers AI call + DB write in TS — mirror `generate_for()`), OR
2. Run this script on a schedule/trigger that scans for `logo_url IS NULL` and backfills — fully
   autonomous, no API deploy. Recommended interim until the onboarding TS integration ships.

Env: `CF_ACCOUNT_ID`, `CF_WORKERS_AI_KEY`, `DATABASE_URL` (set as Fly secrets for the API path).
