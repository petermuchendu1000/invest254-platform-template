# 47 — Billing: invoices, payments, dunning and revenue (BILL-1)

Owner request (2026-09-23): *"We need a really serious /billing page (especially from both platform and system
admins). Very professional, comprehensive, thorough, and rigorous … Implement, research, and design the best UI
and backends — fully wired and tested e2e."*

Owner decisions (same day):
- **Bill-to:** the **platform**. One consolidated invoice per platform covers the plan and every brand's add-ons, and each line names the brand.
- **Add-on pricing:** set per add-on. Each is free, one-off or monthly, with an optional one-off setup fee.
- **Payment:** **M-Pesa "Pay now"** sends an STK prompt, and the money lands in the System account. The owner can also record payments by hand (bank, cash, other).

## 1. What existed (docs/39)

- `platform_subscriptions` held a plan, a status and dates.
- A daily cron moved trial or active → past_due → grace → suspended purely on dates.
- A "payment" was the owner pressing *Mark paid*.
- There were no invoices and no payment collection. Add-on prices were never billed: approval only wrote an `addon.charge` audit row, yet the brand page said "It is billed at KES X".
- The owner's page listed the platform's status (active/archived), not its subscription status.

## 2. Model (reference: the Stripe Billing lifecycle, adapted to invoices you send and M-Pesa)

| Object | Purpose |
|---|---|
| `billing_settings` (singleton) | Seller details printed on invoices; invoice prefix and next number; payment terms (days until due); tax (rate in basis points, label); manual payment instructions; whether M-Pesa Pay now is offered |
| `subscription_plans` (existing) | Price and limits per plan. The owner can now edit plans and add new ones. |
| `platform_subscriptions` (existing) | Plan, custom price, status, service period. New: `billing_exempt`. The System's own default platform is exempt. |
| `addon_catalog` (+) | `billing_type` (`free` \| `one_off` \| `monthly`) and `setup_fee_cents`. `price_cents` is the one-off price or the monthly price. |
| `billing_charges` | Items waiting to be invoiced: add-on one-off and setup fees, adjustments, credits (negative). They go onto the next invoice. |
| `invoices` | `draft`→`open`→`paid` \| `void` \| `uncollectible`. Numbered `{PREFIX}-{YYYY}-{00001}`. Fields: service period, issue date, due date, subtotal / tax / total / paid / due, and a reminder stage. |
| `invoice_lines` | Plan, monthly add-on (per brand), one-off add-on, setup fee, adjustment, credit. |
| `invoice_payments` | M-Pesa STK (pending → succeeded \| failed, with checkout id and receipt) or manual (bank / cash / other). Partial payments are allowed. |

## 3. Lifecycle (`fn_billing_run`, daily; also "Run billing now")

1. **Renewal (bill in advance).**
   - When a subscription reaches its anchor, the next period is invoiced for the plan price, plus every monthly add-on of the platform's active brands, plus any pending charges. The anchor is `trial_ends_at` for a trial and `current_period_end` otherwise. The invoice is due after the payment terms (default 7 days).
   - The service period advances. A trial becomes `active`, with its first invoice open.
   - Missed runs catch up, up to 12 periods.
   - A zero-total invoice is marked paid automatically.
2. **Dunning (on the oldest unpaid invoice).**
   - Due date passed: `active` → `past_due`.
   - `past_due_days` after the due date: `grace_period`, with `grace_ends_at` set to now + `grace_days`.
   - Grace period over: `suspended`. The brands go offline (0138 enforcement).
3. **Reminders.** Platform admins get in-app notices in category `billing`, one per stage: invoice issued → due in ≤ 3 days → overdue → grace (with the suspension date) → suspended.
4. **Payment.** When an invoice is fully paid and no other overdue invoice remains, a `past_due`, `grace_period` or `suspended` subscription returns to `active`. The platform admins and the owner are notified.

## 4. Money safety

