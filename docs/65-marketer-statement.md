# 65 — The marketer wallet statement: what the funny money was used for

**Migration:** `0206_marketer_statement_range.sql` · API: `apps/api/src/marketers.statement.ts`,
`app.marketers.ts` · App: `petermuchendu1000/mpesa_2`
(`ExportStatementsScreen`, `StatementScreen`, `data/Statements.kt`) ·
**Tests:** `app.marketers.statement.test.ts` (24), `marketers.statement.pdf.test.ts` (14), `packages/db/_testkit/e2e_marketer_statement.py`
(23), `YmdTest.kt` (10)

> Follows docs/63 (the transfer) and docs/64 (its receipt). Those record single transactions; this
> is the report **over** them.

---

## 1. Why

A marketer spends simulated money (docs/27) that somebody else granted them. The owner's ask was
accountability: *"statements of how the marketer has been using the funny money — sent to who,
bought which credit."*

`GET /marketers/me/transactions` could not answer that. It is a **feed**: newest 50, rendered as
M-PESA confirmation messages, built to raise a "money received" notification. A statement is a
different question — *everything between these two dates, and what it adds up to* — and it is read
by somebody checking, not by somebody spending.

## 2. Two functions, not one, and that is the whole design

| | Scans | Returns |
|---|---|---|
| `fn_marketer_statement_summary` | **every** row in the range | the per-bucket totals and the transaction count |
| `fn_marketer_statement_range` | the range, **capped** at 2000 | the detail rows |

A statement over a year could be thousands of rows, so capping the detail is unavoidable. Computing
the **summary** from that capped detail would not be: it would silently under-report every total the
moment the cap bit, and a statement whose own totals are wrong is worse than no statement. So the
totals are aggregated in the database over every qualifying row and the detail is a separate,
bounded read. The response carries `truncated`, and both the app and the emailed copy print *"the
summary above covers all N"*.

The capped detail keeps the **newest** rows and prints them **oldest-first** — `order by created_at
desc, id desc limit N` inside, `order by created_at asc, id asc` outside. A plain ascending `LIMIT`
would truncate the newest end, which is exactly the activity the reader opened the statement to see.

