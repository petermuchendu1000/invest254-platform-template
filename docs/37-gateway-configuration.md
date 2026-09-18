# 37 — Gateway configuration UI (encrypted credentials)

**Branch:** `feat/gateway-config-ui` · **Migration:** `0130_payment_provider_config.sql`

## Goal
Migration 0116 gave the superadmin a switch for **which** deposit gateways players see. This adds the
missing half — a dedicated, end-to-end console to **configure** each gateway's credentials + settings
(change an existing one, or set up a new one) without touching Fly env or redeploying. Ships config for
four gateways: **Mega Pay** (live), **Paystack**, **Binance Pay**, **PayHero** (registered + configurable;
their live deposit rails are a separate issue — the platform doesn't hold their API keys yet).

## Security model (defence in depth)
- Secret fields (api keys, secrets, basic-auth tokens) are encrypted with **AES-256-GCM in the engine**
  (`apps/engine/src/providercrypto.ts`) *before* they reach Postgres. The DB stores only ciphertext.
- The 32-byte key lives in the **`PAYMENTS_CONFIG_ENC_KEY`** Fly secret — **never in the DB**. A DB dump
  alone cannot reveal a single credential. GCM also tamper-detects: a modified ciphertext fails loudly.
- Non-secret settings (env, base url, email, channel id, callback url) are stored in plaintext `settings`.
- The console read (`fn_admin_get_provider_config`) returns settings + a **masked last-4 hint** only; the
  browser never receives a stored secret. Only the service-role engine path
  (`fn_provider_config_resolve`) sees ciphertext, and it still needs the env key to decrypt.
- Every write is **platform_superadmin-gated**, **audited** in `admin_actions` (no secret in the audit
  detail), and emits `pg_notify('payment_providers_changed')`.

## Model (migration 0130)
- `payment_provider_config(provider_code, site_id, settings jsonb, secret_ciphertext, secret_meta jsonb,
  enc_version, updated_by, updated_at, created_at)` — one **global** row per provider (`site_id null`)
  plus optional per-brand override rows (mirrors the 0116 enable/disable scoping; UI edits global today).
- Partial-unique indexes enforce one global row + one row per (provider, brand). RLS on, service-role only.
- Registers `paystack`/`binance`/`payhero` in `payment_providers` (hidden until switched on, like 0116).
- RPCs (SECURITY DEFINER, superadmin-gated / service-role): `fn_admin_get_provider_config`,
  `fn_platform_set_provider_config` (`secret_ciphertext` null=keep, ''=clear, '…'=replace),
  `fn_provider_config_resolve`.

## Field schema (single source of truth)
`apps/engine/src/gatewayschema.ts` declares each gateway's fields (grounded in the official docs) and
drives **both** backend validation **and** the UI form — no drift. Split into non-secret `settings` vs
encrypted `secrets`; `validateConfig` checks required/email/url/select/key-prefix and honours an
already-stored secret so a settings-only edit needs no re-typing.

## Safe "Test connection"
`apps/engine/src/gatewaytest.ts` runs a **read-only** probe per gateway so pressing Test can never move
money or fire an STK prompt: Mega Pay `POST /transactionstatus` (sentinel id), Paystack `GET /balance`,
PayHero `GET /payment_channels`, Binance `POST /order/query` (sentinel id — validates the HMAC signature).
It overlays unsaved draft values over stored config, so an admin can validate a new key before saving.

## API (superadmin, `apps/api/src/app.platform.ts`)
- `GET  /platform/payment-providers/config` — schema + masked config for all configurable gateways.
- `PUT  /platform/payment-providers/:code/config` — save one (flat `{field: value}`; blank secret = keep).
- `POST /platform/payment-providers/:code/config/test` — safe connectivity test (stored ∪ draft).

## Web (`/platform/config` → **Gateway configuration**)
`components/platform/GatewayConfig.tsx`: a card per gateway with a schema-driven form, password inputs
that show a `•••• last4 (leave blank to keep)` hint for stored secrets, client-side validation mirroring
the backend, **Save** + **Test connection**, and a coloured result banner. Sits directly under the
existing on/off switch matrix.

## Mega Pay live wiring (deliberately gated)
Config is stored + testable now. Making the live deposit client build from DB config (instead of the
boot-time env in `apps/api/src/server.ts`) is **behaviour-neutral by design** (env is the guaranteed
fallback; no DB row ⇒ unchanged) but it swaps the production money client, so it is left as an explicit,
reviewed opt-in rather than flipped automatically. See the PR description.

## Tests
- Engine unit (`providercrypto.test.ts`, `gatewayschema.test.ts`, `gatewaytest.test.ts`): key parse,
  encrypt↔decrypt round-trip, wrong-key/tamper rejection, masking, blank-drop; schema split/validate;
  every probe's valid/invalid/unreachable/not-configured mapping + deterministic Binance signature.
- API integration (`app.gatewayconfig.test.ts`): superadmin gating, schema+masked GET, encrypt-on-save
  with **no plaintext in the response**, settings-only keeps the secret, VALIDATION 400, **partial secret
  edit merges (never drops the other secret)**, non-configurable provider rejected, network-free test route.
- DB: migration + all RPC paths proven against live Supabase **inside a rolled-back transaction**
  (auth gate, masked read w/ no ciphertext leak, settings-only keep, clear, resolve, not-found).
