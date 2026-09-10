# 35 — Switchable Payment Gateways + Mega Pay deposit rail

**Branch:** `feat/megapay-gateway` · **Migration:** `0116_payment_providers_and_megapay.sql`

## Goal
Let the platform_superadmin choose **which deposit gateways players see** — globally for all clients
or overridden per client — and add **Mega Pay** as the first switchable gateway alongside Daraja
(M-Pesa). Multiple gateways may be enabled at once; each enabled one becomes a tab on the deposit sheet.

## Model (migration 0116)
- `payment_providers` — registry with a platform-global switch (`enabled_global`). Seeded
  `mpesa` (Daraja) **ON** (behaviour-neutral: the existing rail is unchanged) and `megapay` **OFF**.
- `site_payment_providers` — per-brand override. A row **forces** enabled true/false for one client;
  absent = inherit the global switch. Effective = `coalesce(override.enabled, provider.enabled_global)`.
- RPCs (service-role only, platform_superadmin-gated, audited in `admin_actions`, `pg_notify`
  `payment_providers_changed`):
  `fn_list_effective_providers(site)`, `fn_admin_list_providers`, `fn_platform_set_provider_global`,
  `fn_platform_set_provider_site`, `fn_platform_clear_provider_site`, and a provider-aware
  `fn_create_deposit_provider(user, amount, phone, site, provider)`.

## Mega Pay rail (reuses the proven money path)
- Client `apps/engine/src/megapay.ts` mirrors `daraja.ts`: `StubMegaPayClient` (deterministic, tests),
  `HttpMegaPayClient` (real), `UnconfiguredMegaPayClient` (fails loudly in production when creds are
  missing — never a silent stub that could phantom-credit).
- A Mega Pay deposit stores its `transaction_request_id` in `transactions.checkout_request_id` and
  settles through the **same idempotent `fn_complete_deposit`** as Daraja — money correctness unchanged.
- `PaymentService`: `initiateMegaPayDeposit`, `handleMegaPayCallback` (ALWAYS re-queries Mega Pay
  server-to-server before crediting — forged callbacks can't mint balance), `reconcileMegaPayDeposits`
  (own sweep, provider-scoped), `listDepositProviders` (fail-open to M-Pesa).
- **Rail isolation:** `listUnsettledDeposits` is now provider-scoped; the Daraja reconcile passes
  `'mpesa'` and the Mega Pay reconcile passes `'megapay'`, so neither queries the other's ids.

## API
- Player: `GET /deposits/providers`, `POST /deposits/megapay` (server-authoritative enable check —
  a client can't deposit through a gateway that's switched off), `POST /deposits/megapay/callback`
  (+ `/s/:slug/...`) — one webhook URL for all brands (the `transaction_request_id` resolves the brand).
- Superadmin: `GET /platform/payment-providers`, `POST /platform/payment-providers/:code/global`,
  `POST /platform/payment-providers/:code/site` (`enabled:null` clears the override).

## Web
- Deposit page (`DepositPanel`): a "Mega Pay" tab appears only when effective-enabled for the brand;
  reuses `DepositForm` (identical STK UX) parametrised by provider.
- Superadmin console (`/platform/config` → **Payment gateways**): global on/off per provider + a
  per-client Inherit/On/Off override editor.

## Webhook URL (give to Mega Pay for BETWOIN LTD)
```
https://invest254-api.fly.dev/api/v1/deposits/megapay/callback
```

## Config (Fly secrets, production)
`MEGAPAY_API_KEY`, `MEGAPAY_EMAIL`, `MEGAPAY_ENV=production`, optional `MEGAPAY_API_BASE`,
optional `MEGAPAY_CALLBACK_ALLOWED_CIDRS`. Sandbox test key runs fully offline of real money.

## Tests
- Engine: `megapay.test.ts` (status mapping, real-shape HTTP client via fake fetch, credit +
  idempotency, callback never trusts the wire, rail isolation, fail-open, unconfigured refusal).
- API: `app.megapay.test.ts` (provider list, deposit 202 → webhook credit, floor/junk rejection,
  disabled-gateway 403, callback 400, superadmin gating + global/per-site toggles).
- Live DB: money path proven against Supabase inside a rolled-back transaction.
- Live sandbox: `HttpMegaPayClient` verified end-to-end against Mega Pay (initiate → complete → status).
- Full suite: **848/848** unit tests pass; `tsc -b` + web typecheck clean.

## Player-facing UX (gateway is hidden)
Players never see the gateway brand. The deposit sheet renders whatever gateway(s) the superadmin
switched on (the `mpesa` toggle governs the Daraja STK + Pay Bill rails; `megapay` governs Mega Pay),
and the primary action is a simple **"Continue to Pay"** — no "Mega Pay"/"Daraja" wording. With a
single gateway enabled the method tab-bar is hidden entirely.

## STK prompt text (what we can vs. can't control)
The M-Pesa prompt reads: *"pay Kshs X to `<BUSINESS>` Account no. `<REFERENCE>`"*.
- **`<REFERENCE>` (Account no.)** — we control it: the Mega Pay `reference` (and Daraja
  `AccountReference`) is the depositing brand's **site name** (`sites.name`, e.g. `TamuTraders`),
  resolved per request via `accountRefForSite(siteId)` → `resolveAccountRef` (alphanumeric, ≤12).
- **`<BUSINESS>`** — NOT settable via the API (initiate accepts only api_key/email/amount/msisdn/
  reference). It is the till/paybill name registered on the provider's side. To display "BETWOIN LTD"
  instead of the provider's onboarding name, it must be changed in the **Mega Pay merchant account**.
