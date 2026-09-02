# 33 — Telegram/email payout approvals + superadmin password gate (Issue 1)

> **Status: implemented on `feat/telegram-approvals-issue1`.** Real-money payouts are moderated through
> a bank-grade Telegram channel (and email), approval is gated by the superadmin's account password on
> every surface, and demo/"funny money" transfers are no longer gated (migration 0109).

## 1. What rides the approval channels (real money only)
| Flow | Table / rail | Money | Alert | Approve does |
|---|---|---|---|---|
| Player withdrawal | `transactions` provider=`mpesa` | **Real** | yes | approve → Daraja B2C payout |
| Marketer **commission** | `commission_payouts` | **Real** | yes | approve **+ mark-paid** (operator sends M-Pesa manually) |
| Demo game→wallet ("funny money") | `transactions` provider=`internal` | Fake/demo | **no** | n/a — INSTANT, no approval (0109) |

`affiliate_payouts` is legacy/unused (0 rows) and is untouched.

## 2. Notification content (thorough, bank-grade, emoji-free)
Every alert shows: **amount**, **client/site**, **requested by + user type** (Player/Marketer),
**destination M-Pesa**, **timestamp**, and a **reference**. No emojis/icons. Rendered with Telegram
HTML; all dynamic fields are HTML-escaped (injection-safe). Email uses a light, labelled advice-note
template (`buildPayoutEmail`).

## 3. Organisation (approved / rejected / waiting)
- **In-place lifecycle:** each request is one message that updates `AWAITING APPROVAL → APPROVED/REJECTED
  by <superadmin> on <time>` in place.
- **Forum topics (optional):** set `TELEGRAM_FORUM_CHAT_ID` + `TELEGRAM_TOPIC_WAITING/APPROVED/REJECTED`
  so alerts post to the Waiting topic and settled records mirror into the Approved/Rejected topics.

## 4. The password gate (superadmin account password)
- **Only Approve** is gated (it releases cash). **Reject** is immediate (it only returns funds).
- The gate applies on **every** approve surface — dashboard, Telegram, email confirm page, and bulk —
  so it can't be bypassed via the weakest surface.
- Verification is `verifyApprovalPassword`: the supplied password is checked (scrypt, constant-time)
  against any **active `platform_superadmin`** credential. Nothing new to store.
- **Telegram flow:** tapping **Approve** does NOT execute — the bot replies with a force-reply prompt
  carrying a human-readable *authorization reference* token (`WA/CA-<msgId>-<uuid>`). The superadmin
  replies with the password; the bot verifies, executes, **deletes the password message + prompt**, and
  edits the original card to APPROVED. A wrong password deletes the message and asks to retry.
  The token makes recovery **stateless** (no server session), so it survives multiple app machines.

## 5. Demo/"funny money" is instant again (migration 0109)
Migration 0108 had gated the demo game→wallet transfer behind approval and routed it to the bot. `0109`
restores the pre-0108 **instant** `fn_marketer_game_withdraw` (debit demo + credit marketer wallet +
`success` in one call), leaves the shared `fn_approve_withdrawal`/`fn_reject_withdrawal` intact for the
real M-Pesa rail, and **backfills** any internal rows left `pending` by 0108 (credits the intended
transfer, marks `success`). Validated on the real schema inside a rolled-back transaction.

## 6. Deploy order (IMPORTANT)
The code assumes the DB is instant, so **apply migration 0109 first, then deploy the API**. New env vars
(§ `.env.example`): `TELEGRAM_FORUM_CHAT_ID`, `TELEGRAM_TOPIC_WAITING/APPROVED/REJECTED` are optional
(in-place updates work without them).

## 7. Tests
- `telegram.test.ts` — builders, callback/token parsing, and the full webhook flow (approve prompt,
  password reply success/failure, immediate reject, commission, unauthorized, idempotent noop).
- `app.telegram.e2e.test.ts` — webhook over HTTP: secret gate, approve opens prompt (no approval),
  correct/incorrect password, immediate reject, unauthorized.
- `app.approvalgate.e2e.test.ts` — dashboard/API approve requires the password; reject does not.
- `app.withdrawals.e2e.test.ts` / `paymentservice.test.ts` — demo path is instant (not gated).
Full suite green: **724/724**; `tsc -b` + web `tsc` clean.
