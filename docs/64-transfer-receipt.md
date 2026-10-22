# 64 — The transfer receipt: confirmation code, commit time, and what the printed page may claim

**Migration:** `0205_marketer_transfer_receipt.sql` · API: `apps/api/src/app.marketers.ts` ·
App: `petermuchendu1000/mpesa_2` (`SendPinScreen`, `SendResultScreen`, `SendReceiptScreen`,
`data/Receipts.kt`) · **BUGLOG:** #145, #146 ·
**Tests:** `app.marketers.transfer.test.ts` (5 new), `packages/db/_testkit/e2e_marketer_transfer.py`
(8 new), `ReceiptsTest.kt` (10)

> Continues docs/63, which built the Send Money screen, the recipient lookup, the transfer RPC and
> the Confirm step. This covers the three screens AFTER the money moves.

---

## 1. Why anything had to change on the server

The app now shows a sender three things it did not show before: a PIN screen naming the amount, a
confirmation screen carrying an ID and a timestamp, and a receipt page built to be shared. Two facts
on those screens had no source:

| Fact | Where it could have come from | Why that is wrong |
|---|---|---|
| **When the money moved** | the handset clock | It can be wrong, it can be set by hand, and on an idempotent retry the transfer being reported completed *minutes ago* — "now" is then the one timestamp guaranteed to be false. |
| **The confirmation code** | generated in the app | It has to be identical on a retry, identical to what the recipient's own confirmation says, and identical to what the sender later finds in their statement. A handset cannot guarantee any of the three about a value it invented. |

So `fn_marketer_transfer` now returns `out_created_at` — the commit time of the debited ledger row —
on **both** its branches, including the replay branch, where it returns the *stored* row's time. The
API derives the code from `(that time, out_ledger_id)` using `mpesaCode()`, the same function that
renders the transaction list, so **the ID on the receipt is the ID in the statement**. Verified by
`app.marketers.transfer.test.ts` → "the code on the receipt is the code in the sender's own
statement".

## 2. One transaction, one code (BUGLOG #145)

`ledgerToTxDto` derived the confirmation code from each row's own `id`. A peer transfer is two rows,
so the payer and the payee were shown **two different codes for one transfer** — something no real
M-PESA transaction does, and a contradiction the first time two marketers compare phones.

0205 stamps the credited row with `meta.pair_ledger_id` = the debited row's id, and `ledgerToTxDto`
prefers it. Both sides now render the sender's code. The timestamps already agreed: both rows take
`created_at` from the same transaction's `now()`, which in Postgres is transaction start — asserted
on real Postgres ("both halves of one transfer share one timestamp").

**Rows written before 0205** carry no `pair_ledger_id` and keep falling back to their own id, so
nothing already rendered changes. That fallback is itself tested, so a future refactor cannot drop
it silently.

## 3. What was decided, and what was rejected

| Decision | Rejected alternative | Why |
|---|---|---|
| The RPC returns `out_created_at` | API reads `created_at` back with a second query after the RPC | A second statement is a second answer. The function already holds the row; returning it keeps one round trip and one source of truth. |
| ISO-8601 UTC via `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` | `jsonb_build_object` on the raw `timestamptz` | Explicit formatting cannot be changed by a session's `DateStyle`. **Millisecond precision on purpose**: the consumer is JavaScript's `Date.parse`, which has no finer resolution, so asserting microseconds would be asserting a precision the receipt cannot carry. |
| `out_created_at` is **optional** in the API's `TransferResult` | required | migrate runs before deploy, but a *rollback* must not take the send path down. The route falls back to its own clock and the app to `System.currentTimeMillis()`; blank code ⇒ the receipt omits the ID row rather than printing a number nobody can look up. |
| `pair_ledger_id` on the credited row only | on both rows | On the debited row it would point at itself, which is exactly what the fallback already does. A column nobody reads is still a column. |
| The app formats every date in **East Africa Time**, from a fixed zone | the device's default zone | M-PESA stamps in EAT and `mpesa.ts` already does. A phone on automatic time while roaming would otherwise print a different day from the server for the same transfer. Asserted in `ReceiptsTest`: 22:30 UTC on the 14th must render "15th Oct 2026 | 1:30 am". |
| The receipt prints `KES 1`; every in-app figure prints `Ksh 1.00` | one format everywhere | Both match their own reference. The app is a ledger view, where a column of aligned decimals is the point; the receipt is a document, where nobody writes the cents they do not have. `Receipts.kes` drops a trailing `.00` and keeps cents whenever there are any. |
| `java.util.Calendar` | `java.time` | minSdk is 24 and core-library desugaring is **not** enabled, so `java.time` would crash on exactly the older handsets this app targets. (Verified: `app/build.gradle.kts` has no `coreLibraryDesugaring`.) |

## 4. The two controls that are drawn but do not work

The reference confirmation screen carries four actions. Two of them are real here — **Add to
favourites** (device-local, docs/63 §5) and **Download receipt**. Two are not, and are rendered
dimmed with an explanation on tap rather than omitted or faked:

