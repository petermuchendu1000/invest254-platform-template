# Invest254 — Hosting & Deployment Guide (Handoff)

> Read this end-to-end before changing anything deploy-related. It documents exactly how
> the production hosting is wired, the non-obvious gotchas, and how to operate it.
> **No secret values are in this file** — secrets live in Fly.io / Cloudflare / Supabase only.

_Last verified: 2026-08-15 (live probes: API `/site/brand`, engine WS `hello`+ticks per brand,
Fly app/IP list, Supabase `sites`). This is a **multi-tenant platform**: one API + one engine +
one database + one web build serve **every brand domain** (see docs/20–22)._

---

## 0. TL;DR — the mental model

This is an **npm-workspaces monorepo** with **three deployables on two platforms + one database**,
serving **many brand domains from one shared deployment** (multi-tenant; a brand = a `sites` row +
a domain):

| Component | Code | Hosted on | Public URL(s) — CANONICAL |
|-----------|------|-----------|---------------------------|
| Web frontend (Next.js 14) | `apps/web` | **Cloudflare Pages** project `invest254` | every brand domain → one build: `invest254.com`, `tamutraders.com`, `lucky7.co.ke`, … (+ `invest254.pages.dev`) |
| REST API (Node HTTP) | `apps/api` | **Fly.io** app **`invest254-api`** | **`https://invest254-api.fly.dev/api/v1`** |
| WebSocket game engine (Node `ws`) | `apps/engine` | **Fly.io** app **`invest254-engine-pm`** | **`wss://invest254-engine-pm.fly.dev`** |
| Postgres database | `packages/db` (migrations `0001`–`0057`) | **Supabase** | pooler host, project ref `yewujhbtfxeirhknckzg` (eu-west-1) |

**The single most important facts (do not break these):**
- A brand domain (e.g. `tamutraders.com`) is **ONLY the frontend** (Cloudflare Pages). Every brand
  domain points at the **same** Pages project; the brand is resolved at request time by host.
- The browser calls the **shared** API at `https://invest254-api.fly.dev/api/v1` and the **shared**
  WebSocket at `wss://invest254-engine-pm.fly.dev` — these are the SAME for every brand. Only the
  domain differs; the brand is carried by host / the JWT `site` claim / the WS `?site=`.
- ❌ There is **no** `<brand>.com/api`. Do **not** repoint the API host to a brand domain — that host
  is the static frontend and will 404.

> ⚠️ **Legacy apps that must NOT be used** (they predate multi-tenancy and still respond, which is a
> known source of confusion): `invest254` (`https://invest254.fly.dev` — old single-tenant API,
> `/api/v1/site/brand` returns 404) and `invest254-engine` (`wss://invest254-engine.fly.dev` — old
> single-tenant engine, ignores `?site=`). The live web does **not** use them. See §2.7.

Data flow:
```
Browser on ANY brand domain (Cloudflare Pages project "invest254")
   │   REST  → https://invest254-api.fly.dev/api/v1      (Fly app: invest254-api)
   │   WS    → wss://invest254-engine-pm.fly.dev/?site=… (Fly app: invest254-engine-pm)
   ▼
Fly.io apps (Node via tsx)  ──SQL──►  Supabase Postgres (pooler, sslmode=no-verify)
                                       one DB, every row tagged by site_id
```

---

## 1. Repository layout

