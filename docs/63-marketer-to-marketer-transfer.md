# 63 — Marketer-to-marketer funny-money transfer

**No migration (this screen).** API: `apps/api/src/app.marketers.ts` ·
App: `petermuchendu1000/mpesa_2` · **BUGLOG:** #140 ·
**Tests:** `app.marketers.recipientlookup.test.ts`, `MsisdnTest.kt`

> **Status: BOTH SCREENS BUILT.** §1–6 cover the Send Money screen and the recipient lookup it
> needs; §7 onward cover the Confirm step and the transfer RPC that moves the money. §6 is kept as
> written — it is the specification screen 2 was built against, not a list of open work.
>
> **What happens AFTER the money moves — the PIN screen, the confirmation and the printed receipt —
> is docs/64,** together with the server change (migration 0205) that gives a transfer a
> confirmation code and a commit time.

---

## 1. Why

A marketer's till app runs on simulated money (docs/27 — "they play the game on funny money… NONE
of it is real money"). When one runs out, the only ways to get more were an admin or platform admin
crediting them (`POST /admin/marketers/:id/credit`) or the self top-up to a fixed policy cap
(`POST /marketers/me/demo-topup`, docs/BUGLOG #102). Both put a ceiling or a person in the way of
something no real cash passes through.

The owner's ask: **a marketer should be able to ring a colleague and be sent some.** This is the
screen the colleague sends it from.

## 2. What was decided

| | |
|---|---|
| **Which money** | `marketer_wallets.balance_cents` — the balance the till app shows. **Not** `wallets.demo_balance`, which is the marketer's *game* bucket on the website (docs/27, migration 0084). The two are different wallets and this feature touches only the first. |
| **Who may receive** | An **active marketer on the sender's own brand**. Funny money only exists inside a marketer wallet, so there is nowhere else for it to go. |
| **Cross-brand** | **Refused.** A marketer of brand A cannot send to, or even resolve, a marketer of brand B. This is the same fence migration 0199 put in the database for the admin RPCs (docs/60), applied to the one read the app needs. |
| **How the recipient is identified** | The sender types the number their colleague gave them; the server resolves the **registered name** from `marketers` and the app shows it before the send. No directory, no picker, no list. |
| **Theme** | The app's existing **light** palette. The reference screenshots are the real M-PESA app in dark mode; the layout is theirs, the colours are this app's, because a dark screen reached from this app's light Home would be the only dark surface in the product. |

## 3. The recipient lookup

```
POST /api/v1/marketers/recipients/lookup   { phone }  ->  { name, self }
```

Gated by `requireAuth` + `requireMarketer` + a per-marketer rate limit.

**It is a name oracle keyed on a phone number**, and most of its design is about bounding that:

- **Brand scope is not a parameter.** The site id comes from the authenticated marketer's own
  profile, so there is nothing in the request to tamper with.
- **One refusal for every failure.** `RECIPIENT_NOT_FOUND` covers "nobody holds this number",
  "they are on another brand", "they are suspended" and "they are not a marketer". A test asserts
  the cross-brand refusal and the no-such-number refusal are byte-identical — otherwise the route
  becomes a way to map which numbers belong to which brand.
- **The response carries the name and nothing else.** Not the phone, the id, the balance, the
  status or the brand. A test asserts on the raw body that the recipient's digits appear nowhere,
  because this route is the obvious place for docs/58 to regress.
- **`by: "user"`, not `by: "ip"`** (20/min, `RATE_LIMIT_RECIPIENT_LOOKUP_PER_MIN`). Every marketer
  is behind Kenyan carrier-grade NAT, so an IP budget is shared by thousands of unrelated handsets:
  it would throttle honest users and barely inconvenience one account walking `07xx`. The per-user
  budget binds the attacker, who has to *be* an authenticated active marketer of the brand being
  swept.
- **POST, although it reads.** The number is the thing being protected, and a query string travels
  into edge access logs, browser history and `Referer` headers in a way a body does not. The API's
  own logger records `url.pathname` only (`http.ts`), but the hosting edge is not ours to promise
  about.

### `self` is load-bearing, not a convenience

`GET /marketers/me` masks the marketer's **own** number (docs/58 — `0798****061`), so the app holds
a masked string and **cannot** compare a typed number against it. Without a server-side `self` flag
the client could not detect a send-to-self at all. The one party holding both numbers answers it.

### What this does NOT reverse

docs/58 stands. The app still never receives anyone's full number from the server — including the
recipient's. It receives a **name**, for a number the user already had and typed in themselves.

## 4. The screen (mpesa_2)

`ui/screens/SendMoneyScreen.kt`, reached from `Routes.SEND_MONEY` / `Routes.SEND_POCHI`.
`Routes.forAction` intercepts the `send_money` and `pochi` catalogue tiles, so all four places that
render those tiles (Quick Actions, Frequents, All Services, Life) pick the new screen up at once —
routing them one by one is how three of them would have kept the old generic form.

- **Two tabs, one transfer.** "Mobile number" and "Pochi la Biashara" move the same money between
  the same two wallets. Pochi is the lighter form — no QR, no withdrawal-charge tick, no Do More —
  as the reference shows, because a Pochi payment is a payment to a trader's till rather than cash
  to a person: there is nothing to withdraw and nothing to scan.
- **The number is checked before Continue lights up**, not after. A send that was going to fail
  should fail while the sender is still looking at the number they typed.
- **Four distinct outcomes under the field**, never collapsed: the resolved name, "you can't send to
  yourself", "no marketer is registered on this number", and "couldn't check". The last two must
  not share a sentence — one means retype, the other means retry.
- **Lookups are debounced 350ms and keyed on the normalised number**, so a number typed straight
  through costs one request, and re-typing the same person in another format costs none.
- **Favourites are stored on the handset and nowhere else** (`data/Favourites.kt`). A favourite is a
  name plus a full number; syncing them would quietly build the shared directory docs/58 exists to
  prevent. They are cleared on logout.
- **"Add withdrawal charges"** is a simulation of Safaricom's agent-withdrawal tariff, so the
  recipient nets the round number. No fee is charged anywhere and no funny money is destroyed — the
  tick simply increases the amount transferred. **Tariff checked 2026-10-14:** the KSh 11 band for
  KSh 50–100 is confirmed on Safaricom's own M-PESA rates page and is the band the reference
  screenshot shows; **the bands above KSh 100 are reported by independent Kenyan tariff trackers and
  are NOT confirmed against Safaricom's own published table** — treat them as reported, not verified.
- **Shiriki Pay** is drawn because the reference has it, and says plainly that it isn't linked to
  this account rather than pretending to be a second wallet.

`Msisdn.normalize` is a digit-for-digit copy of the server's `normalizeMsisdn`
(`packages/shared/payments.ts`) and `MsisdnTest.kt` pins it to that module's own test table. They
have to agree: the app uses it to decide **when** to ask who a number belongs to, and the server
uses its copy to decide **who**. A looser rule fires lookups the server always refuses; a stricter
one refuses to look up numbers the server would have resolved.

## 5. Rejected

| Option | Why not |
|---|---|
| **A picker listing the brand's marketers (names + numbers)** | The most convenient reading of the ask, and the one that hands every marketer the full roster of their brand and everyone's phone number. That is exactly what docs/58 removed. Offered to the owner and declined. |
| **A picker with names only** | Still a roster: it tells any marketer who else is on the brand, and makes "is X a marketer here?" answerable without knowing a number. The typed-number lookup needs the number first, which is the whole point. |
| **Raising the self top-up cap instead** | Does not answer the ask. The cap is not the complaint — needing someone else to act is, and a self top-up is still the marketer topping up *themselves*. |
| **Sending to any phone number, M-PESA style** | There is no wallet to credit. It would have to fail at the Confirm step, after the sender had entered an amount. |
| **Letting the app compare numbers to block self-sends** | It cannot: `/me` is masked (docs/58). |
| **GET for the lookup** | Puts the number in a URL. See §3. |

## 6. What screen 2 had to provide (the specification it was built against)

The Confirm step and the transfer itself. It will need, at minimum:

- a **single DB RPC** that debits the sender and credits the recipient **in one transaction**, with
  the same brand fence the other marketer RPCs carry (0199), refusing self-transfer, non-positive
  amounts and overdraft;
- **idempotency** on a client-supplied ref, so a retried request cannot send twice;
- a **ledger row on both sides** so each wallet's statement and the M-PESA confirmation feed
  (`ledgerToTxDto`) read correctly;
- the sender's **PIN** (the app already has `PinEntryScreen`);
- a **per-marketer daily transfer cap**, because the funny-money supply is a policy number and
  peer-to-peer transfer is a new way to concentrate it.

All of it landed — see §7 onward, and docs/64 for the screens that follow the send.

---

# Screen 2 — the Confirm step and the transfer itself

**Migration:** `0203_marketer_peer_transfer.sql` · **BUGLOG:** #140, #141, #142 ·
**Tests:** `e2e_marketer_transfer.py` (real Postgres), `app.marketers.transfer.test.ts`

## 7. The transfer

```
POST /api/v1/marketers/me/transfer
  { phone, amountCents, chargeCents?, ref }  ->  { idempotent, balanceCents, sentCents, recipientName, ledgerId }
```

**The sender is the token.** Never a body field, so there is no `from` to forge — a test sends a
victim's id as `from`/`fromMarketerId`/`marketerId` and asserts that wallet is untouched.

**One function, not two calls.** A credit plus a withdraw issued from the API would be two
transactions: a crash between them destroys or duplicates funny money, and no amount of retry logic
makes two statements atomic from outside. `fn_marketer_transfer` does the debit, the credit and both
ledger rows in one transaction under row locks.

### What the database refuses

| Refusal | Why |
|---|---|
| `TRANSFER_TO_SELF` | checked before any lock is taken — a self-send would lock one wallet twice and net to zero after writing two rows claiming money moved |
| `INSUFFICIENT_FUNDS` | cash only; see below |
| `AMOUNT_MUST_BE_POSITIVE` / `AMOUNT_BELOW_MINIMUM` | a negative amount is a reverse-direction steal; sub-shilling dust is a loop writing ledger rows |
| `RECIPIENT_NOT_FOUND` | **one** error for absent, other-brand and suspended — the same opacity the lookup route has, so neither can be used to map numbers to brands |
| `MARKETER_NOT_ACTIVE` | the sender's own state; they are authenticated, so this is not an enumeration risk and is reported distinctly |
| `TRANSFER_DAILY_CAP` | rolling 24h per sender |

### Fuliza is not spendable on a transfer

`fn_marketer_withdraw` (0033) lets the Fuliza overdraft cover a shortfall. This deliberately does
not, and it is the one place where realism was traded away:

- `available_fuliza_cents` is granted by an operator (`fn_marketer_set_fuliza`) and **repaid by
  nobody** — it only goes down on spend and back up when an operator resets it.
- A **withdrawal** spending it takes money OUT of the system; the overdraft is consumed and the
  story ends.
- A **transfer** spending it would move the borrowed amount INTO another live wallet — minting funny
  money no operator granted, and letting two marketers ratchet the float up indefinitely by taking
  turns.

The Send Money screen counts only the cash balance for the same reason, and says so when the amount
is over: *"More than your M-PESA balance. Fuliza can't be used to send to another marketer."*
**Reversing this is one condition in the RPC** if the owner decides the realism is worth the supply
leak.

### Idempotency

`ref` is **required**, not optional — idempotency a client may omit is idempotency the one client
under load will omit, and the retry that double-sends is the one nobody tests. `marketer_ledger.ref`
is UNIQUE (0033), so the two rows are stored as `<ref>:out` and `<ref>:in`; the probe reads the
`:out` row, written in the same transaction as the `:in`, so either both exist or neither does.

The app mints one ref per **attempt-chain** (on reaching Confirm) and reuses it on every retry.
Backing out of Confirm clears it: returning is a new decision, not a retry, and reusing the ref
would make the second send a replay that moves nothing.

A timeout is surfaced as `Unknown`, never as a failure — the server may have moved the money and
lost the reply. The result screen offers *"Check again"* on the **same** ref, which either completes
the transfer or reports the completion that already happened.

### The daily cap

`MARKETER_TRANSFER_DAILY_CAP_CENTS`, defaulting to the self-top-up cap (KES 100,000): a marketer
cannot move more in a day than they could have topped themselves up to. Rolling 24 hours rather than
a calendar day, because the brands span time zones and a calendar reset means nothing to the person
holding the phone. A separate per-marketer rate limit (10/min) bounds *rate* — a stuck client
retrying is a different problem from a marketer moving too much, and the cap would not notice it
because a replayed ref moves nothing.

### Both statements, from each side

`meta.name` holds the **counterparty's** name on each row, which is what `ledgerToTxDto` reads: the
sender's feed says *"sent to PETER MUCHENDU"*, the recipient's says *"received … from TONY ANGWA"* —
with no change to the confirmation builders. The recipient's app raises a real "money received"
notification through its existing poll. No phone number is stored in `meta`: a column nobody reads
is still a column that leaks when somebody does.

## 8. What the testing found

Verified against **real PostgreSQL 16 with all 203 migrations applied**
(`packages/db/_testkit/e2e_marketer_transfer.py`, 40 assertions) — in-memory tests cannot prove any
of this:

- 12 parallel sends of 2,000 from a wallet holding 10,000 → **exactly 5 succeed**, the wallet is
  never overdrawn, every cent that left arrived, and the rest are refused for funds.
- 8 simultaneous requests sharing one ref → the money moves **exactly once**.
- 20 opposing transfers between the same two wallets → **no deadlock** (the fixed lock order), and
  the pair's total is conserved.
- Every wallet still equals the sum of its own ledger, *except* where Fuliza paid part of a
  withdrawal — which is **BUGLOG #141**, pre-existing and not this migration's.

## 9. Also fixed here: BUGLOG #142

Found while wiring the PIN step. `/me` and both login routes mask the phone (docs/58), the app
persists that masked value, and `PinLoginScreen` used it to re-authenticate —
`fn_phone_sig9('0798****061')` is 7 digits where every marketer lookup requires 9, so **the PIN lock
screen returned INVALID_CREDENTIALS every time**, on every launch and every return from the
background. The app now keeps the number the marketer typed at sign-in (their own, not anyone
else's — docs/58 is untouched) and authenticates with that; sessions upgraded from before the fix
have no real number stored, so they are routed to sign-in once rather than to a PIN screen that
cannot succeed.
