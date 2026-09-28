# 49 — Deposit channels (server-declared) + PayHero rail audit

**Status:** deposit-channel fix landed; the production issues in §4 are open.

## 1. Why this exists

The deposit sheet used to infer its tabs from **provider codes** (`DepositPanel` did
`providers.some(p => p.code === 'payhero')`). A gateway being effective-enabled does **not** mean
every one of its channels works, so the sheet could offer a payment method the server would then
refuse. Concretely, on the 12 MUCHENDU brands (PayHero is their only gateway) it rendered a
**"Card & Bank"** tab even though `lipwa_url` is unset — submitting threw
`PAYHERO_LIPWA_NOT_CONFIGURED`.

## 2. The model — the server declares channels, the client renders them

`GET /api/v1/deposits/providers` now returns both:

```jsonc
{
  "providers": [ { "code": "payhero", "displayName": "PayHero" } ],   // effective gateways (0116) — compat
  "methods":   [ { "id": "payhero-stk", "provider": "payhero", "channel": "stk", "label": "M-Pesa" } ]
}
```

`methods` is the **only** thing the sheet renders. Built by `PaymentService.listDepositMethods()`:

| Channel | Offered when | Label |
|---|---|---|
| `stk` | one per effective-enabled gateway | `M-Pesa`, numbered `M-Pesa (n)` if several |
| `lipwa` | PayHero enabled **and** a client is configured **and** `lipwa_url` is set (probed via `lipwaLink`) | `Card & Bank` |
| `paybill` | M-Pesa is a live rail **and** `paybillConfig().enabled` (false for a brand on its own accounts) | `Pay Bill` |

Rules preserved from `docs/35`: the **gateway brand is never shown** to players, and with a single
method the tab strip is hidden entirely. The platform `deposits` kill-switch now returns
`methods: []` (HTTP 200) so the sheet shows its normal unavailable state instead of offering tabs
that every deposit POST would refuse with `SYSTEM_DISABLED`.

Readiness probes mirror **every** precondition the initiate call enforces — including that
`payheroForScope` returns a stub rather than throwing when no client is configured, which is why
`initiateLipwaDeposit` guards on `!this.payhero` first. Any probe failure omits that channel and
never breaks the sheet.

Tests: `apps/engine/src/paymentservice.depositmethods.test.ts` (9 cases, built from the real brand
configurations) and `apps/api/src/app.depositmethods.test.ts` (4 cases, contract + kill-switch).

## 3. PayHero rail reality — deposits only

**PayHero cannot pay out.** Its client interface (`payhero.ts`) is `initiateStk`, `queryStatus`,
`listInboundPayments`, `lipwaLink` — there is no payout/B2C method, and `paymentscopes.ts` hard-codes
`payoutsReady: false` for it (same for `megapay`).

The **only** outbound money path in the codebase is **Daraja B2C** (`daraja.ts#b2cPayment`); the
dispatch variable in `approveWithdrawal` is statically typed `DarajaClient`. `fn_create_withdrawal`
also hard-codes `provider = 'mpesa'` on every withdrawal row, so `transactions.provider` cannot be
used to attribute payouts.

> **Operational consequence:** deposits run on PayHero while payouts run on Safaricom Daraja. If the
> Daraja B2C credentials are ever retired, approved withdrawals fail with
> `MPESA_B2C_NOT_CONFIGURED` **after** `fn_create_withdrawal` has already debited the player.

## 4. Open production issues found during this audit

| # | Issue | Evidence | Fix |
|---|---|---|---|
| 1 | ~~78 PayHero deposits stranded `pending` (KES 29,511)~~ — **RESOLVED, no money was owed** | All 78 had `checkout_request_id IS NULL`, and the row is created *before* `initiateStk`, so the PayHero call threw and **no STK prompt ever reached a player**. PayHero's own ledger holds **20 rows, all dated 2026-09-28** (`num_pages: 1`) — nothing in the 09-18→09-26 window. `ledger_entries` for those txs: **0**, so no wallet impact. | Closed out to `status='failed'`, `result_desc='cleanup:payhero_initiate_failed…'` (78 rows, no money moved) |
| 2 | **`surewinfx` has no deposit path at all** | effective `megapay`, entitled `[mpesa]` → empty intersection; non-global owner scope returns the filtered list and never reaches the M-Pesa fallback | **OPEN — billing decision.** NDUATI is `billing_exempt=false`, so granting `megapay` raises a real KES 10,000 `billing_charges` row |
| 3 | ~~`betyangu` falls back to a dead `mpesa` rail~~ — **FIXED** | effective `payhero`, entitled `[mpesa]` → empty intersection. Root cause: `payhero` was **missing from `addon_catalog`**, so `fn_addon_grant` raised `ADDON_NOT_FOUND` and it could never be entitled | migration `0171` adds the catalog row; entitlement granted (MUCHENDU is `billing_exempt=true` ⇒ **0 charges**) |
| 4 | **NDUATI brands cannot withdraw** despite `sites.withdrawals_enabled=true` | `payment_scopes.payouts_enabled=false` → `MPESA_B2C_NOT_CONFIGURED` | **OPEN** — set payouts config, and surface the real state in admin |
| 5 | ~~"Real M-Pesa payouts ~11% success"~~ — **THAT CLAIM WAS WRONG** | `status='reversed'` is written by `fn_reject_withdrawal`, which also stamps `approved_by`, so the 69 reversed rows are **admin rejections, not payout failures**. `fn_complete_withdrawal` only ever writes `success`/`failed` (with a `result_code`), and M-Pesa withdrawals with `status='failed'` number **zero**. | No technical issue. The **69 rejections vs 6 approvals** ratio is an *operations* question, not a bug |
| 6 | **MegaPay deposit success 46.5%** (1,287 success / 1,481 failed) | `transactions` 14-day aggregate | — |
| 7 | ~~"Latent multi-tenant refund bug" — refunds lack a `site_id` predicate~~ — **NOT A BUG; claim withdrawn** | `wallets_pkey` is `UNIQUE (user_id)` **alone**, so a user can only ever have ONE wallet row and `where user_id = …` matches exactly one row *by construction*. Identity is per-brand (a separate `user_id` per brand), so one wallet per `user_id` already **is** one wallet per brand. Verified: 0 users with multiple wallets, 0 wallet/profile `site_id` mismatches, 0 NULL `site_id` in `wallets` or withdrawal `transactions`. | None. Adding a `site_id` predicate would change live money SQL for zero benefit — and the riskier direction is `fn_create_withdrawal`, whose `user_id AND site_id` debit would silently match 0 rows on any mismatch (currently none) |

> Root cause of #2/#3: migration `0149`'s grandfather backfill ran once; sites created after it
> (`surewinfx` 2026-09-26, `betyangu` 2026-09-27) only receive the `mpesa` default from the `0148`
> trigger. This is a data fix, not a code change — and it will recur for every new brand until the
> trigger grants the full entitlement set.

## 5. Known gap — PayHero manual Pay Bill is not reachable

`POST /deposits/payhero/paybill/claim` exists and is served, but no UI path reaches it: the `paybill`
channel is tied to the **Daraja** paybill (`paybillConfig`), so a PayHero-only brand never sees it.
Making it usable needs a PayHero paybill *info* source (business number + account) equivalent to
`/deposits/paybill/info`. Deliberately out of scope here; tracked rather than half-built.
