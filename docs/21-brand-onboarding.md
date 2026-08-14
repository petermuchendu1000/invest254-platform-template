# 21 — Brand Onboarding ("launch website #7")

> Everything an operator does to stand up a new branded website on the platform, plus a full
> reference of every brand variable and where it lives. In multi-tenant, this is mostly
> **data entry + DNS**, not code.

---

## 0. Automated one-shot onboarding (fastest path)

A superadmin supplies one JSON config and the client is created **instantly**:

```
DATABASE_URL=... CF_ACCOUNT_ID=... GROQ_API_KEY=... \
  node --import tsx scripts/onboard_client.ts scripts/onboard.example.json
```

`scripts/onboard_client.ts` performs Steps 1-2 below in a single, idempotent (by slug) operation:
it upserts the `sites` row and `site_game_config`, points the brand at its `primaryDomain`, then
self-verifies that (a) the brand resolves by host and (b) the support-chat pipeline answers for the
new brand (the shared knowledge base works immediately; per-brand overrides are optional). The
config accepts `slug, name, primaryDomain, currency, locale, theme, colors, wordmarkText,
licenceLine, supportEmail, game{...}` and an optional `verify.question`.

The one step outside the database is DNS (Step 4). The script prints it, and can **automate the
Cloudflare Pages custom-domain attach + CNAME** when the config includes `cloudflare.pagesProject`
(optionally `zoneId` + `cnameTarget`) and a Pages-scoped `CF_PAGES_API_TOKEN` is set (the
Workers-AI token cannot attach domains). Secrets (Step 3) and the operator bootstrap (Step 5) remain
deliberate, security-sensitive actions.

The manual/SQL breakdown of each step follows.

---

## 1. The 6-step launch

### Step 1 — Create the `sites` row (the brand)
Insert one row (via the platform-superadmin console, or SQL as `service_role`):

```sql
insert into public.sites (slug, name, primary_domain, currency, locale,
  color_primary, color_bg, color_accent, theme, wordmark_text, licence_line, support_email,
  mpesa_env, mpesa_shortcode, mpesa_callback_base, master_seed_ref, status)
values ('lucky7', 'Lucky7', 'lucky7.co.ke', 'KES', 'en-KE',
  '#f59e0b', '#0a0a0a', '#06b6d4', 'dark', 'lucky7.co.ke',
  'Lucky7 operates under licence No. XXXX (BCLB).', 'support@lucky7.co.ke',
  'sandbox', '', 'https://api.<platform>.fly.dev/s/lucky7',
  'MASTER_SEED_LUCKY7', 'active');
```
The `id` (uuid) it returns is the site's `site_id` used everywhere else.

### Step 2 — Set the brand's game economy
Insert its `site_game_config` (or accept the seeded defaults, then tune in the console):

```sql
insert into public.site_game_config (site_id, house_edge, max_multiplier,
  min_stake, max_stake, min_withdrawal, default_duration_s, tick_rate_ms,
  drift_bias, volatility, target_win_rate)
values ('<site_id>', 0.75, 5.0, 25000, 5000000, 25000, 10, 150, 0.30, 1.0, 0.125);
```

### Step 3 — Store the brand's secrets (by reference)
The `sites` row holds **key names**, not secret values. Put the real values in the platform
secret store (Fly secrets), named to match:

```bash
fly secrets set -a <platform-api>    MASTER_SEED_LUCKY7="<hex>" \
  MPESA_CONSUMER_KEY_LUCKY7="..." MPESA_CONSUMER_SECRET_LUCKY7="..." \
  MPESA_PASSKEY_LUCKY7="..." MPESA_B2C_CREDENTIAL_LUCKY7="..."
fly secrets set -a <platform-engine> MASTER_SEED_LUCKY7="<hex>"
```
The API/engine resolve `sites.master_seed_ref` → `process.env[that_name]`.

### Step 4 — Point the domain at the platform
- Add `lucky7.co.ke` as a **custom domain** on the same Cloudflare Pages web project (many
  domains → one project). Cloudflare issues SSL.