```
invest254/                      # npm workspaces, Node >=20, TypeScript ESM, source-first (tsx)
├── packages/
│   ├── shared/                 # @invest254/shared — PRNG, curve, settlement, money, site helpers
│   └── db/migrations/          # 0001–0057 SQL migrations (idempotent), incl. multi-tenant 0044–0046
├── apps/
│   ├── engine/                 # @invest254/engine — authoritative multiplexed WS server (port 8080)
│   ├── api/                    # @invest254/api — REST transport over engine services (port 8081)
│   └── web/                    # @invest254/web — Next.js 14 frontend (→ Cloudflare Pages)
├── Dockerfile                  # backend image (engine + api), used by BOTH Fly apps
├── fly.api.toml                # Fly config for the API app    (app = "invest254-api")     ✅ CANONICAL
├── fly.engine.toml             # Fly config for the engine app (app = "invest254-engine-pm") ✅ CANONICAL
├── fly.toml                    # ⚠️ LEGACY (app = "invest254") — old single-tenant API; do NOT deploy with bare `fly deploy`
├── wrangler.toml               # Cloudflare Pages config (nodejs_compat, build output dir)
└── apps/web/wrangler.toml      # local wrangler for `wrangler pages dev` (not used by CF build)
```

Run modes are **source-first**: services run via `tsx` (no compile step). `npm start` in each
app = `node --import tsx src/server.ts`.

---

## 2. Fly.io — backend (API + engine)

### 2.1 Two apps, one Docker image
Both Fly apps build from the **same root `Dockerfile`**. Each app's `fly.*.toml` overrides the
start command via `[processes]`:
- **`invest254-api`**        → `npm -w @invest254/api start`     (REST, internal port **8081** → 443)
- **`invest254-engine-pm`**  → `npm -w @invest254/engine start`  (WS,   internal port **8080** → 443)

