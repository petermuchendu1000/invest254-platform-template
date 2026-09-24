# 50 — Real/Demo switch, game sounds, live chat, two-factor and identity checks

This change adds five things players and brands asked for: a Real/Demo switch, game sounds with a mute toggle, human live chat with WhatsApp, two-factor sign-in, and identity checks. Bugs found along the way are BUGLOG #75–#79.

## Real/Demo switch (DEMO-1)

| | |
|---|---|
| Where | The balance pill (top bar, desktop and phone). The chevron opens **Switch account**, which lists Real Account and Demo Account with their balances. |
| Switching | `POST /wallet/mode {mode}`. Switching is refused while a contract is open or Auto is running (`OPEN_POSITIONS`). A marketer account is demo-only (`MODE_LOCKED`). The switcher closes after a switch. |
| Play money | `POST /wallet/demo/topup` refills the demo balance to KES 10,000 ("Refresh demo balance"). It can't be withdrawn. |
| Labels | Demo mode shows a "D" badge and a DEMO label on the pill, and DEMO tags on positions and history. The trade-screen banner and the switcher disclaimer were removed at the owner's request (BUGLOG #80). |
| Engine | An account in demo mode is handled like a marketer demo account: separate balance and no pool. This is the only engine change and it was authorised by the owner. The mode is read on every trade, and if the check fails the trade takes the real path. |

## Game sounds (SOUND-1)

Kenney "Interface Sounds" (CC0, public domain; `apps/web/public/sounds/LICENSE.txt`) are used as six short mono MP3s: tap, place, win, loss, message and toggle. They play through Web Audio, starting after the first tap, as browsers require. The speaker button in the top bar mutes and unmutes. The choice is saved per device (`pp:sound-muted`). A trade plays *place*, then *win* or *loss* at settlement, and a new support message plays *message*.

## Live chat (CHAT-1, migration 0167)

- **Player:** Customer Care from the top bar, the phone bottom nav, the account menu, or a floating button on classic brands. Players can send text, photos (compressed before upload, up to 5 MB), short videos (up to 15 MB) and voice notes (up to 3 MB). The greeting names the brand and, when set, its WhatsApp number. Agents are shown as "Support". An unread badge appears on the Live Chat button.
- **Back office:** **Player chats → Live chat** has Open / Resolved / All tabs and search by username or phone. Agents reply with the same attachments and can Resolve or Reopen. A player's next message after a resolve opens a new thread. The nav item shows the unread count.
- **WhatsApp:** Console → Brand → Identity → "WhatsApp support number". It is saved normalised (`+2547…`) and shown as "WhatsApp Care" in the account menu, which opens `wa.me`.
- **Storage:** attachments are stored in Postgres and served only through HMAC-signed links that expire after one hour. They are deleted after `CHAT_MEDIA_RETENTION_DAYS` (default 90) by the API's 6-hourly job.
- **Polling:** every 3 s while the chat is open, 20 s while it is closed, and 5 s for the inbox.

## Two-factor sign-in (ACCT-1) — currently OFF for players

**Switched off** (BUGLOG #80) until SMS codes via Africa's Talking are ready: hidden in the web (`PLAYER_TWO_FACTOR` in `lib/account/accountUi.ts`), and the API refuses player and marketer enrolment unless `PLAYER_MFA_ENABLED=1`. Staff two-factor is unchanged. When it is on: Account menu → **Two-Factor Auth**. The dialog shows a QR code and key for any authenticator app, plus 8 recovery codes. It turns on only after the player confirms they saved the codes and enters a valid code. From then on, sign-in asks for the 6-digit code, or a recovery code ("Lost your phone?"). Players can turn it off with a current code. The existing `/auth/mfa*` API is used unchanged.

## Identity checks (ACCT-1, migration 0168)

- **Player:** Account menu → **Verify Identity** (the item shows "in review" or "verified"). The player picks a document type and enters the name, number and date of birth (18+). They then add the front, the back (ID and licence) and a selfie, and can use the camera directly. Status can be Under review, Verified, or Not approved with the brand's note and a "Send new documents" button.
- **Brand:** **Players → Identity checks** has To review / Approved / Not approved tabs. Review shows the document images and details. Approve is one click; Reject needs a note. The player's back-office page shows the latest status. Every decision is audited as `kyc.review`.
- **Scope:** a brand admin sees only its brand, a platform admin only its platform, and the System owner sees all.
- **Money:** verification does not gate deposits or withdrawals.

## Tests

| Suite | Result |
|---|---|
| `apps/web/e2e/account.e2e.mjs` (real API, engine, web and Postgres; registers a fresh player each run) | 46/46 |
| `apps/web/e2e/digits.e2e.mjs` | 34/34 |
| `apps/web/e2e/roles.e2e.mjs` | 198/198 |
| `e2e_identity_verification.py`, `e2e_live_chat.py`, `e2e_account_demo_mode.py`, `e2e_demo_isolation.py` | 34, 30, 23, 5 — all pass |
| `npm test` (includes the scope matrix over the new `/admin/chat` and `/admin/kyc` routes) | 1181 pass, 0 fail |
