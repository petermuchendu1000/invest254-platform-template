# 53 — PayX (Paynicorn) deposit rail

Admins see this gateway as **PayX** (migration 0187); its provider code stays `paynicorn`.

**Migration:** `0186_paynicorn_provider.sql` · **Client:** `apps/engine/src/paynicorn.ts`

## What it is — per country, per method
PayX is **country-driven**. For a brand's collection country (`sites.country`, migration 0188) we ask
Paynicorn which methods it will accept there and show **one deposit tab per method**: a country offering
only a card shows only a card, one offering three shows three, and a country Paynicorn does not serve
offers nothing at all. Every country Paynicorn publishes is supported
(`apps/engine/src/paynicorncountries.ts` — 32 countries, each with its currency and decimal rule).

Two kinds of method, decided by what each one needs:

| Method needs | Channel | What the player sees |
|---|---|---|
| Only a phone and/or email (M-Pesa, MoMo, Airtel…) | `stk` | **Our own form.** Prompt goes to the phone; no third-party page. |
| Anything else (card, bank…) | `checkout` | The gateway's page, embedded in our sheet. |

That split is forced, not chosen: **the collection API accepts only `phone` and `email` as payer input**
(the full `pay` parameter list is amount, countryCode, orderId, orderDescription, currency, payMethod,
language, cpFrontPage, palmAuthCode, email, phone, payByLocalCurrency, memo). `account`/`bankCode` exist
only on the **payout** API. So a method needing a bank account can only be completed on Paynicorn's own
cashier — there is no field to carry it. `methodIsDirect()` encodes exactly this.

**Amounts.** The wire amount is the LOCAL currency's major unit formatted to that country's decimals
(KES 130 -> `"130"`, NGN 1625.50 -> `"1625.50"`). KES cents are converted at the live FX rate
(`kesToCurrencyRate`) and rounded to the currency's precision. Where the collection currency IS KES the
player typed the amount, so it must be a whole shilling and nothing is rounded.

### Historical note
Paynicorn (paynicorn.com) collects M-Pesa for us. To players it is just **M-Pesa**: the deposit sheet
is our own amount + phone form, and Paynicorn pushes the STK prompt to the phone itself. **No Paynicorn
page is ever shown.** It is a **System-owner (global scope) rail only**: a brand on its own payment
accounts (docs/43) is refused with `GATEWAY_NOT_CONFIGURED`, never routed to the System's account.

## Confidentiality: the supplier is never named to players
- Naming the method and the phone/email on the order skips Paynicorn's cashier and `webUrl` comes back
  null (verified live), so the browser never loads a Paynicorn URL — for direct methods.
- **`iconUrl` is stripped for players.** Paynicorn publishes method logos on its own cdn, so passing one
  through would put the supplier's hostname in the browser. `publicProvider()` drops it; the method's
  own name ("M-Pesa", "Card") carries no hint and stays. A route test asserts no `paynicorn` host leaks.
- **A `checkout` method cannot be confidential.** A card/bank page is served by the gateway (or a bank),
  embedded so the player stays in our app, but its origin is visible to anyone who looks.
- Everything a player's browser receives uses the public code `payx` (`apps/api/src/publicProvider.ts`):
  `GET /deposits/providers` (method `payx-stk`, label "M-Pesa"), `POST /deposits/payx`, and
  `GET /transactions` (`provider: "payx"`). The built web bundle contains no "paynicorn" string; the
  API tests assert those responses never contain it either.
- Operators (`/platform`, `/admin`) still see the real code and the PayX (Paynicorn) config card.
- **Outside our control:** the M-Pesa prompt and confirmation SMS show the business name of the
  paybill Paynicorn collects into. Only Paynicorn can change that display name.
- The callback path (`/deposits/paynicorn/callback`) is called only by Paynicorn, server to server.

## Success is shown only on real success
The sheet shows "check your phone" and polls this deposit's own transaction; it turns green only when
the transaction is `success`, which happens only after the signed postback has been re-verified with
Paynicorn's query (or the reconcile sweep, which also runs on the fast 15 s loop for PayX).

## Wire contract (paynicorn.com/docs, verified 2026-10)
- Every call: `POST https://api.paynicorn.com/trade/v3/transaction/<op>` with
  `{ content: base64(JSON(bizReq)), sign: md5(content + merchantSecret), appKey }`.
  Responses carry `responseCode` (`000000` = ok) plus a `content`/`sign` pair we verify the same way.
  The official test vector is a unit test (`paynicorn.test.ts`).
- `pay`: `{amount, countryCode:"KE", currency:"KES", orderId, orderDescription, payMethod:"MPESA", phone}` → `webUrl: null` (direct push).
  `phone` is the 9 local digits (no country code, no leading 0).
  **KES has no decimals on Paynicorn**: amounts cross as whole shillings, and the API refuses a deposit
  that is not a whole number of shillings (`INVALID_AMOUNT`).
- `query`: `{orderId, txnType:"payment"}` → `status` `1` paid / `-1` processing / `0` failed.
- Postback to the app's callback address: `{content, sign}`; we must answer HTTP 200 + `success_{txnId}`
  (plain text) or Paynicorn retries up to 7 times (10 → 320 min).
- Test vs Production is the app's status in the Paynicorn console — same host, same keys. A test app
  only offers the MOCK payment method. Switching to Production requires one successful test order with
  a successful callback in the last 30 days.

## Money safety
- Our `transactions.id` is the Paynicorn `orderId` and the `checkout_request_id`, so the postback, the
  query and the reconcile sweep all key on it.
- A postback credits nothing by itself: the signature must verify with **our** merchant secret, a signed
  amount that disagrees with the order is refused (`409`, left for review), and the status that settles
  is the one from our own signed `query` call. Settlement runs through the shared idempotent
  `fn_complete_deposit`, so retries never double-credit.
- `reconcilePaynicornDeposits` runs on the reconcile interval for postbacks that never arrived.
- A signed postback for an order we don't hold is acknowledged and ignored (console address checks).

## Endpoints
| Route | Who | Purpose |
|---|---|---|
| `POST /api/v1/deposits/payx` `{amount, method?, phone?, email?}` | player | 202 `{transactionId, checkoutRequestId, checkoutUrl?}`. `method` must be one the country offers. `checkoutUrl` present only for a hosted method. |
| `POST /api/v1/deposits/paynicorn/callback` (+ `/s/:slug/…`) | Paynicorn | postback (JSON or form body) |
| `GET  /api/v1/deposits/paynicorn/callback` | anyone | reachability for the console's CheckAddress |

Optional `PAYNICORN_CALLBACK_ALLOWED_CIDRS` locks the callback to Paynicorn's IPs.

## Turning it on
1. Deploy (migration 0186 registers `paynicorn` OFF for every brand, unbilled).
2. `/platform/payments` → Gateway configuration → **PayX**: App key (APIKEY), Merchant secret,
   optional Return page → Save → **Test connection** (a signed query; moves no money).
3. Entitle the brand to the `paynicorn` add-on and switch the gateway on for it.
3b. **Add the country in the Paynicorn console** — Merchant Information -> Basic Information -> Country
   or Region. A country outside that scope returns an empty method list (business code 101016) and the
   brand is simply offered nothing. Then set `sites.country` to the matching ISO-2 code.
   The deposit sheet shows one tab per method that country offers (the gateway is never named, docs/35).
4. Paynicorn console → the app's **Callback address**:
   `https://invest254-api.fly.dev/api/v1/s/<slug>/deposits/paynicorn/callback`.