- **Reverse transaction.** Technically trivial — it is a transfer back — and *that is the problem*. A
  unilateral clawback lets a sender take funny money out of a colleague's wallet after that colleague
  has been told it arrived and may have spent it. Sending money and reversing it after receiving
  something for it is a known pattern, and whether this platform's owner wants a reversal at all —
  and if so, whether it needs the recipient's consent, a time limit, or an admin — is a product
  decision, not an implementation detail. **Left to the owner. Nothing was built.**
- **Schedule payment.** Needs a server-side scheduler (a stored instruction, a runner, a failure
  policy for a scheduled send that cannot be funded). None exists. **Not built.**

A dead control that looks live is worse than one that looks unavailable and says why, so both are at
45% alpha before the tap as well as explained after it.

## 5. What the printed receipt claims (decision REVERSED — see 5a)

`SendReceiptScreen` is the only artifact in this flow designed to **leave the handset**. That changes
what it is allowed to say.

| | Confirmation screen | Printed receipt |
|---|---|---|
| Recipient's number | **In full.** The sender typed it a minute ago; it is not news to them. | **Masked** `079866***061`. It is now travelling to somebody who did not type it. |
| Audience | the sender | whoever the sender forwards it to |

### 5a. REVERSED 2026-10-15 — the page is now a 1:1 reproduction

**What was originally decided (and is no longer in force):** two things from the reference were left
out — the tax-register marking ("ETR") and the mobile operator's registered postal address,
customer-care number and corporate logo lockup — and the page carried a banner saying the transfer
was simulated. The reasoning was that the money in this app is simulated (docs/27), that fabricated
payment confirmations are a live fraud pattern in this market, and that a page carrying a real
operator's registered identity and a tax marking would not merely *look like* proof of a real
payment to somebody holding the screenshot — for that purpose it would **be** one.

**What was decided instead:** the concern was put to the owner with that reasoning. The owner asked
for the reference reproduced exactly. It is their product and their call, so the receipt now carries
the full footer — ETR, "Question? Comment? Feel free to get in touch!", the registered address and
care number, the "Simple • Transparent • Honest / FOR YOU" lockup and the operator mark — and the
simulated-transfer banner is gone.

**The trade-off accepted:** a marketer can address any number, send any amount of funny money and
produce a page indistinguishable from a genuine payment confirmation. Nothing in the product
prevents that screenshot being presented to a third party as proof of payment. The owner holds that
risk knowingly; this section exists so the next reader finds the reasoning rather than the decision
alone, and so re-opening it is a deliberate act.

**What did NOT change:** the party paid is still masked `079866***061` — which is what the reference
page itself prints, so fidelity and the narrower disclosure agree here. The confirmation screen
still shows the number whole, because there it is a number the sender typed a minute earlier.

**Assumption, not verified:** that the owner's intent is a realistic demo rather than a shareable
payment instrument.

The barcode is drawn **from** the confirmation code by a deterministic hash, not from a random
source: no scanner will read it, but the same transaction draws the same bars on every device and
every re-open, so two copies of one receipt cannot look like two transactions.

## 6. Navigation: why the result screen can be returned to

Compose Navigation recreates a destination when it is popped back to, so walking to the receipt and
pressing back re-enters `SendResultScreen` and would re-run the transfer. The same `ref` makes that
harmless on the server — it answers "already done" — but it is a pointless round trip that puts
"Sending…" back on a screen the sender has already read, and it **fails outright if they have lost
signal by then**. `SendReceipt.matches(SendFlow.ref)` is checked before sending; a settled transfer
renders straight from the stored receipt.

`SendReceipt` is deliberately separate from `SendFlow`. SendFlow is an *intention* — mutable while
the sender is deciding, cleared when they leave. SendReceipt is a record of something that happened,
and every field in it but the recipient's number is the server's answer.

## 7. No biometric key on the payment PIN

The lock screen offers one; this screen does not. A fingerprint proves the handset is in the owner's
hands. It does not prove the PIN, and the PIN is what the server checks (`fn_marketer_login`, which
is also what gives this screen the account's existing lockout). Offering biometrics here would walk
straight past the only authentication the screen performs. The keypad's bottom-left key keeps its
layout weight and loses its click.

## 8. Verification

| Claim | How |
|---|---|
| Code and time are the server's, and survive a replay | `app.marketers.transfer.test.ts` ×5; **proven to fail** on the regression (reverting the pairing fails "both sides… ONE confirmation code"; replacing `out_created_at` with `Date.now()` fails "a replay reprints the ORIGINAL receipt") |
| Holds on real Postgres with all 205 migrations | `e2e_marketer_transfer.py` — **48/48** (40 before this change), **7 consecutive clean runs of the final script**; 13 clean runs across both revisions of the #146 fix |
| Dates are EAT regardless of device zone | `ReceiptsTest.kt` — asserts under UTC, America/New_York, Asia/Tokyo, Pacific/Kiritimati |
| Nothing else regressed | full API suite **2296 tests, 0 failures, 10 skipped** |
| The screens render as the reference | **NOT VERIFIED.** No emulator has run: the build container has no KVM. Every claim above is code and test evidence, not a screenshot. |