- **Pay now.**
  - The engine sends an STK push from the **System** M-Pesa account (never a platform's own account) with `AccountReference` = the invoice number.
  - The amount is the balance due, in whole shillings.
  - The shared STK callback URL is routed to billing when the checkout id belongs to an invoice payment.
  - The result is **verified with STKPushQuery** before anything is marked paid. A forged callback cannot pay an invoice.
  - A 2-minute sweep settles payments whose callback never arrived.
- **Settlement is idempotent.** Only `pending` can change to `succeeded` or `failed`, and a payment is applied to its invoice exactly once.
- **Only the System owner can move money records.** That covers recording payments, voiding, write-offs, charges, credits and plans. A platform admin reads only its own platform's invoices and can pay only those.
- **Audit.** Every action writes to `admin_actions` and, where the status changes, to `subscription_events`.

## 5. Screens

- **System owner, `/platform/billing`:**
  - **Overview:** MRR, ARR, outstanding, overdue, collected this month, an aging bar (current / 1–30 / 31–60 / 61–90 / 90+), a "Needs attention" list, upcoming renewals and recent payments.
  - **Invoices:** filter by status, platform and number.
  - **Subscriptions:** per platform: plan, price, status, next invoice, balance. Actions: change plan, charge or credit, create invoice, status changes, exempt.
  - **Plans:** edit and add plans.
  - **Settings:** seller details, prefix, terms, tax, Pay now, dunning durations.
- **Platform admin, `/platform/billing`:**
  - Plan and status in plain words, next invoice and estimate, usage meters.
  - A balance-due banner with **Pay now**.
  - Invoices and payment history.
  - Plan comparison.
  - How to pay by hand.
- **Invoice page, `/platform/billing/invoices/[id]`:** a printable invoice (seller, bill-to, number, dates, lines by brand, totals, payments) with the actions allowed to the viewer.

## 6. Implementation (as built)

| Layer | Where |
|---|---|
| Schema, RPCs and lifecycle | `packages/db/migrations/0165_billing.sql`. Every function is SECURITY DEFINER and executable by service_role only. |
| Engine | `apps/engine/src/billing.ts`: `PgBillingRepository`, `BillingService` (pay now, callback verification, reconcile) and `InMemoryBillingRepository` (for API tests; it enforces the same scope rules). |
| API | `apps/api/src/app.billing.ts` (17 routes under `/platform/billing/*`). The STK callback in `app.payments.ts` asks billing first. Wiring and the 2-minute sweep are in `server.ts`. |
| Web | `/platform/billing` has owner tabs and the platform-admin view. `/platform/billing/invoices/[id]` is the printable invoice. Components are in `components/billing/*`, and the client and labels in `lib/billing/*`. |

Operational notes:
- **The daily job is unchanged.** The *Subscription Lifecycle* workflow still calls `fn_subscription_auto_advance()`, which now runs `fn_billing_run(now())`. The owner can also press **Run billing now**.
- **Callback verification.** Pay-now results are verified with STKPushQuery in both directions (paid and failed). `BILLING_VERIFY_STK=false` turns verification off (for local development only).
- **The reconcile sweep.** It runs every `BILLING_RECONCILE_INTERVAL_MS`, default 120000 (0 disables it). It settles M-Pesa payments that are still pending after 90 s. It closes reservations that never reached Safaricom after 10 minutes.
- **The account reference.** Daraja allows 12 characters, so `TRIO-2026-00012` is sent as `TRIO2600012` (`mpesaAccountRef`). The invoice shows the same value.
- **Money that doesn't fit an invoice is never lost.**
  - Credits larger than an invoice are carried forward.
  - Overpayments become a credit. They come from rounding up to whole KES, or from an invoice settled another way while a prompt was open.
- **Add-ons already granted before 0165** (grandfathered gateways) are never charged. One-off and setup charges are created only when an entitlement is inserted, and only once per brand and add-on.
- **No KES 0 invoices.** A custom-priced plan with no price, no paid add-ons and no pending charges rolls its period forward without one.

## 7. Tests

- `packages/db/_testkit/e2e_billing.py`: BEFORE reproduces 3; AFTER 112 checks. They cover renewals and catch-up, trial conversion, dunning at every stage, manual and part payments, reactivation, M-Pesa idempotency and failure, rounding credit, void and write-off, charges and credits with carry-forward, exemption, plans, settings, reads, scope and grants.
- `e2e_subscriptions_tickets.py` is updated to the invoice-driven lifecycle.
- Engine `billing.test.ts` (5). API `app.billing.bill1.test.ts` (3) and `billing.pg.test.ts` (real schema). The F-44 cross-tenant matrix now includes the billing routes, with a seeded target invoice.
- Web `lib/billing/labels.test.ts` (4). The role e2e has 23 billing checks, covering both tiers, the phone layout, Pay now, and the owner's settings, invoice, payment and credit flows.
- Real stack: the invoice was paid through Pay now with the stub Daraja client, and the reconcile sweep settled it. The platform went from grace_period to active.