Region: **`jnb`** (Johannesburg — Fly's closest to Kenya). VM: `shared-cpu-1x`, 512 MB.

### 2.2 Why two apps (not one container with two ports)
Fly's **free shared IPv4 only routes ports 80/443**. A single app exposing the engine on a
custom port (8080) would need a **paid dedicated IPv4**. Splitting into two apps lets BOTH the
API and the WS run on port **443** (different hostnames) over the free shared IPv4. Each app's
`[http_service]` maps 443 → its internal port.

### 2.3 Public IPs
Both apps ride Fly's **free shared IPv4** on 443 (no dedicated IPv4 needed) plus a dedicated IPv6.
Current (verified 2026-08-15):
- `invest254-api`       → v4 `66.241.125.32` (shared), v6 `2a09:8280:1::157:cd75:0`
- `invest254-engine-pm` → v4 `66.241.125.5` (shared),  v6 `2a09:8280:1::15e:ac2b:0`

If an app ever shows **no IP** (unreachable), allocate: `fly ips allocate-v4 --shared -a <app>` and
`fly ips allocate-v6 -a <app>`. **Do not buy a dedicated IPv4** — not needed for 443-only traffic.

### 2.4 Secrets (set on BOTH apps via `fly secrets set -a <app> ...`)
Names only (values live in Fly):
- `DATABASE_URL` — Supabase **pooler** string, **must end with `?sslmode=no-verify`** (see §4.2)
- `SUPABASE_JWT_SECRET` — HS256 secret the API signs tokens with and both apps verify with
- `MASTER_SEED` — platform provably-fair master seed (hex); per-brand seeds are derived from it + `site_id`
- `CORS_ALLOWED_ORIGINS` (API, optional) — comma-separated; default `*`. When restricted, active brand
  domains are still auto-allowed (see §6).
- Support chat (API, optional): `CF_ACCOUNT_ID`, `CF_AI_API_TOKEN`, `GROQ_API_KEY` (or `SUPPORT_LLM_API_KEY`)
- Domain onboarding automation (API, optional): `CF_DNS_API_TOKEN`/`CF_API_TOKEN`, `CF_PAGES_PROJECT`,
  `NAMECHEAP_API_USER`/`NAMECHEAP_USERNAME`/`NAMECHEAP_API_KEY`/`NAMECHEAP_CLIENT_IP`
- (API, until M-Pesa go-live) `MPESA_CONSUMER_KEY/SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`

> Fail-closed: when `DATABASE_URL` is set, a JWT verifier is **required** or the process throws on boot.

### 2.5 Engine boot ordering + multi-brand resolution (critical gotchas)
`apps/engine/src/server.ts` does DB work **before** it opens the socket (per-site seed init +
crash recovery across all brands), so **any DB connection failure crashes the engine before it
listens**. If the engine won't stay up, **check the DB connection first** (`fly logs -a invest254-engine-pm`).

Brand resolution: a socket names its brand via `?site=<slug|domain|id>` (or Host); the engine binds
it to that brand and the JWT `site` claim must match. The current code resolves brands **live** on a
cache miss (`siteresolver.ts`), so a brand onboarded after boot works with **no restart**. ⚠️ If the
running deploy predates that change, a brand added after the engine last booted returns
`1008 "unknown site"` until you **restart the engine** (`fly machine restart <id> -a invest254-engine-pm`),
which re-reads `sites` at boot. Deploy the current build to make restarts unnecessary.

### 2.6 Common ops (use the -c flag — do NOT rely on bare `fly deploy`)
```bash
fly deploy -c fly.api.toml               # deploy the REST API  → invest254-api
fly deploy -c fly.engine.toml            # deploy the WS engine → invest254-engine-pm
fly secrets set -a invest254-api KEY="value"          # set an API secret (auto-redeploys)
fly status -a invest254-api ;        fly logs -a invest254-api
fly status -a invest254-engine-pm ;  fly logs -a invest254-engine-pm
fly machine restart <id> -a invest254-engine-pm       # rolling restart (per machine)
```
> ⚠️ Bare `fly deploy` uses the root `fly.toml`, whose `app = "invest254"` targets the **legacy**
> single-tenant API — not the live `invest254-api`. Always pass `-c fly.api.toml` / `-c fly.engine.toml`.

### 2.7 Legacy / deprecated apps (do not use — decommission)
| App | URL | What it is | Status |
|-----|-----|------------|--------|
| `invest254` | `https://invest254.fly.dev/api/v1` | OLD single-tenant API (no `/site/brand`, returns 404) | ⛔ legacy, orphaned |
| `invest254-engine` | `wss://invest254-engine.fly.dev` | OLD single-tenant engine (ignores `?site=`, `hello site=""`) | ⛔ legacy, orphaned |

The live web is baked to the **canonical** pair (`invest254-api`, `invest254-engine-pm`). The legacy
apps still respond, which has caused confusion; they should be shut down once confirmed unused.

---

## 3. Cloudflare Pages — frontend (`apps/web`)

One Pages **project `invest254`** builds once and serves **all** brand domains. Adding a brand is
"data entry + DNS" (a `sites` row + a Pages custom domain), automated by onboarding — see docs/21.

### 3.1 Project build settings (monorepo)
| Setting | Value |
|---------|-------|
| Production branch | `main` |
| Framework preset | **None** |
| Build command | `npm install && npm -w @invest254/web run pages:build` |
| Build output directory | `apps/web/.vercel/output/static` |
| Root directory | `/` (repo root — required so the `@invest254/shared` workspace resolves) |

> Do **not** set Root directory to `apps/web` — that breaks the workspace install of `@invest254/shared`.
> `pages:build` runs `@cloudflare/next-on-pages` which runs `vercel build` → `next build`.

### 3.2 Environment variables (Production AND Preview)
These are `NEXT_PUBLIC_*` → **inlined at BUILD time**. They must exist *before* a build, and a
**rebuild is required** after changing them. If missing, the app falls back to
`http://localhost:8081` / `ws://localhost:8080` (which breaks login). Same values for every brand:
```
NEXT_PUBLIC_API_BASE_URL = https://invest254-api.fly.dev/api/v1
NEXT_PUBLIC_WS_URL       = wss://invest254-engine-pm.fly.dev
NODE_VERSION             = 20
```

### 3.3 Compatibility flags (via root `wrangler.toml`)
`@cloudflare/next-on-pages` requires the `nodejs_compat` flag at runtime, set via the **root
`wrangler.toml`** (Cloudflare reads it because Root directory = `/`):
```toml
name = "invest254"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = "apps/web/.vercel/output/static"
```
While `wrangler.toml` manages config, the dashboard Runtime settings become read-only (expected).

### 3.4 Custom domains (per brand)
Each brand's apex (and `www`) is attached to the Pages project as a **Custom domain** (Cloudflare
CNAME-flattens the apex and issues SSL). The onboarding flow (docs/21, `scripts/onboard_client.ts` /
`POST /platform/onboard`) can automate the zone + DNS + Pages custom-domain attach when a
Pages-scoped Cloudflare token is configured. `www.<brand>` resolves to the same brand as the apex.