- Set the brand's M-Pesa **callback URLs** at Daraja to `…/s/lucky7/deposits/mpesa/callback`
  and `…/s/lucky7/withdrawals/mpesa/result/:txId` (the `/s/<slug>` prefix resolves the site).

### Step 5 — Bootstrap the site's operator
Register a normal account on `lucky7.co.ke`, then promote it (once) to the brand's admin.
Fastest path is the reusable script (registers or resets, sets the role, verifies login):

```
DATABASE_URL=... node --import tsx scripts/make_operator.ts <phone> <password> [role] [siteId]
# e.g. platform owner:  scripts/make_operator.ts 0798661061 '<pw>' platform_superadmin
```

Or by SQL:

```sql
update public.profiles set role = 'site_superadmin'
where site_id = '<site_id>' and phone = '+2547XXXXXXXX';
-- optionally record ownership on the site
update public.sites set owner_user_id = (select id from public.profiles
  where site_id = '<site_id>' and phone = '+2547XXXXXXXX') where id = '<site_id>';
```

### Step 6 — Smoke test
Open `lucky7.co.ke` → brand renders (logo/colours/name), curve ticks over WS, register →
deposit (sandbox STK) → play → settle → withdraw. Confirm the platform-superadmin console
lists Lucky7 with live KPIs. Done — the brand is live, tracked, and override-able centrally.

---

## 2. Full brand-variable reference

| Variable | Where it lives | Runtime? | Notes |
|---|---|---|---|
| Site name / wordmark | `sites.name` / `sites.wordmark_text` | ✅ no redeploy | Top bar + titles |
| Logo / favicon | `sites.logo_url` / `favicon_url` (object storage) | ✅ | Swap per brand |
| Brand colours | `sites.color_primary/bg/accent` → CSS vars | ✅ | Instant re-skin |
| Theme | `sites.theme` (dark/light/auto) | ✅ | |
| Domain(s) | `sites.primary_domain` + Cloudflare custom domains | DNS | Many domains → one brand allowed |
| Currency / locale | `sites.currency` / `sites.locale` | ✅ | KES today; ready for others |
| Licence line / legal copy | `sites.licence_line` / `sites.legal_copy` (jsonb) | ✅ | Compliance per brand |
| Support email | `sites.support_email` | ✅ | |
| Game economy | `site_game_config` (RTP, stakes, ×cap, tick, drift, win rate) | ✅ live-reload | Per brand |
| M-Pesa routing | `sites.mpesa_*` (values by ref in secret store) | secrets | Per-brand paybill/B2C |
| Fairness seed | `sites.master_seed_ref` → secret | secrets | Independent lineage per brand |
| Per-user overrides | `user_overrides(site_id, user_id, …)` | ✅ next round | The override console |

**Rule of thumb:** change-without-redeploy → DB (`sites` / `site_game_config`). Hard secrets
(passkeys, seeds) → secret store, referenced by name from the `sites` row. Never hard-code a
brand value in the app.

---

## 3. Web env (per deployment, not per brand)

`apps/web/.env` (baked at Cloudflare build; the SAME values for all brands since one project
serves them all):

```
NEXT_PUBLIC_API_BASE_URL = https://<platform-api>.fly.dev/api/v1
NEXT_PUBLIC_WS_URL       = wss://<platform-engine>.fly.dev
NEXT_PUBLIC_DEFAULT_SITE_SLUG = invest254   # fallback only; real brand resolved by host
NODE_VERSION             = 20
```
The brand itself is resolved at runtime by host via `GET /api/v1/site/brand?host=…`
(`apps/web/src/lib/brand/brand.ts`), so adding a brand needs **no web rebuild**.

---

## 4. Backend env (platform-wide)

Inherited from single-tenant, now platform-scoped:

```
DATABASE_URL          = <supabase pooler>?sslmode=no-verify   # the ONE central DB
SUPABASE_JWT_SECRET   = <hs256 secret>                         # tokens carry the `site` claim
MASTER_SEED           = <platform default seed>                # used when a site has no master_seed_ref
# Per-brand secrets are added as named vars (see Step 3) and resolved via sites.*_ref.
```
