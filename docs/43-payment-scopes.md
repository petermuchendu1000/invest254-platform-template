# 43 — Payment scopes: per-platform and per-brand gateway accounts (PAY-1)

Owner decision (2026-09-23): *"platform admins should be able to edit platform M-Pesa / any payment gateway
configs for the whole platform as for a single brand. The changes must be respected by the live payments."*

## 1. Today (before PAY-1)

- Live M-Pesa (STK, STK verification, reconcile, B2C payouts, affiliate B2C) uses ONE process-wide Daraja
  client built from the `mpesa_config` singleton over env (`DarajaConfigStore`).
- Mega Pay / PayHero read only the GLOBAL `payment_provider_config` row (`siteId` hard-coded to null).
- `payment_provider_config` supports per-site rows, but no route writes them and no payment reads them.
- `sites.mpesa_*` columns are editable by platform admins but are never read at payment time.
- Every gateway-config route is System-owner only.

## 2. Model

A **payment scope** is whose payment accounts a brand's money flows through:

| Scope | Owner | Stored in |
|---|---|---|
| `global` | the System owner (default for every brand) | `mpesa_config` + env (M-Pesa); `payment_provider_config` rows with no site/platform (other gateways) |
| `platform:<id>` | a platform (its platform admin) | `payment_provider_config` rows with `platform_id` |
| `site:<id>` | one brand | `payment_provider_config` rows with `site_id` |

Each non-global scope has an explicit **Go-live switch** (`payment_scopes.active`). While inactive, the configs
are drafts: stored, testable, never used by live payments.

**A brand's payment owner** = its own scope if active, else its platform's scope if active, else `global`.

## 3. Money-safety invariants (enforced in code, tested)

1. **No mixing across owners.** Every money flow for a brand (all deposit rails and all payouts) uses the
   configs of that brand's ONE payment owner. A gateway the owner has not configured is **unavailable** for
   the brand. It never falls back to a parent's (e.g. the System owner's) account. Otherwise a platform's
   deposits could land in its own account while its payouts are paid from the owner's B2C.
2. **Payouts follow the owner.** B2C withdrawals (and affiliate B2C payouts) use the payment owner's M-Pesa
   B2C credentials at approval time. If they are missing, the payout fails loudly (`MPESA_B2C_NOT_CONFIGURED`);
   there is no fallback.
3. **Verification uses the initiating scope.** The scope is recorded on every provider transaction
   (`transactions.payment_scope`) at initiation. STK callback verification, Mega Pay / PayHero status checks
   and the reconcile sweeps use THAT scope's client, never "whatever is live now".
4. **A platform admin cannot redirect verification.** Fields that choose WHERE we talk to or listen from
   (environment=sandbox, API base URLs, callback URLs, callback CIDR allow-lists) are **System-owner only**.
   Otherwise a platform admin could point status queries at a server that reports fake "Completed" payments.
   A platform admin's M-Pesa/Mega Pay configs are production-only.
5. **Go-live needs a complete payout path.** A non-global scope can only be activated when its M-Pesa config
   is complete for B2C, or the operator explicitly confirms "deposits only, payouts disabled". Every
   activation and deactivation is audited and notifies the System owner.
6. **Manual Pay Bill (C2B) is global-only.** C2B confirmations only arrive for the System owner's registered
   paybill. For a brand whose owner is not `global`, the manual Pay Bill rail is hidden and claims are refused.
   Otherwise its players would be told to pay the owner's paybill.
7. **Secrets are write-only.** Secrets are encrypted with AES-256-GCM (`PAYMENTS_CONFIG_ENC_KEY`), only
   `{set, last4}` metadata is returned, a blank value keeps the stored one, and nothing is logged.

## 4. Permissions

| Action | System owner | Platform admin | Site admin |
|---|---|---|---|
| Edit global configs | ✓ | — | — |
| Edit own platform's / own brands' configs | ✓ (any) | ✓ (own platform only) | — |
| Owner-only fields (sandbox env, base URLs, callback URLs, CIDRs) | ✓ | — | — |
| Activate / deactivate a scope | ✓ | ✓ (own) | — |
| Grant gateway entitlements (sell add-ons) | ✓ | — | — |
| Enable/disable an entitled gateway for a brand | ✓ | ✓ (own brands) | — |

Scope is enforced in the database (`fn_payment_scope_assert`) and in the API (a platform admin is pinned to
its own platform).

## 5. Resolution at payment time

```
ownerScope(site) = site if active → platform(site) if active → global
deposit(site, gateway):  scope = ownerScope(site); cfg = config(scope, gateway) (global: legacy sources)
                         incomplete / absent → gateway not offered; initiation refuses GATEWAY_NOT_CONFIGURED
                         tx.payment_scope = scope
verify/reconcile(tx):    client(tx.payment_scope ?? 'global', tx.provider)
payout(tx):              scope = ownerScope(tx.site); B2C from config(scope, mpesa) or MPESA_B2C_NOT_CONFIGURED
```

Clients are cached per `(scope, gateway, config fingerprint)` and are invalidated by
`NOTIFY payment_providers_changed` / `payment_scopes_changed`, with a 30 s TTL as a backstop.

## 6. Out of scope (documented limits)

- Automatic C2B URL registration for platform shortcodes (the manual Pay Bill rail stays global-only).
- Settlement between the System owner and a platform for balances funded before a switch. A payout uses
  the owner scope at approval time; the audit trail records every switch.

## 7. Implementation (2026-09-23)

| Layer | Where |
|---|---|
| Storage + authorization | migration `0160_payment_scopes.sql` — `payment_provider_config.platform_id`, `payment_scopes`, `transactions.payment_scope`, `fn_payment_scope_assert`, `fn_provider_config_{get,set,clear,resolve}_scoped`, `fn_payment_scope_set_active` (audited + notifies the owner), `fn_payment_owner_scope`, owner-only-field guard; legacy global RPCs made blind to platform rows |
| Engine | `apps/engine/src/paymentscopes.ts` — `PaymentScopeService` (console + `GatewayRouter`), scoped M-Pesa schema, `ScopedDarajaClient`, `buildScopedClients` (never env / stub / parent scope); `PaymentService` + `AffiliateService` route every flow by owner scope, stamp `payment_scope`, verify with the recorded scope, refuse payouts before approval, hide the System Pay Bill |
| API | `apps/api/src/app.paymentscopes.ts` (`/platform/payment-scopes…`, platform-admin fenced), server wiring with LISTEN invalidation (`payment_scopes_changed`, `payment_providers_changed`, `mpesa_config_changed`) |
| Web | `/platform/payment-accounts` (`PaymentAccounts.tsx`), capability `console.payment_accounts`; the brand page's legacy M-Pesa fields (never read by payments) replaced by a link |

**Tests:** `e2e_payment_scopes.py` (63: scope authz, owner-only fields, write-only secrets, legacy blindness,
owner resolution, switches, notifications, grants, idempotency); `paymentscopes.test.ts` (11: every money
invariant through the real PaymentService + scoped Daraja client); `paymentscopes.pg.test.ts` (real schema:
deposit → stamp → verify after switch-back → credit once → B2C from the platform); `app.paymentscopes.pay1.test.ts`
(API scope, validation, go-live rules); F-44 matrix + capability contract extended; browser role e2e (+11).