### 3.5 Redeploy
Pages → **Deployments → Retry deployment** (or push to `main`; auto-deploys are enabled). Note: a
push to the connected repo's `main` triggers a production Pages rebuild.

---

## 4. Supabase — database

### 4.1 Connection
- Project ref: `yewujhbtfxeirhknckzg`, region `eu-west-1`.
- Use the **pooler** host `aws-0-eu-west-1.pooler.supabase.com`, user `postgres.<ref>`, db `postgres`.
- Session pooler **port 5432** is fine for the long-running Fly servers (6543 transaction mode also works).
- Migrations `0001`–`0057` are applied (incl. multi-tenant `0044` sites / `0045` site_id scoping /
  `0046` per-site game config, and support-chat `0057`). Re-runnable (idempotent).

### 4.2 SSL gotcha (this caused the login 500)
`node-postgres` verifies the TLS CA when the string says `sslmode=require`, and Supabase's chain
fails Node's check → `self-signed certificate in certificate chain`. The code calls
`new Pool({ connectionString })` with no `ssl` object, so the **connection string must use
`?sslmode=no-verify`** on BOTH Fly apps.
- ✅ `...:5432/postgres?sslmode=no-verify`
- ❌ `...:5432/postgres?sslmode=require`
- Future hardening (optional): bundle Supabase's CA cert and use full verification (needs a code change).

### 4.3 Superadmin bootstrap
Roles are `player < marketer < admin < superadmin < platform_superadmin` (see `apps/api/src/http.ts`
`ROLE_RANK`). The cross-brand platform owner is **`platform_superadmin`**; a per-brand owner is
`superadmin` (scoped by the JWT `site` claim). Prefer the bootstrap script:
```bash
node --import tsx scripts/make_operator.ts   # promotes + verifies login mints the right role/site
```
Or by SQL (note the correct role names — NOT `super_admin`):
```sql
update public.profiles set role = 'platform_superadmin' where phone = '+2547XXXXXXXX';   -- platform owner
-- per-brand owner: set role = 'superadmin' for the account whose profiles.site_id is that brand
```

### 4.4 PL/pgSQL "ambiguous column" gotcha
RPCs declared `RETURNS TABLE(user_id ...)` collide with a `user_id` table column → qualify table
columns (e.g. `wallets.user_id`); do NOT rename output columns (the engine reads them by name).

---

## 5. DNS & domains (multi-brand)

Every brand domain is registered (Namecheap) and its **nameservers moved to Cloudflare**, then the
apex + `www` are attached to the `invest254` Pages project (CNAME-flattened, auto-SSL). Keep any
email-forwarding MX/SPF records when clearing registrar parking records.

- Example (verified live): `tamutraders.com` → Cloudflare zone → Pages custom domain → resolves to
  the Tamu Traders brand (`sites.primary_domain = tamutraders.com`, `site_id 47e2ab1f…`).
- Onboarding automates zone creation + nameserver switch + DNS + Pages attach when the Cloudflare
  (Pages+DNS) and Namecheap credentials are configured — see docs/21. Without them, the same steps
  are done manually; the script prints the exact records.