**Corrected 2026-10-15 (BUGLOG #149):** this originally sorted by `id` alone, on the stated
reasoning that `id` and `created_at` are "both monotonic in practice". They are not. `id` is drawn
at INSERT; `created_at` defaults to `now()`, which is **transaction start** — so a transaction that
begins early and inserts late carries a higher id with an earlier timestamp, and this system takes
row locks under concurrency as a matter of course. The statement printed `created_at` while sorting
by `id`, so rows came out of time order and the running Balance column read as nonsense. `id`
remains the tie-breaker, because the two halves of a transfer share a timestamp to the microsecond.

## 3. The reading: which ledger entry is which M-PESA category

The reference prints eight fixed rows. Five of them this system can fill:

| Reference row | Ledger | Direction |
|---|---|---|
| SEND MONEY | `transfer_out` | paid out |
| RECEIVED MONEY | `transfer_in` | paid in |
| AGENT DEPOSIT | `credit`, **except** game winnings | paid in |
| AGENT WITHDRAWAL | `withdrawal` | paid out |
| OTHERS | `adjustment`, `reversal`, and credits with `meta.source = game_withdrawal*` | either |

**Game winnings are OTHERS, not AGENT DEPOSIT.** They are a credit, but an agent did not deposit
them — the platform paid them out. Filing them under AGENT DEPOSIT would make that row mean two
different things, and the row exists to be read. Pinned by a test in both the route suite and the
real-Postgres suite, because it is a judgement call a future refactor could "tidy" away.

**Rejected:** doing the bucketing in TypeScript. The mapping is an aggregate over rows the API never
receives — the whole point of §2 — so it has to run where the rows are. It is mirrored in
`testutil.ts` for the in-memory harness, and the two are pinned to the same cases on purpose.

## 4. ⚠ The two rows that are structurally zero

**LIPA NA M-PESA (PAY BILL)** and **LIPA NA M-PESA (BUY GOODS)** will read `0.00` on every
statement this system can currently produce, whatever the marketer did.

**Verified 2026-10-15:** the mpesa_2 app makes exactly six server calls —
`auth/login`, `auth/login-web`, `me`, `me/transactions`, `me/transfer`, `recipients/lookup`. The
airtime, bundle, pay-bill and buy-goods screens are **local only**: `AppState.kt:150`
(`if (actionId == "airtime") airtime += amount`) mutates handset memory and no ledger row is ever
written. There is no `meta.source` for a purchase anywhere in `packages/db/migrations` — the only
four are `game_withdrawal`, `game_withdrawal_approved`, `marketer_transfer`, `self_service_demo`.

So the owner's *"bought which credit"* is **not answerable today**, and the statement says so rather
than implying it: the viewer prints a line under the summary stating that those two rows read 0.00
whatever was spent in the app. The rows themselves are printed because the reference prints them and
a table missing two of its eight rows reads as broken.

**To make them mean something**, those four flows must debit the wallet through an RPC that writes a
ledger row — which brings its own decisions (does buying airtime with funny money reduce the
balance? can it overdraw? what is `airtime_balance_cents` for?). That is a separate piece of work,
not a line in this one.

## 5. The email path, and the address that does not exist

`marketers` has `id, name, phone, status, site_id, sessions_valid_after` — **no email column**.
`profiles` (the website account) has none either, and the API never reads one. So the reference's
"Send via E-mail" had no destination.

| Decision | Rejected | Why |
|---|---|---|
| The marketer **types** an address when they choose email | add an email column + a collection flow | Bigger, and it would have to be collected somewhere before this screen is useful. The field says *"We don't have an address on file, so tell us where to send it."* |
| `POST /marketers/me/statement/email` | `deliver=email` on the GET | A GET that sends mail is a GET a retry, a prefetch or a crawler can fire. |
| ~~**HTML + plain text**, no attachment~~ **REVERSED — see §5a** | — | The original reasoning was that there is no PDF renderer here and the `EmailSender` port carries no attachments. Both were fixable, and the owner supplied the reference. |
| 503 `EMAIL_NOT_CONFIGURED` when no sender | report success | `makeResendSender()` returns null without `RESEND_API_KEY` + `EMAIL_FROM`. A delivery that silently does nothing is the worst of the three outcomes. |

### 5a. REVERSED 2026-10-15 — the email carries a PDF

The owner supplied the reference the exported statement should look like, and it is a **PDF**. The
original decision (HTML and plain text only) rested on two things that turned out to be fixable:

- **"There is no PDF renderer here."** There is now: `pdfkit@0.20.2`, pure JavaScript, so the API
  image gains no native dependency. **Rejected:** rendering HTML with a headless browser — that
  means shipping Chromium for one document. **Rejected:** `pdf-lib` — fewer dependencies, but this
  page is a fixed-width multi-page table, which is the layout pdfkit's text and graphics API is
  actually good at.
- **"The `EmailSender` port carries no attachments."** It does now: `EmailMessage.attachments`,
  base64, passed straight through to Resend and omitted entirely when empty (Resend rejects an
  empty array).

**The PDF is the deliverable; the HTML body is a preview of it**, built from the same DTO so the two
cannot disagree about a figure. The body says so in its first line rather than leaving the
attachment to be noticed.

**What the reference added to the document**, now in both the PDF and the in-app page:

| | |
|---|---|
| **Email Address** header field | the address on file (0207), or "Not set" |
| **Transaction Status** column | always `Completed`, and that is a statement about this system: the ledger records settled movements only — a row exists because money moved. Carried per-row so the page and the PDF cannot each hardcode a different answer if a pending state ever appears. |
| **Completion Time** as `2026-10-14 21:24:50` | sortable, 24-hour, seconds included. The receipt keeps its friendlier "14th Oct 2026 \| 9:03 pm" — a receipt is addressed to a person, a statement column is scanned. |
| **Page N of M**, and the approval seal | — |

**Two passes over the pages.** "Page 1 of 255" cannot be written until the last page exists, so the
document is built with `bufferPages` and every page is revisited to stamp its header. Pinned by a
test that asserts the same M on every page — it fails the moment a single pass writes "of 1".

**Row heights are measured before anything is drawn.** The Details column wraps, and a row that
would not fit starts the next page whole. Without it pdfkit reaches the bottom mid-row and adds a
page *by itself* — a page this code never knew about and so never gave column headers to. That is
the precise signature the test asserts: one header per page.

**The marketer's own number is printed in full**, as the reference prints it, and is passed in
explicitly rather than read from the DTO (whose copy is masked for the app, docs/58). This document
is generated on the server and addressed to the marketer or an inbox they nominated; the in-app page
already shows it whole. No counterparty number appears anywhere, because none is stored.

**Scale, measured:** 2,000 detail rows — the cap — render to **52 pages, 167 KB, in ~1.1 s**. The
emailed detail is no longer capped at 400 rows; that limit existed because an HTML table of
thousands of rows is a mail nobody opens, and a paginated document has no such problem. The HTML
preview still shows the last 400.

The approval seal reproduces the reference's operator identity, consistent with the decision
recorded in docs/64 §5a.

**The residual risk, stated:** an authenticated marketer can send a fixed document to a chosen
address at 3/min. The body is not attacker-controlled — it is their own statement and nothing else —
so the only lever is the recipient, and the budget makes that uninteresting. Every value in the HTML
is escaped; the one field that is not the server's own arithmetic is a counterparty name, which
reached the database from a registration form (pinned by a test that registers
`<script>alert(1)</script>` and asserts it comes out escaped).

## 6. Dates: East Africa Time, inclusive at both ends

The period is bounded in **EAT**, like `mpesa.ts` and the app's `Receipts.kt`. A statement bounded
at the server's UTC midnight would silently include or exclude three hours at each end **and would
disagree with the timestamps printed in its own detail rows** — most visibly for a transaction after
21:00 UTC, which is already tomorrow in Nairobi.

- `from` → the instant EAT midnight begins on that day.
- `to` → the instant EAT midnight begins on the day **after**, so the end date is inclusive.
- Asserted on real Postgres to the microsecond: a row exactly at `from` is in, a row exactly at `to`
  is out.

`parseDay` round-trips through `Date.UTC` to reject impossible dates. Without it `2026-02-30` parses
as a number triple and rolls into March, producing a statement for a period nobody asked for.

On the app side the period is a `Ymd` — a calendar date with no time and no zone — because the three
places it is written disagree: the picker hands back UTC midnight, the API takes `YYYY-MM-DD`, the
field shows `dd/MM/yyyy`. Carrying an instant between those is how a statement starts a day early.
`YmdTest` asserts the picker round-trip under five device zones including Honolulu, since a
zone-reading bug passes every test written in Nairobi.

**The six-month rule is enforced, not merely announced.** The reference prints a note saying longer
periods are emailed; past 183 days the in-app option is disabled and the choice snaps to email.
183 days rather than "six calendar months", so the rule is the same length in February as in July.

## 7. The QR

Generated **on the server** (`qrcode-generator@2.0.4`, zero dependencies) and shipped as a module
matrix — size plus a row-major `'0'/'1'` bitstring. The app draws squares from it.

| Decision | Rejected | Why |
|---|---|---|
| Server-side, matrix over the wire | a QR encoder in the Android app | The app builds offline and has no QR dependency; hand-rolling Reed-Solomon to avoid one is 400 lines to prove correct. One implementation also means the page, the email and anything added later cannot disagree about what the code says. |
| `qrcode-generator` | `qrcode` | `qrcode` pulls `pngjs` and `yargs`; this needs a matrix, not a PNG, and zero transitive dependencies is the smaller supply-chain surface for the API image. |
| It encodes the facts **on** the page | a URL | Somebody scanning reads back what they are holding, not a link they have to trust. The number in it is the masked form, because a statement is forwarded and a QR is not read by the person holding it. |

## 8. Budgets

| Route | Limit | Why |
|---|---|---|
| `GET …/statement` | 6/min **per user** | An aggregate over a marketer's whole history — the one marketer-facing read worth a tight budget. |
| `POST …/statement/email` | 3/min **per user** | Also spends an outbound send on somebody else's quota. |

`by: "user"`, not `by: "ip"`, for the carrier-NAT reason set out in docs/63: every marketer is behind
Kenyan carrier-grade NAT, so an IP budget throttles honest users and barely inconveniences one
account. Both limits are pinned by a test — including that one marketer exhausting their budget does
not lock out the next.

## 9. Verification

| Claim | How |
|---|---|
| The reading, the shape, the dates, the budgets, the email | `app.marketers.statement.test.ts` — **22 tests**. Two guards **proven to fail** on their regressions: filing game winnings as a deposit, and bounding the period at UTC midnight. |
| The SQL itself, on all 206 migrations | `e2e_marketer_statement.py` — **23/23**, including the truncation invariant and the anon/authenticated revokes |
| Nothing else regressed | full API suite **2318 tests, 0 failures**, 10 skipped |
| The app's date handling | `YmdTest.kt` — 10 tests, including the picker round-trip under five device zones |
| The screens render as the reference | **NOT VERIFIED.** No emulator has run: the build container has no KVM. |

**Assumption, not verified:** that `RESEND_API_KEY` and `EMAIL_FROM` are set in production. If they
are not, the email option returns 503 and the app says email is not set up — which is the designed
behaviour, not a failure, but it means the option is dormant until those are configured.
