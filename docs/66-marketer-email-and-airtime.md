# 66 — A marketer's own email, and airtime bought from the wallet

**Migration:** `0207_marketer_email_and_airtime.sql` · API: `apps/api/src/app.marketers.ts`,
`marketers.statement.ts` · App: `petermuchendu1000/mpesa_2`
(`AccountEmailScreen`, `MyTab`, `EntryScreen`, `AppNav`, `data/Statements.kt`) ·
**BUGLOG:** #147, #148 ·
**Tests:** `app.marketers.airtime.test.ts` (13), `packages/db/_testkit/e2e_marketer_airtime.py` (42)

> Closes the two holes docs/65 shipped with: a statement that could not be emailed to anybody, and
> a statement that could not report a purchase.

---

## 1. The email

docs/65 §5 had the marketer type an address every time they wanted a statement sent, because there
was nowhere to read one from — `marketers` had no email column and `profiles` has none either. They
now set it once, under **My → Email address**.

| Decision | Rejected | Why |
|---|---|---|
| **Not unique** | unique, or unique per brand | Two marketers sharing one inbox is a real arrangement — a supervisor receiving their team's statements, a shop with one address. The email authenticates nothing; the phone remains the identity. |
| **Self-service only** | an admin route to set it | An operator who could point a marketer's statements at their own inbox is a worse problem than a marketer typing an address once. There is no id in the route at all: the subject is the token. |
| Trimmed and **lower-cased** in the RPC | store as typed | `Faith@Example.COM ` and `faith@example.com` are one inbox. Storing both means a statement can be sent to a near-duplicate of the intended address and nobody notices. |
| `null` **clears** it | no way to remove | An address somebody has lost access to is worse than none: statements keep arriving somewhere nobody reads. |
| A column `CHECK` **as well as** API validation | either alone | The API validates properly (`isDeliverableEmail`); the CHECK only stops a direct `psql UPDATE` storing something that is obviously not an address. Asserted in the e2e by attempting exactly that. |

The statement email route now falls back to the stored address, and a body address overrides it for
one send **without overwriting** what is on file. With neither, it answers `NO_EMAIL_ON_FILE` rather
than guessing.

The view `public.marketer_profiles` is re-created with `email` **appended last** — the only shape
`create or replace view` permits, and the precedent 0096 and 0198 both set.

## 2. Airtime

The app's airtime screen was local only: `AppState.kt:150` added to a number in handset memory and
wrote nothing, so the wallet said one thing and the statement said nothing (docs/65 §4). Now:

```
balance_cents          -= amount     (the money leaves the cash bucket)
airtime_balance_cents  += amount     (and arrives in the airtime bucket)
one ledger row, entry_type 'airtime', amount_cents = -amount
```

**Conserving, not destroying.** The funny money moves between two buckets of the same wallet and the
total the marketer holds is unchanged — asserted directly in the e2e (`balance + airtime` before ==
after, on every success *and* every refusal). That is what makes the statement's arithmetic work:
the row is a debit against the balance, which is what the statement reports on.

| Decision | Rejected | Why |
|---|---|---|
| **Cash only — Fuliza cannot buy airtime** | let the overdraft cover a shortfall, as a withdrawal may | The owner's words were "buy credit **from their mpesa balance**". It is also 0203's rule: this overdraft is admin-granted and never repaid, so spending it here would mint airtime no operator granted. A WITHDRAWAL may still spend it, because that money leaves the system and the story ends — airtime does not leave. |
| **One row**, the debit | a debit and a matching credit for the airtime bucket | The statement sums signed `amount_cents` against `balance_after_cents`, and airtime is not part of the balance. A second row would double-count the movement in every total. |
| Idempotent on a **compulsory** `ref` | optional ref | Idempotency a client *may* omit is idempotency the one client under load *will* omit. Same rule as the transfer. |
| KES 5 floor, passed by the **API** | fixed in the function; or no floor | A sub-shilling top-up is a loop writing ledger rows, not a person buying credit. It is the app's policy number (`MARKETER_AIRTIME_MIN_CENTS`), **not a claim about any operator's minimum**. |
| The target number is **masked before it is stored** | store it whole; or store nothing | The marketer typed it, so it is theirs to spend on — but it lands on a statement that gets forwarded, and this ledger stores no full counterparty number anywhere (docs/58, 0203). The mask answers "who was this credit for?" without the ledger becoming a directory. Storing nothing would lose the answer entirely. |

### Where it lands on a statement

**OTHERS**, which is where a real M-PESA statement counts an airtime purchase: it is neither a till
nor a pay bill, and the reference's eight rows have nowhere else for it. The **detail** row is where
the answer actually is — `Airtime Purchase`, or `Airtime Purchase for - 0798****061` when it was for
somebody else's line.

So the owner's *"bought which credit"* from docs/65 §4 **is now answerable.** Pay Bill and Buy Goods
are still not: nothing records those, and the statement still says so on its face.

## 3. Two bugs this uncovered

**#147 — the test harness's withdrawal disagreed with the database about Fuliza.** The in-memory
`withdraw` refused outright instead of letting the overdraft cover a shortfall, and never wrote
`fuliza_used_cents`. So every route test touching a withdrawal pinned behaviour production does not
have, and the `fuliza_used_cents` branch of `ledgerToTxDto` — and of `detailsFor`, which prints
"Customer Withdrawal (Fuliza X)" on a statement — had never been exercised by anything. Found by
asserting the *contrast* 0207 rests on, rather than only the rule. Fixed; the full suite still
passes, which is both the good news and the bad news.

**#148 — a refused transaction still said "Successful".** `ReceiptScreen` never read
`TxFlow.success`. Harmless while every flow on it was a local simulation; it would have told a
marketer their money was spent the first time the server declined a real airtime purchase. Fixed
before that could happen.

## 4. Verification

| Claim | How |
|---|---|
| The RPCs, on all 207 migrations | `e2e_marketer_airtime.py` — **42/42**: conservation across both buckets, atomic refusals, the Fuliza rule *and its contrast*, idempotency under 8 concurrent phones, a retry storm on one ref, the statement mapping, email normalisation, the column CHECK against a direct UPDATE, and the anon/authenticated revokes |
| The routes | `app.marketers.airtime.test.ts` — **13 tests**, including that an operator token cannot spend a marketer's wallet, and that the full target number reaches neither the statement nor the feed |
| Nothing else regressed | full API suite **2331 tests, 0 failures**, 10 skipped |
| The app | `assembleDebug` green, 30/30 JVM tests |
| The screens render as intended | **NOT VERIFIED.** No emulator has run: the build container has no KVM. |

**Assumption, not verified:** that `RESEND_API_KEY` and `EMAIL_FROM` are set in production. Without
them the email route still answers `EMAIL_NOT_CONFIGURED` (docs/65 §5) — storing an address does not
by itself make delivery work.