- `www.<brand>` should be added as a second custom domain (and folds to the apex brand server-side).

### Client-side DNS note
Browsers cache negative (NXDOMAIN) answers. After DNS changes, Chrome may still fail while other
browsers work — fix with `chrome://net-internals/#dns` → "Clear host cache" (and `ipconfig /flushdns`).

---

## 6. CORS (multi-tenant, brand-aware)

`apps/api/src/http.ts` applies CORS on every request and answers preflight before routing.
`CORS_ALLOWED_ORIGINS` (comma-separated) defaults to `*` (echoes the request Origin). Auth is a
Bearer token (not cookies), so `*` is safe. **When you restrict the list** (defence-in-depth), the
API additionally allows any **active brand domain** automatically (apex + `www`), backed by an
in-memory, periodically-refreshed view of `sites` (`apps/api/src/cors.ts`) — so hardening CORS never
locks a client out and you never have to hand-maintain the list as brands are onboarded.

---

## 7. Current verified status (2026-08-15)

- ✅ Web (Cloudflare Pages `invest254`) serves brand domains; bundle is baked to
  `https://invest254-api.fly.dev/api/v1` and `wss://invest254-engine-pm.fly.dev`.
- ✅ `https://invest254-api.fly.dev/api/v1/health` → `200`; `/site/brand?host=tamutraders.com`
  resolves the Tamu Traders brand.
- ✅ `wss://invest254-engine-pm.fly.dev` streams `hello`+ticks per brand for `invest254`,
  `tamutraders`, `lucky7` (region jnb).
- ✅ Supabase reachable; migrations applied through `0057`; 3 active brands in `sites`.

### Outstanding / TODO
1. **Decommission the legacy Fly apps** `invest254` and `invest254-engine` (see §2.7) once confirmed unused.
2. Deploy the current engine build everywhere so new brands resolve live (no restart) — see §2.5.
3. (Security) Rotate all credentials shared during development (Supabase DB password, Fly/Cloudflare/
   Namecheap/Groq tokens, GitHub PAT) and update `DATABASE_URL` on both Fly apps.
4. Add `www.<brand>` custom domains + `www → apex` redirects for each brand.
5. (Hardening) Move DB TLS from `no-verify` to full CA verification (bundle Supabase CA; small code change).
6. Configure M-Pesa Daraja secrets on the API app before real deposits/withdrawals.
7. Consider stable custom API/WS hostnames (e.g. `api.invest254.com`, `ws.invest254.com`) to decouple
   the web build from the Fly app names (which caused past confusion).

---

## 8. Quick reference — "where does X live?"

| Question | Answer |
|----------|--------|
| Where do users go? | Any brand domain (e.g. `https://tamutraders.com`) — all served by the one Cloudflare Pages project `invest254` |
| Where is the REST API? | `https://invest254-api.fly.dev/api/v1` (Fly `invest254-api`) — shared by all brands |
| Where is the WebSocket? | `wss://invest254-engine-pm.fly.dev` (Fly `invest254-engine-pm`) — shared by all brands |
| Where is the DB? | Supabase pooler, ref `yewujhbtfxeirhknckzg`, `?sslmode=no-verify` (one DB, `site_id`-scoped) |
| How does a brand get selected? | By host (`/site/brand?host=`), the JWT `site` claim, and the WS `?site=` |
| How does the frontend know the API/WS URL? | `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_WS_URL` baked at Cloudflare build time |
| How do I deploy? | `fly deploy -c fly.api.toml` (API) and `fly deploy -c fly.engine.toml` (engine) — never bare `fly deploy` |
| Which apps are legacy? | `invest254` (`invest254.fly.dev`) and `invest254-engine` (`invest254-engine.fly.dev`) — do not use (§2.7) |
| A new brand can't reach the live market? | The engine must know it: current code resolves live; older deploys need `fly machine restart -a invest254-engine-pm` (§2.5) |
