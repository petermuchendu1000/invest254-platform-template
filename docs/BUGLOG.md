# Bug Log

Running log of bugs caught (new or pre-existing) while working through issues, with status. Each
entry: what, evidence, root cause, impact, and resolution.

---

## #79 — Opening the sign-in window crashed the whole app (found in e2e before merge) — FIXED (branch `feat/demo-sound-chat-account`)
- **Found by:** the new `apps/web/e2e/account.e2e.mjs`. After signing out, tapping "Log in" replaced the page with "The app failed to load". The browser console showed React error #310 ("rendered more hooks than during the previous render").
- **Root cause:** the new two-factor step in `AuthModal` declared its three `useState` hooks after the component's `if (!open) return null`. The first render with the window open ran more hooks than the closed render before it. Every brand's sign-in would have broken. Nothing reached production.
- **Fix:** the hooks now sit above the early return, and the code step resets when the window closes or the mode changes.
- **Guard:** a one-off `react-hooks/rules-of-hooks` scan of all of `apps/web/src` is now clean. The repo has no ESLint set up; adding that rule to CI is recommended.
- **Also fixed during the same e2e pass:**
  - The account switcher stayed open after a switch. It now closes, as in Deriv's switcher.
  - On phones the demo banner pushed the buy buttons under the bottom nav. It is now one line on phones.
  - The chat header said "A live agent is here to help" even when nobody is online. It now says "Our support team replies here".

## #78 — No identity verification for players (ACCT-1) — FIXED (migration 0168)
- **What:** the mock's "Verify Identity" item had nothing behind it. Brands had no way to collect or review an ID.
- **Fix:**
  - Players choose a document type (National ID, passport or driving licence) and enter the name, number and date of birth (18+ only). They upload the front, the back when needed, and a selfie; the phone camera opens directly.
  - The brand reviews on the new **Identity checks** page and approves, or rejects with a note the player sees. The player's page in the back office shows the latest status.
  - The database refuses: a second pending submission, re-submitting once verified, another player's file, re-used files, a PDF selfie, over 6 MB, more than 12 unused uploads a day, and reviews outside the reviewer's brands or platform.
  - Every decision is audited (`kyc.review`). Unused uploads are removed after two days.
  - Files are served only through signed links that expire after one hour.
- **Scope note:** verification does **not** block deposits or withdrawals. It is shown to the player and to staff only.
- **Verification:**
  - `e2e_identity_verification.py`: 34/34 (BEFORE 0167 / AFTER 0168).
  - `app.kyc.test.ts` passes, and the scope matrix now covers `/admin/kyc/:id`.
  - The real-stack e2e covers submit, then review with the three images, then approve, then "verified" in the player's menu.

## #77 — Players could not use two-factor sign-in (ACCT-1) — FIXED (web; API unchanged)
- **What:** the API already supported TOTP for every role, but the player sign-in window could not send a code. The account menu also had no way to turn it on. A player who enabled 2FA through the API would have been locked out.
- **Fix:**
  - A new **Two-Factor Auth** dialog shows a QR code, the key and 8 one-time recovery codes. Two-factor turns on only after the player ticks "I saved my recovery codes" and enters a valid code. The same dialog turns it off.
  - When needed, sign-in asks for the 6-digit code or a recovery code.
- **Verification:** the real-stack e2e sets up 2FA with a real TOTP and signs out. It then checks that a wrong code is refused and that the right code signs the player in.

## #76 — "Live Chat" had no human behind it; no WhatsApp contact (CHAT-1) — FIXED (migration 0167)
- **What:** Live Chat opened the AI assistant widget, or nothing when that widget was off. Players could not reach a person, and brands could not list a WhatsApp number.
- **Fix:**
  - **Player side:** a Customer Care chat on every brand, from the top bar, the phone bottom nav and the account menu. It supports text, photos (compressed on the phone), short videos and voice notes, and shows an unread badge. Agents appear as "Support".
  - **Back office:** **Player chats → Live chat** lists open, resolved or all threads with search. Agents reply with the same attachments and can resolve or reopen. The nav shows an unread count.
  - **WhatsApp:** each brand can set a WhatsApp number in the console (Brand → Identity). It is shown as "WhatsApp Care" in the account menu and in the chat greeting.
  - **Database rules:** one open thread per player, and messages always carry the thread's brand. Limits are 5 MB for photos, 15 MB for videos and 3 MB for voice notes. The API refuses cross-brand access.
  - **Retention:** attachments are removed after 90 days (`CHAT_MEDIA_RETENTION_DAYS`), by a job that runs every 6 hours.
- **Verification:**
  - `e2e_live_chat.py`: 30/30.
  - `app.livechat.test.ts` passes, and the scope matrix covers `/admin/chat/threads/:id`.
  - The real-stack e2e covers player text and photo, then the agent reply, then the unread badge, then resolve.

## #75 — Demo mode existed in the database but the engine traded it as real money (DEMO-1) — FIXED (engine change authorised by the owner; no migration)
- **What:** migration 0123 added `wallets.account_mode` and a separate demo balance. The engine, however, only put **marketers** on the demo path. A player switched to demo would still have traded real money against the pool. There was also no switch in the UI.
- **Fix:**
  - **Engine** (authorised, "with a demo label"): an account in demo mode is now handled exactly like a marketer demo account. It uses a separate balance, never touches the pool, and positions are flagged `demo`. The mode is read fresh on every trade; marketer status is cached for 60 seconds; if the check fails, the trade takes the real path.
  - **API:** `POST /wallet/mode` switches accounts, and is refused while a contract is open. `POST /wallet/demo/topup` refills the demo balance to KES 10,000.
  - **Web:** the balance pill now has a Real/Demo switcher (as in the mock) and a Refresh demo balance button. In demo mode a "Demo account" banner says results can differ from real-money play, and demo trades are tagged DEMO in positions and history.
- **Verification:**
  - `app.demo1.test.ts` and `demo1.pg.test.ts` pass.
  - The real-stack e2e confirms a demo trade moves only the demo balance, while the real balance stays the same.

## #74 — Digits screen: digit row overlapped AUTO/MANUAL on phones; Live Chat button did nothing; no positions, session or history view (DIGITS-UI) — FIXED (branch `ui/digits-mock`, web only; engine untouched)
- **Found while rebuilding the digits screen to the owner's mocks (desktop and phone):**
  - **Overlap:** on phones the digit-statistics row sat on top of the AUTO/MANUAL toggle. The centre column was `min-h-0` inside a fixed-height flex column, so it shrank below its content (visible on the pre-change screenshot at 390×844).
  - **Dead button:** the bottom nav's "Live Chat" opened the support store even when the support widget is switched off, which is the default, so tapping it did nothing.
  - **Missing views:** there was no Open / Closed view of positions, no session P/L, and no single transaction history. Players had to leave the trade screen for the history page.
- **Fix (web only):**
  - **Layout:** on phones the columns no longer shrink below their content.
  - **Bottom nav:** Live Chat shows only when support chat is on. Otherwise "Guide" opens How to Trade.
  - **Screen layout (to the mocks):** desktop has a positions rail (Open / Closed / History plus session totals), the chart and digit row in the centre, and the trading console on the right. Phones have market tabs on top and a bottom nav with a Positions sheet.
  - **Top bar:** Trader's Hub, Deposit, Withdraw, History (the ledger-backed transaction list), AI, How to Trade, the balance pill, notifications and the account menu. The menu includes Change password, using the existing API.
  - **Chart:** tools for line/area, drawing a horizontal line, PNG export, zoom, show-all and back-to-live, plus an outlined live price tag and a start dot.
  - **Result card:** P/L, stake, payout, result digit, duration and the contract.
  - **Auto:** STOP takes the first slot while Auto runs, and the header shows "Auto · <side>".
  - **Unchanged:** payout figures still come from the engine's 0.95 factor. Nothing in the engine or API changed.
- **Verification:**
  - New `apps/web/e2e/digits.e2e.mjs` passes 34/34 against the real local stack (API, engine and web), covering a real trade from open to settle.
  - The role e2e still passes 198/198.
  - Screenshots checked at 320, 390, 768, 1440 and 1920 px.

## #73 — Mega Pay "rejected the API key" for the live key; test mislabelled bad keys as valid; saving config would break deposits — FIXED (branch `fix/megapay-live-endpoint`, no migration)
- **Reported:** Test connection said "✕ Mega Pay rejected the API key" for the key that is collecting live payments.
- **Evidence:** read-only status queries against Mega Pay with a sentinel id, which never move money.
  - `/backend/v2` (our default host) answers every real key with "Invalid Api Key. Use Test Api Key: MGPY1EvRts3I". With the test key it answers "Invalid email. Use Test Email: megapaysandboxtest@gmail.com". It is a sandbox.
  - `/backend/v1` is the only host in Mega Pay's documentation. With the owner's key and account email it answers "Transaction request does not exist!", meaning the key and email were accepted. A wrong key gets "Api Key does not exist!" and a wrong email gets "Email does not exist!".
  - The email the owner typed (`cosiam22@…`) does not exist on Mega Pay. The account email is `cosialm22@…`.
  - Live deposits keep working (386 succeeded in 3 days) because they use the deployment's `MEGAPAY_API_BASE`, not the code default.
- **Root cause:**
  - The code, the gateway form and the probe all defaulted to `/backend/v2` for both environments. The form's Environment also defaulted to Sandbox.
  - The probe only looked for "invalid … key". On production it reported a wrong key or wrong email as valid.
- **Latent risk (worse than the report):** console-saved Mega Pay config layers over env. Saving the live key with the form's default host would have moved live deposits onto the sandbox, and every deposit would have failed. The same applied to per-platform and per-brand Payment accounts, which resolve without env.
- **Fix:**
  - The host now follows the environment: production uses `/backend/v1`, sandbox uses `/backend/v2`.
  - A production config carrying the old v2 default is corrected to v1. A genuinely different host is kept.
  - The deployment's `MEGAPAY_API_BASE` is still used verbatim, so live deposits are unchanged.
  - The probe reads Mega Pay's actual messages: wrong key, wrong email, "live key in Sandbox — set Environment to Production", or valid. It never echoes the key.
  - The form's host field is blank by default ("Automatic (follows Environment)").
- **Verification:**
  - `megapay.endpoint.test.ts` has 8 tests built on the recorded live responses.
  - The existing gateway and Mega Pay tests pass, and `npm test` passes 1177/1177.

## #72 — The same job lived on two or three pages; some links led to a 404; "Needs setup" miscounted brands (UI-F) — FIXED (branch `ui/f-focused-pages`, no migration)
- **What:** an audit of the console and back office found the same function on several pages, often with different rules.
  - Pool mode and today's budget could be set from the brand page and the Withdrawal pool page.
  - A gateway could be switched on from the Gateways list, the gateway page and the brand's Payments tab.
  - There were two audit trails: `/platform/audit` for the owner and `/platform/activity` for platform admins.
  - Marketer expenses could be logged from the user page and from Marketer payouts, and the two used different category lists (`tiktok_promo` against `promo`).
  - Brand admins could be appointed from the user page for the owner only, a path no one could reach.
  - Player overrides had an editable branch in the back office that could never render.
  - The back-office Overview repeated the Users, Balances and RTP panels from other pages.
- **Broken links found along the way:**
  - Old back-office URLs (`/admin/game`, `/admin/audit`, `/admin/logs`, `/admin/mpesa`, `/admin/fly`) sent brand admins to console pages, which returned a 404.
  - The users table nested a phone `<a>` inside the name `<Link>`, which is invalid HTML.
  - Platform-level audit rows (no brand) never showed to platform admins.
- **Wrong figure:** the console's "Needs setup" KPI counted a brand as not ready unless it had its own legacy M-Pesa fields. Since PAY-1, every brand gets paid through its own accounts, its platform's accounts or the System accounts, so live brands were flagged.
- **Fix: one home per job, with links everywhere else.**
  - Brand page tabs are now Identity, Branding, Economy, Add-ons, People and Legal. Pool, payments and audit are links to their own pages.
  - People covers brand admins (appoint and remove) and a read-only player list with overrides. Its "Manage in back office" button opens the brand session straight on that player.
  - There is one audit log, `/platform/audit`, scoped on the server. `listPlatformAudit` now includes platform-level rows that target the caller's platform. `/platform/activity` forwards to it.
  - The Gateways list only shows state. Switching a gateway on happens on the gateway page, where a per-brand switch appears only for brands that own that gateway add-on; brands without it link to their Add-ons tab.
  - The back-office Overview shows trends plus a "Needs attention" list of deep links. Game health moved to Reports → Health.
  - Users has quick-filter pills with counts, reads `?status=` and `?role=` from the URL, and drops the repeated columns.
  - The user page links to Marketer payouts (which reads `?marketer=`) for marketer money, and to the console for brand admins. Its overrides are read-only.
  - Old URLs go through `MovedToConsole`: operators land on the console page, brand admins on `/admin`.
  - Readiness now counts only a live domain.
- **Owner request #32, done in the same change:** the Brand back office picker now has you choose a platform, then a brand. It shows brand counts per platform, keeps the platform in `?platform=`, remembers it on the device, hides archived brands unless asked, says which other platform matches a search, and uses a select on phones.
- **Verification:**
  - Role e2e: 198/198 (+17 new UI-F and picker checks).
  - `npm test`: 1169/1169.
  - `platformaudit.pg.test.ts` has a new platform-level scope case and passes.
  - Screenshots taken on the real local stack.
- **Follow-up (caught during deploy verification):** the first merge did not deploy the API. The new pg test called `listPlatformAudit({ limit })` without `platformId: null`. `tsc -b` type-checks test files, so the deploy's verify step failed, while the per-app `--noEmit` check had passed. Fixed in the test. The pre-merge check is now the same `npx tsc -b packages/shared apps/engine apps/api` that CI runs.

## #71 — Add-ons: paid charts never reached players; catalog, requests and billing gaps (ADDON-1) — FIXED (branch `feat/addon1-marketplace`, migration 0166)
- **What (owner request, 2026-09-23: "a complete overhaul of the /addons page … a total joke"):**
  - **Players never saw paid charts (critical, found in the audit).** `/site/brand` coerced every `chart_style` except `candlestick` to `line`. A brand sold *Area graph* (KES 50,000 in production), *OHLC bars* (60,000) or *Baseline* got the free line chart.
  - The catalog had no descriptions, the pricing model could not be edited, add-ons could not be hidden, and there were no adoption numbers.
  - Approving or declining a request overwrote the brand's reason, and a request could not be withdrawn. A decline returned `"rejectd"`.
  - A price change before approval changed what the brand paid. Removing an add-on before it was invoiced still billed it.
  - Brands could not switch between systems they owned. Platform admins had no add-ons page.
- **Fix:** see docs/48.
  - Every chart system is served and rendered: TradingView opens on the brand's series type.
  - Migration 0166 adds the catalog editor RPC with rules, quoted-price billing, void-on-remove, cancel and activate, the brand matrix, and product-named notices.
  - New routes; a rebuilt `/platform/addons` (owner: Requests / Catalog / Brands; platform admin: marketplace + history); a marketplace component used on every tier.
- **Tests:**
  - `e2e_addon_marketplace.py`: BEFORE 4; AFTER 46. All 39 DB suites pass.
  - Unit tests: 1169/1169.
  - Role e2e: 181/181, including 21 new checks.
  - Real stack: the player page on an Area brand renders the area chart.

---

## #70 — Billing was a stub: no invoices, no way to pay, add-on prices never billed, dunning on dates alone (BILL-1) — FIXED (branch `feat/bill1-billing`, migration 0165)
- **What (owner request, 2026-09-23: "a really serious /billing page … what we have is a total basic and a joke"):**
  - There were no invoices. A "payment" was the owner pressing *Mark paid*, which extended the period with no record of what was paid for.
  - Platforms had no way to pay. Add-on prices were shown ("It is billed at KES X") but never charged.
  - The cron moved platforms to past_due / grace / suspended purely on dates, even when nothing had been invoiced.
  - The owner saw each platform's active/archived state, not its subscription standing. There were no revenue figures and no settings.
- **Fix:** see docs/47.
  - Migration 0165 adds consolidated per-platform invoices (plan + each brand's monthly add-ons + pending one-off/setup charges), numbered `PREFIX-YYYY-00001` and billed in advance.
  - Dunning now follows the oldest unpaid invoice (past_due → final notice → suspended), with a reminder at each stage. A paid-up platform returns to active and its brands come back online.
  - Payments: manual (bank / cash / M-Pesa / other, including part payments) and M-Pesa **Pay now**, an STK push from the System account. Every result is verified with STKPushQuery, success *and* failure, so a forged callback can neither pay nor cancel. A 2-minute sweep settles payments whose callback was lost.
  - Settlement is idempotent. Overpayments (rounding up to whole KES, or a double settle) and credits larger than an invoice carry forward as credits instead of being lost.
  - Add-ons get a pricing model (free / one-off / monthly + setup fee). One-off and setup fees are charged on grant, never twice. The System's own platform is exempt, and existing (grandfathered) entitlements are not charged.
  - Owner console: Overview (MRR/ARR, outstanding, overdue, aging, needs-attention, renewals, payments), Invoices, Subscriptions (manage: plan, charge/credit, status, exempt, history), Plans, Settings (seller, prefix, terms, tax, Pay now, overdue timeline).
  - Platform admin page: a due banner that states the consequence and date, plan, next-invoice estimate, usage, invoices with Pay, plan comparison.
  - Printable invoice page.
- **Found while testing on the real stack:** Pay now pre-filled the phone as `00700000003` when the profile stored `07…` (it only handled `254…`), so the Send button stayed disabled. It is now normalised from any stored form (`localPhone`, unit-tested).
- **Behaviour change (production):** the daily lifecycle job now issues invoices. NDUATI (Business, KES 40,000) gets its first invoice on its renewal date (2026-10-19), due 7 days later. MUCHENDU (the System's platform) is exempt.
- **Tests:**
  - `e2e_billing.py`: BEFORE reproduces 3; AFTER 112 checks.
  - `e2e_subscriptions_tickets.py` updated to the invoice-driven lifecycle (33/33).
  - Engine: 5 unit tests. API: 3 route tests and a real-schema pg test. The F-44 cross-tenant matrix now covers the billing routes against a seeded invoice. Web: 4 label tests. Unit total 1167/1167.
  - All 38 DB e2e suites pass.
  - Role e2e: 23 new checks; 163/163 pass.
  - Real stack: Pay now → the stub Daraja client → the reconcile sweep settled the invoice, and the platform went from grace_period to active.

---

## #69 — No per-brand pool view; dynamic distribution had no setting and was off unless a GitHub variable was set; history hid who got what (POOL-1) — FIXED (branch `feat/pool1-overview-auto`, migration 0164)
- **What (owner request, 2026-09-23):**
  - Nothing showed each brand's pool for today: budget, paid, reserved and available.
  - Automatic (dynamic) distribution only ran if the `POOL_DAILY_TOTAL_CENTS` repo variable was set, and then as one envelope across every platform.
  - Dynamic runs were stored as `per_site`, the same as hand edits, and the history never showed each brand's share.
  - Pool controls were duplicated on Controls & economy.
- **Fix:** see docs/46.
  - Migration 0164 adds the overview RPC, per-platform `pool_auto_settings` (dynamic when nothing is saved), and a `source` on each distribution.
  - `PoolOpsService`, the rewritten daily job, four API routes, and a rebuilt `/platform/pool`.
  - Controls & economy now links to the pool page.
- **Tests:**
  - `e2e_pool_overview.py` (BEFORE reproduces; AFTER 22 checks).
  - Engine 3, a real-schema pg test, and unit tests: 1155 pass.
  - Role e2e: 8 new checks, all failed before the fix; 139/139 pass after.

---

## #68 — No C2B configuration: Pay Bill details not editable, C2B URLs never registered with Safaricom (PAY-2) — FIXED (branch `feat/pay2-c2b-config`, migration 0163)
- **What (owner question, 2026-09-23):**
  - `/platform/mpesa` had only STK and B2C settings.
  - The Pay Bill players are told to pay into (`paybill_config`) was seed-only: no API or UI could change it.
  - Nothing could set or register the C2B Confirmation and Validation URLs. Without that registration Safaricom never reports Pay Bill payments, so the manual Pay Bill rail can verify nothing. It works only if someone registers the URLs by hand outside the product.
  - The page also said "Save 3 changes" before anything had been touched: our own auto-filled endpoints counted as edits.
  - The warning said credential changes needed a restart, but they reload within a minute.
- **Fix:** see docs/45.
  - Migration 0163 adds owner-only read and update (validated and audited), Safaricom's URL rules, and a record of each registration.
  - Daraja C2B RegisterURL v2 is wired up.
  - The API has three routes.
  - The M-Pesa page is split into Deposits / Payouts / Pay Bill (C2B) / Credentials. The C2B tab shows status and health, what players see, the URLs, and a Register button.
  - Auto-filled endpoints now count as suggestions, not changes.
- **Tests:**
  - `e2e_c2b_config.py` (BEFORE reproduces; AFTER 18 checks).
  - Engine: 3 tests. API: 1 test.
  - Role e2e: 5 new checks. All 5 failed before the fix; 131/131 pass after.
  - `e2e_c2b_paybill`, `e2e_function_grants` and `e2e_postgrest_surface` still pass.

---

## #67 — Page-level P1s from the UI audit: clipped withdrawal actions, an announcement that couldn't be edited, fake trends, editable-looking read-only overrides, sideways scroll on phones (UI-C) — FIXED (branch `ui/c-page-p1-fixes`, migration 0162)
- **What:**
  - **Withdrawals.** At 1440px the Reject and Mark paid buttons sat past the right edge of the table (Reject measured at x=1505). On a phone, Approve was at x=1146 on a 390px screen.
  - **Announcements.** The "Announcement" template said "Edit the title and body before sending", but there was no text field, and `fn_broadcast_notification` could only send a template verbatim. A brand admin would have sent "We have an update to share with you…" to every player. The clear button's copy said "platform-wide" on a brand page.
  - **Overview.** Trend chips showed "▲100%" whenever the first half of the 30 days was zero, and rising withdrawals were coloured green.
  - **User page.** Player overrides rendered as eight editable inputs, and only a footnote said they were read-only. Nobody in the brand back office can write them.
  - **Phones.** /admin/marketer-finance was 456px wide on a 390px screen. The segmented tab control overflowed.
  - **Brand page.** Add-ons rendered under every tab, and the open tab was not in the URL.
- **Fix:**
  - **Withdrawals.** Actions are pinned to the right edge, and the phone view uses a card list. Four duplicate KPI tiles became one summary line. The kill switch is now a compact row.
  - **Announcements.** Migration 0162 adds `p_title`/`p_body` to `fn_broadcast_notification`. They are trimmed and bounded, blank means the template's own text, and the audit trail records that the text was edited. It is one function, not an overload, and deploy-order safe. The API validates the text, and the page gets Title and Message fields with a live preview.
  - **Overview.** A metric with nothing in the earlier half now shows "New", and each metric is coloured by what counts as good news for it.
  - **User page.** Overrides are shown read-only as values, with "Managed in the console".
  - **Tabs.** One underline `PageTabs` component, with the tab in the URL, replaces the segmented control and the old brand-page tabs. Add-ons now has its own tab.
- **Tests:**
  - `e2e_broadcast_custom_text.py` (BEFORE reproduces; AFTER 11 checks). `e2e_notification_scope`, `e2e_actor_scope_impersonation` and `e2e_function_grants` pass.
  - API test for the edited text and its validation. `charts.test.ts` (trendDelta).
  - Role e2e: 12 new checks. 9 failed before the fix; 126/126 pass after.

---

## #66 — "now ago", browser-dependent dates and numbers, "KES 1,607.5" in the operator consoles (UI-B) — FIXED (branch `ui/b-shared-formatting`)
- **What:**
  - `formatRelativeTime` returns "now" for anything under 5 s, and 13 call sites appended " ago", so tables read "now ago" (seen in System logs).
  - Dates were printed with `toLocaleString()` / `toLocaleDateString()` without a locale, so the same timestamp showed as "23 Sept 2026, 21:03" on one page and "9/23/2026, 9:03:05 PM" on another, depending on the browser.
  - Counts used the browser locale too.
  - Four console pages formatted money with a local helper that dropped the second decimal ("KES 1,607.5").
  - KPI values and money cells wrapped ("KES" on one line, the number on the next).
  - Disabled buttons kept their colour at 50% opacity, so a disabled green "Save" looked live, and `pointer-events-none` stopped any tooltip explaining why.
- **Fix:**
  - `formatAgo` ("just now", "5m ago"; the date after a week).
  - `formatDate` and `formatNumber` pinned to en-KE.
  - `formatKes` everywhere.
  - Money, badges and KPI values no longer wrap; table headers no longer wrap, and `Th`/`Td` gained a `numeric` prop that right-aligns numbers.
  - A neutral disabled style that keeps tooltips working.
  - One toolbar search control, 36px, the same height as the filters.
- **Tests:** `format.test.ts` (no "now ago"; the date shown after a week; en-KE dates and numbers). Role e2e and a screenshot review on seeded data.

---

## #65 — Console shell: collapse control drawn over page content; no Log out on phones; flat, unlabelled navigation (UI-A) — FIXED (branch `ui/a-console-shell`)
- **What (found by the docs/44 UI audit on seeded data):**
  - System owner console: the sidebar header row had no `min-w-0`, so the long subtitle "SYSTEM CONSOLE · ALL PLATFORMS" pushed the collapse chevron out of the 240px sidebar (measured at x=250–282). It sat on top of the first letter of every page title.
  - Every tier on a phone: the account block and Log out were `hidden md:flex`, so an operator could not sign out of a money console from a phone. The horizontal nav strip showed about 3 of 10–16 items, was not sticky, and could hide the current page.
  - Navigation was a flat list (16 items for the owner), with duplicate icons and near-duplicate labels.
- **Fix:** one shared `ConsoleShell` (see docs/44): a truncating workspace header, labelled groups with dividers, one current item, distinct icons, a footer with collapse (⌘/Ctrl+B) and the account with Log out, and a phone top bar plus drawer. Navigation is defined once in `components/console/nav.tsx`.
- **Tests:** role e2e with 16 new checks. Before the fix, 15 of them failed (collapse chevron at x=250 > sidebar 240; no labelled groups; no phone menu or Log out). After the fix all pass, and so do all 98 existing checks. `nav.test.ts` covers the navigation rules.

---

## #64 — Phone-only password reset + "Change number" on withdrawals = wallet theft for players (F-49) — FIXED (branch `fix/f49-payout-to-registered-phone`, migration 0161)
- **What:**
  - The player password reset is phone-only (no OTP) while `ALLOW_UNVERIFIED_PASSWORD_RESET` is on. **Confirmed live on 2026-09-23:** a reset for an unregistered number returns `{"reset":true}` instead of `RESET_DISABLED`.
  - Privileged accounts have been protected by security questions since #4. Players and marketers were not.
  - The withdraw form had **"Change number"**, and `fn_create_withdrawal` accepted any payout phone.
  - So anyone who knew a player's phone number could reset the password, sign in, and request a withdrawal to their own M-Pesa. Only a manual approval stood in the way, and approvers are not told the number differs.
- **Impact (production, read-only):** no evidence of abuse.
  - 74 real withdrawals ever. 2 were to a different number, 0 of those were paid, and none is pending now.
  - Every profile phone has at least 9 digits.
- **Fix (money-side, independent of how an attacker gets in):**
  - `fn_create_withdrawal` (0161) pays out **only to the account's registered number**, compared on the significant 9 digits so every format matches. Anything else is refused with `PAYOUT_PHONE_MISMATCH` (400) and nothing is held.
  - The in-memory double mirrors this.
  - The web form shows the registered number with "Withdrawals are paid to your registered number only" and no Change button.
  - Also tightened: the wallet debit in that function is now filtered by `site_id` as well as `user_id`.
- **Owner decision (2026-09-23): phone-only player reset stays ON until an SMS provider is integrated.**
  - The flag was briefly unset in production (probe returned `RESET_DISABLED`), then restored at the owner's request (probe returns `{"reset":true}` again). Admin-issued reset codes were considered and declined as extra support load.
  - Accepted residual risk: someone who knows a player's number can still sign in and gamble the balance away, but can no longer withdraw it (0161).
  - **Follow-up:** replace the phone-only reset with an SMS one-time code once a provider is chosen. Then unset `ALLOW_UNVERIFIED_PASSWORD_RESET` on `invest254-api`.
- **Tests:**
  - `e2e_payout_phone.py`: BEFORE reproduces any-number acceptance; AFTER, 7 checks cover refusal, nothing held, 3 formats accepted, short number refused and grants.
  - Engine test `F-49` (other number refused, formatted own number accepted).
  - `e2e_account_demo_mode.py` fixture made realistic: numeric phone, withdrawing to the registered number.

---

## #63 — PAY-1: platform admins can run their platform / brands on their OWN payment accounts, honoured by live payments (owner decision 2026-09-23) — DONE (branch `feat/pay1-payment-scopes`, migration 0160, docs/43)
- **Before:**
  - Every deposit, verification and payout used ONE System-wide account set: the `mpesa_config` singleton and the global Mega Pay / PayHero rows.
  - The per-brand M-Pesa fields on the brand page were editable by platform admins but **never read by payments**. The page itself said live routing used the platform-wide config, and was misleading.
  - Per-site `payment_provider_config` rows could exist, but nothing wrote or read them.
- **Design:** docs/43.
  - **Payment owner.** A brand's payment owner is its own scope if active, else its platform's scope if active, else the System.
  - **Drafts until go-live.** Non-global configs stay drafts until an explicit go-live. Go-live is audited and the System owner is notified.
  - **Money-safety invariants, enforced and tested:**
    - (1) No mixing across owners: scoped clients never use env, a stub or a parent scope's account, and an unset rail is refused rather than re-routed.
    - (2) Payouts follow the owner and are refused before approval when the owner cannot pay, so no withdrawal is stranded in processing.
    - (3) Verification and reconcile use the scope recorded on the transaction, so deposits in flight survive a switch.
    - (4) Platform admins cannot set sandbox mode, base URLs, callback URLs or CIDRs. Enforced in the database and the API; otherwise they could point verification at a fake provider.
    - (5) Go-live needs a ready deposit rail, plus a payout account or an explicit "deposits only".
    - (6) The System's manual Pay Bill is hidden and refused for brands on their own accounts.
- **Also:**
  - Platform admins may switch entitled gateways on or off for their own brands.
  - Affiliate B2C payouts follow the owner too.
  - Owner and client caches are invalidated by NOTIFY, with a TTL backstop.
- **Production at deploy:** behaviour-neutral. No scope is active, so every brand stays on the System accounts, and the legacy global RPCs ignore platform rows.
- **Tests:**
  - DB e2e 63/63.
  - Engine money-invariant suite 11/11.
  - Real-schema money path (pg).
  - API 5/5.
  - F-44 cross-tenant matrix and capability contract extended.
  - Browser role e2e 89/89.

---

## #62 — M-Pesa Till number, B2C shortcode and B2C CommandID could never take effect (PAY-0, found while designing PAY-1) — FIXED (branch `fix/pay0-mpesa-till-b2c-fields`)
- **What:** two independent drops.
  - (A) `resolveDarajaConfig` rebuilt the live Daraja config from `mpesa_config` **without** `transactionType`, `tillNumber`, `b2cShortcode` or `b2cCommandId`. A Till (Buy Goods) configuration would have gone out as a Paybill STK to the paybill shortcode, and B2C always paid from the STK shortcode with `BusinessPayment`.
  - (B) `PATCH /admin/mpesa-config` accepted only the older plain fields and silently discarded the four the M-Pesa page sends, so they could not even be saved. Migration 0150 and `HttpDarajaClient` supported all four; the tests built `HttpDarajaClient` directly, so neither gap was visible.
- **Impact (production, read-only):** none so far. `transaction_type = 'paybill'` and `b2c_shortcode`/`till_number` are empty, which matches the defaults. It would have broken the first Till brand or separate B2C shortcode.
- **Fix:**
  - Carried through: DB value first, then env (`MPESA_TRANSACTION_TYPE`, `MPESA_TILL_NUMBER`, `MPESA_B2C_SHORTCODE`, `MPESA_B2C_COMMAND_ID`), then the client defaults.
  - The PATCH accepts and validates them: rail `paybill|till`, CommandID enum, numbers 4–10 digits or empty.
  - The in-memory repository mirrors this.
- **Tests:**
  - `daraja.configfields.test.ts` drives the real factory and reads the Safaricom bodies: Till + PartyB, B2C PartyA + CommandID, env fallback and DB precedence, defaults unchanged. The first two fail on the old code.
  - `app.admin.mpesafields.pay0.test.ts`: saved and read back; 5 invalid values give 400.

---

## #61 — Paged lists silently skipped rows that shared a millisecond with the page boundary (PAGE-1) — FIXED (branch `fix/page1-keyset-precision`)
- **What:** every keyset-paginated list (audit log, system logs, admin transactions/withdrawals/deposits, user list, user activity, affiliate payouts, referrals, commissions, a player's ledger/positions/digits/transactions) built its cursor from the last row's time in **milliseconds** and asked the database for `(created_at, id) < (cursor_ms, id)`. Postgres timestamps carry **microseconds**, so every remaining row in the cursor row's millisecond compared as *newer* and was never shown on any page. Rows written in one transaction share `now()` exactly — e.g. a bulk action's audit rows, a settlement's ledger lines.
- **Evidence:** production `admin_actions` has 1,223 rows in 406 same-millisecond groups (the owner's Audit log could hide them at page boundaries). A real-schema test paging 7 same-transaction ledger rows 2 at a time returned **2 of 7** on the old code.
- **Fix:** each keyset now compares against the cursor row's EXACT timestamp, looked up by its id (`coalesce((select k.created_at from <table> k where k.id = $cursorId [and k.user_id = $owner]), $cursor_ms)`) — an index-friendly InitPlan; the ORDER BY and indexes are unchanged (EXPLAIN on production `system_logs`: PK lookup + the existing `(t, id)` index scan). User-scoped lists resolve the cursor only within the caller's own rows. The activity union resolves across its three sources with guarded casts.
- **Tests:** `keyset.page1.pg.test.ts` (real schema, one transaction = identical timestamps): ledger, positions, player transactions, user activity (21-row union, 3/page), audit, system logs and admin transactions each return every row exactly once; fails on the old code.

---

## #60 — Platform admins could not see or manage a player properly: no detail, bonus adjustments impossible, overrides API with no UI (and no validation), no audit across their brands (docs/42 UI-10) — FIXED (branch `fix/ui10-platform-admin-gaps`)
- **What:**
  - A platform admin's player panel showed only the list row.
  - "Adjust balance" never sent a wallet, so every credit or debit hit **real cash**. The API supported `kind: real|bonus`; bonus could not be adjusted, and a goodwill bonus became withdrawable money.
  - `PATCH /platform/sites/:id/users/:uid/overrides` existed with no read route and no UI. It forwarded the raw body, so a typo reached the database and came back as a 500.
  - No page showed the audit trail across a platform's brands; each brand's Audit tab had to be opened one at a time.
- **Fix (API):**
  - `GET /platform/sites/:id/users/:uid/overrides` (platform-scoped).
  - The PATCH now uses the back office's `parseOverridePatch` (400 `VALIDATION`). The database's fairness fence (0135) still refuses any override better for the player than the brand.
  - `GET /platform/audit-log[?platform=][&site=]`: a platform admin is pinned to its own platform; `?site=` must be in scope (403 otherwise). Rows carry the brand name and actor username.
- **Fix (web):**
  - The Players panel shows a summary: real/bonus balance, deposits and withdrawals, net, turnover and bets, GGR, last active, joined/referred.
  - `BalanceAdjust` has an explicit Wallet (real cash vs bonus) and a review step that states "credit KES X to @user's bonus (non-withdrawable) balance — before → after", blocking any overdraw.
  - `PlayerOverridesForm` shows the brand's limits up front and blocks invalid or player-favouring values before saving.
  - New **Brand audit** page (`/platform/activity`), in the nav for platform admins only (the owner keeps the global Audit log), with a brand filter and Load more.
- **Found alongside, fixed separately:** PAGE-1. Keyset pagination compares a millisecond cursor with microsecond timestamps, so rows sharing the cursor's millisecond are skipped. Production `admin_actions` has 1,223 rows in 406 same-millisecond groups. The new audit query already uses the millisecond-consistent form.
- **Tests:**
  - `app.platform.players.ui10.test.ts`: override read and scope, 6 invalid patches return 400, valid saved, audit pinning and site scope, refused requests never query.
  - `platformaudit.pg.test.ts` (real schema): own brands only, brand and actor names, site filter, paging across a shared timestamp.
  - Browser role e2e 78/78 (+10 UI-10 checks: detail, bonus wallet sent, before→after confirm, override fence, audit page, nav).

---

## #59 — The System console hid who runs each platform, and several owner tools silently acted on the wrong platform (docs/42 UI-9) — FIXED (branch `fix/ui9-owner-console-gaps`)
- **What (six gaps):**
  - **Platform admins by raw uuid.** The owner saw only a COUNT of platform admins and appointed/revoked by pasting a user id. Refusals from the governance RPCs (`NO_SELF_ACTION`, `PLATFORM_NOT_FOUND`, `USER_NOT_FOUND`, `SUPERADMIN_PROTECTED`, `DEFAULT_MARKETER_LOCKED`, `INVALID_ROLE`, `NOT_A_PLATFORM_ADMIN`) were unmapped, so they surfaced as HTTP 500.
  - **Tickets.** The owner's "New ticket" sent no platform, so the API refused it with 400 `INVALID_PLATFORM`, while the dialog said "Assigned to your platform admin". "Escalate to System" was offered to the System admin itself; it would only reassign the ticket to the owner.
  - **Withdrawal pool.** For the owner, `/platform/pool` distributed across every brand of every platform while its copy said "your brands".
  - **Registrar.** The registrar page always edited the default platform. A registrar the owner saved for the default platform was never used: provisioning for the default platform was hard-wired to the env Namecheap account.
  - **Onboarding and domain import.** The onboarding capability banner and the registrar domain import took no platform. Bulk-imported brands were created without the owner's chosen platform.
  - **Add-ons.** The add-on grant/revoke API existed but had no UI. A brand page only ever offered "Request", even to the System admin.
- **Fix (API):**
  - `GET /platform/platform-admins[?platform=]` (who, platform, home brand) and `GET /platform/users/search?q=` (cross-brand username/phone search, 2–64 characters, at most 25 rows, `LIKE` wildcards escaped, default-marketer flag). Both are System-owner only.
  - Governance and pool codes are now mapped to 4xx.
  - `actingPlatform()`: a platform admin is always pinned to its own platform; the owner may name one with `?platform=<uuid>` (a bad value returns 400). It is used by onboarding capabilities, the registrar domain import, `/platform/sites`, and the pool routes (distribute, dynamic, demand, history).
  - Provisioner resolution is extracted to `provisionerfor.ts`. Each platform uses its own stored registrar. The default platform uses its stored registrar, falling back to env; any other platform with none gets no registrar and never borrows the owner's.
  - Production has no stored registrar config, so this is behaviour-neutral live.
- **Fix (web):**
  - `PlatformAdminsPanel` lists current admins (revoke with an explicit "make them" role). Appoint works from search results; ineligible people are shown disabled with the reason, and every action is confirmed.
  - `TicketsView` is role-aware: the owner picks the platform and gets matching routing copy, never sees "Escalate to System", and sees a Platform column. A platform admin is told its ticket goes straight to the System admin.
  - `OwnerPlatformPicker` appears only for the owner, on the registrar, onboarding and pool pages. One choice at the top drives the capabilities banner, the domain import (listing and `platformId` on every onboard) and the manual form.
  - `BrandAddons` gives the owner Assign/Remove with an inline effect statement (active for every player now, the price, and that gateway payments stop).
- **Tests:**
  - `app.platform.admins.ui9.test.ts` (list, filter, search, gating, 4xx mapping).
  - `platformadmins.pg.test.ts` (real schema: literal `_`/`%`, default-marketer flag, platform resolution).
  - `app.platform.registrar.ui9.test.ts` and `app.platform.pool.ui9.test.ts` (the owner's `?platform=` honoured and a platform admin pinned).
  - `provisionerfor.test.ts` (4).
  - `e2e_subscriptions_tickets.py`: an owner ticket without a platform is refused; with one it goes to that platform's admin at level 0.
  - Browser role e2e 68/68 (+22 UI-9 checks).

---

## #58 — Operators could join the affiliate/referral programme and earn on players they manage (docs/42 UI-12) — FIXED (branch `fix/ui12-operators-never-affiliates`, migration 0159; owner decision 2026-09-23: hide for all operators)
- **What:** every operator tier could (API) enrol via `POST /affiliate/enroll`, read and share a referral code (`/me/referral`), request commission payouts, and — because the marketer routes used `requireRole("marketer")`, a MINIMUM rank — use every marketer earning route: a site admin could file a **cash-advance request** (`POST /affiliate/advances` → 200). In the DB, `fn_affiliate_enroll` enrolled admins / platform admins / the system admin, `fn_register_user` attributed sign-ups to an operator's code, the instant 5% perk paid any referrer whose role was `<> 'marketer'` (so every operator tier), and GGR accrual credited an affiliate row whatever its owner's role (e.g. a marketer later made admin). The web showed operators the "Apply" card on `/affiliate` (and treated `admin` as a marketer) and the "Invite & earn 5%" card on `/account`.
- **Also fixed (found in DRIFT-1):** enrolment replaced the player's existing referral code with a new affiliate code, silently breaking every link the player had already shared. Enrolment now keeps it. `fn_gen_referral_code` also avoids other users' affiliate codes.
- **Impact (production, read-only):** none realised — no operator affiliates, no operator-referred players, 0 affiliate commissions.
- **Fix (API):** `requireEarningRole()` (players + marketers only; fail-closed) on enrol, all `/me/referral*` routes and every marketer earning route (marketer routes are now EXACTLY marketer) → 403 `OPERATOR_NOT_ELIGIBLE`. Admin queues/approvals unchanged.
- **Fix (DB, 0159):** production-equal bodies (0158 / 0117) with only the UI-12 changes: operator enrolment refused, attribution only to player/marketer referrers, 5% perk only to a `player`, accrual only to player/marketer affiliates.
- **Fix (web):** capabilities `earn.referrals` (player, marketer) and `earn.marketer_dashboard` (marketer); `/affiliate` shows a plain staff notice with a link back to the workspace; `/account` hides the invite card; no referral/affiliate request is made for an operator session (decided on the token role, so an opened brand counts as staff).
- **Tests:** `app.affiliate.operators.ui12.test.ts` (4 operator token shapes × 12 earning routes; players/marketers keep theirs; admin side intact); capability contract probes for both new capabilities (5 tiers); `capabilities.test.ts` (operators never hold `earn.*`); `e2e_operators_never_affiliates.py` 34/34 (every gap reproduced on 0158, closed on 0159, player/marketer flows intact, role-change auto-enrol intact, idempotent, grants); browser role e2e 46/46 (+18 UI-12 checks; 15 fail on the old pages). `e2e_referral_commission_providers.py` BEFORE-build hardened to exactly 0001..0116 (0159 redefines the payer).

---

## #57 — Production's schema had silently drifted from the migrations: an out-of-band script added player referral codes and rolled back affiliate brand hardening (DRIFT-1) — FIXED (branch `fix/drift1-prod-reconcile`, migration 0158, nightly + post-deploy drift gate)
- **What:** while preparing UI-12, the live definition of `fn_affiliate_enroll` did not match any migration. A full catalog comparison (production vs a database built from every migration) found 42 differences. A script applied outside the migrations had (a) ADDED a real feature — `profiles.referral_code` (unique), `fn_gen_referral_code()`, a newer `fn_register_user` / `fn_affiliate_enroll` / `fn_marketer_create` / `fn_marketer_credit` and rebuilt `v_real_profiles` / `v_demo_profiles` — but was written against OLD bodies, so it also (b) ROLLED BACK brand hardening: `fn_affiliate_request_payout` no longer stamped the payout's brand (F-44's per-brand approval checks could not resolve it), accrual credited GGR across brands, `uq_commission_bucket` lost `site_id` (so accrual's per-brand `ON CONFLICT` target no longer matched any index — accrual would have errored), and all 10 `sel_own` row policies lost `site_id = current_site()`. It also (c) left 12 pre-multi-brand overloads (e.g. `fn_create_deposit(uuid,bigint,text)`) plus `fn_marketer_topup_demo(uuid)` behind, and `fn_gen_referral_code()` executable by `anon`/`authenticated`.
- **Why nothing caught it:** the migrations ledger (0091) proves WHICH files ran and that they were not edited — not what the schema IS. Every ledger check stayed green.
- **Impact (production evidence, read-only):** latent. 0 affiliate payouts, 0 commissions, no referred players, so no money moved under the clobbered definitions. The brand-less `sel_own` policies and stale overloads are only reachable with a Supabase `authenticated` JWT; Supabase Auth self-signup was open (unused by the app, 0 users) — disabled as part of this fix.
- **Fix (0158):** converge deliberately, object by object — ADOPT the production feature verbatim (definitions fetched from production and kept as fixtures), with the generator and profile views now `service_role`-only; RESTORE the repo's brand-hardened accrual / payout-request, the per-brand commission index (temp-name swap) and the 10 brand-fenced `sel_own` policies; DROP the production-only stale overloads and the two unused 2-argument marketer overloads. Idempotent.
- **Prevention:** `scripts/schema_drift.mts` builds a reference DB (shim + every migration) and diffs production on function bodies, anon/authenticated EXECUTE grants, policies, indexes, views (+ options), columns and table write-grants; `KNOWN_DIFFERENCES` holds the two justified platform helpers. `.github/workflows/schema-drift.yml` runs it nightly, after every successful Deploy (Fly), and on demand (Postgres 17 + pgvector service).
- **Tests:** `packages/db/_testkit/e2e_drift_reconcile.py` 19/19 — a faithful production replica (0001..0157 + production's exact drift) and a fresh build converge to an IDENTICAL catalog; referral codes attribute, enrolment unifies the code, payout requests carry their brand, accrual's conflict target matches, stale overloads are gone, generator/views are not callable by anon/authenticated, re-apply is clean. `scripts/schema_drift.test.mts` 3/3. All 31 DB e2e suites and `npm test` (1099 pass) green. Pre-deploy the live gate reported exactly the 42 differences 0158 resolves.
- **Verified live (2026-09-23):** deploy `fad5c59` applied 0158 (ledger row present; 10/10 `sel_own` fenced, per-brand `uq_commission_bucket`, stale overloads gone, generator not executable by anon); the drift gate against production reported **0 differences**. Supabase Auth self-signup disabled (`disable_signup=true`; a probe signup returns 422 `signup_disabled`; `auth.users` = 0).
- **Follow-up (UI-12):** production's `fn_affiliate_enroll` overwrites the player's profile code with a new affiliate code, invalidating links the player already shared. Adopted as-is here (behaviour-neutral reconcile); fixed in UI-12.

---

## #56 — The owner's unscoped back office wrote brand #1 while labelled "every brand" (docs/42 UI-2) — FIXED (branch `fix/ui2-owner-brand-picker`; owner decision 2026-09-23: brand picker)
- **What:** the system owner's own session opened `/admin` with no brand: lists mixed every brand, while settings writes — the pool-mode switch labelled "Default for every brand", game config, daily withdrawal budget, withdrawal kill switch, config review — fell back to `DEFAULT_SITE_ID` and changed brand #1 only. No brand was named anywhere.
- **Fix (API):** owner-tier brand-config routes (`/admin/game-config`, `/admin/withdrawal-pool`, `/admin/withdrawals-enabled`, `/admin/config-review`) require an explicit, well-formed `?site=` from the system owner (400 `SITE_REQUIRED`); site admins stay pinned to their token's brand. The silent fallback is gone at the source, for every client.
- **Fix (web):** the owner's own session at `/admin` shows a **brand picker** (search + "Open brand as admin"); brand work happens inside an opened brand (UI-3 `act` session). Owner-only per-brand settings moved to the console brand page (**Pool & payouts** tab: pool mode, daily budget, kill switch — each call names the brand). Owner governance moved into the console: Audit log, System logs, M-Pesa (global), Engine (Fly.io); old `/admin/*` URLs forward there (owner) or reveal nothing (others). Console link now reads "Open a brand →". Shared `OpenBrandButton`.
- **Tests:** `app.admin.ownersite.ui2.test.ts` (7 owner routes × bare/malformed/named; site admin pinned), J5 updated to name the brand + assert `SITE_REQUIRED`; browser role e2e 28/28 (owner picker, no brand-less back-office request, console governance nav, forwarding, platform admin 404s). npm test green; web build OK.

---

## #55 — The removed `superadmin` tier lingered in code and copy (docs/42 UI-11) — FIXED (branch `fix/ui11-superadmin-remnants`)
- **What:** role literal `'superadmin'` still sent to the API as an announcement audience role and present in the `MeDto` role union, the payments "privileged" list, the engine in-memory default-marketer gate and harness role lists; ~20 comments described a "superadmin" impersonation session or "platform_superadmin-only" gating that no longer exists (misleading for the next change).
- **Fix:** literals removed (announcement "Admins only" = brand admins + system owner); comments rewritten to the current model (brand `admin` sessions with an `act` claim; capability gating per docs/42). The DB's inert `fn_*` allow-lists are left as documented in docs/41 (no behaviour).
- **Guard:** `legacyroles.guard.test.ts` fails CI if a `'superadmin'` role literal reappears in executable source of any app/package (mutation-checked). npm test 1097/1097 (+2 DB-gated); web build OK.

---

## #54 — Operators were never shown WHICH brand or platform they were acting on (docs/42 UI-8) — FIXED (branch `fix/ui8-scope-chips`)
- **What:** the back office header read "TrioCodes Admin" for every brand, and a platform admin's console never named its platform — a mode error waiting to happen for operators who switch brands (NN/g: modes need clear, redundant indicators). In a second impersonation tab the badge read "Accessing " (empty slug).
- **Fix:** `/auth/me` returns `scope` — the brand/platform the SESSION's token is scoped to, with names (one targeted lookup, never a brand list; impersonated sessions report the opened brand). The back office header now reads "<Brand> Admin" with the session kind (Brand admin / Opened from the console · as admin / Owner · all brands) and the footer badge names the brand; the console shows "Platform · <name>" (or "System console · all platforms").
- **Tests:** `app.auth.scope.ui8.test.ts` (brand session names its brand, platform admin its platform, owner neither); browser role e2e +2 checks (25/25). npm test green; web build OK.

---

## #53 — A platform admin's Overview showed zeros and a fake "Live" badge (docs/42 UI-5) — FIXED (branch `fix/ui5-platform-dashboard-scoped`)
- **What:** the console Overview (default period "today") called `GET /platform/performance`, which was owner-only → every KPI tile and per-brand column rendered 0 for a platform admin. The live card/feed opened the engine's `?platform=1` socket, which refused every role but the owner; the client marked itself "connected" on socket open and ignored the refusal, so a pulsing **Live** badge showed 0 online forever.
- **Fix:** `/platform/performance` is open to platform admins, **scoped to their platform** (`adminScopePlatform`; owner → every brand; claimless platform admin → 403), via a `platform_id` filter in the performance query. The engine's console feed grants the owner every brand and a platform admin only its own platform's brands (online counts + deposits filtered per socket; scope re-resolved at most once a minute so newly onboarded brands appear; no platform claim → refused). The web marks the feed connected only when **granted**, and on refusal sets `denied`, stops reconnecting and hides the live widgets (docs/42 P6). `console.performance` / `console.live` opened to the platform tier in the shared capability list (contract test agrees).
- **Tests:** `app.platform.performance.ui5.test.ts` (owner all / platform A only its brands / platform B only its brand / claimless 403 / site admin 403); engine `multiengine.test.ts` UI-5 (owner snapshot all brands, platform admin only its brand, other platform's deposit never delivered, unauthorised roles refused); capability contract 6/6. npm test 1095/1095 (+2 DB-gated); web build OK.

---

## #52 — The UI decided visibility from the ACTOR's role and a per-tab flag; screens and API drifted apart (docs/42 UI-3, UI-7, UI-6 partial, UI-13) — FIXED (branch `fix/ui3-capabilities-effective-role`)
- **What:** (1) while impersonating, pages checked `/auth/me` (the operator's own tier) instead of the brand session's token role (`admin`): an impersonating owner saw owner governance/role options the API refused; an impersonating platform admin lost Edit details / Role / Delete / Default marketer that the API allows. (2) The impersonation flag lived in per-tab `sessionStorage` while the token is shared: opening `/admin` in a second tab made `SessionBootstrap` "heal" the token back to the operator's own (`POST /auth/refresh`), silently ending the brand session for every tab — and meanwhile showed the owner the full governance nav on an `admin` brand token. (3) Dead controls: "Save overrides" for site admins (owner-only API), `/admin/audit` and `/admin/logs` loading into 403s, platform-admin console calling owner-only `/platform/platforms`, owner-only brand settings (chart style, trade UI, site owner / default marketer) shown to platform admins. (4) The impersonate button promised a "platform admin"/"superadmin" session.
- **Fix:**
  - **One permission list** `packages/shared/src/capabilities.ts` (`can(role, cap)`), imported by the web via a browser-safe subpath; every nav entry, page gate and role-dependent control now uses it on the **token** role (`useEffectiveRole`/`useCan`, `RequireCapability`). The hand-written `SuperadminOnly` and all `user.role === …` gates in the back office are gone.
  - **Impersonation is in the token:** `POST /platform/sites/:id/impersonate` mints an RFC 8693-style `act` claim `{sub, role, brand}` (authorisation still reads only `role`/`site`). The web reads impersonation from the token in any tab, never re-mints an impersonation token, shows the brand banner from the token, and "Exit" works in any tab (stash, else `/auth/refresh` back to the operator's own session). Tokens minted before `act` still work via the tab stash.
  - Console: a brand session visiting `/platform` gets "You're in <brand> as admin — Exit brand" instead of a 404; owner-only brand settings are hidden from platform admins (shown read-only); onboarding fetches platforms only for the owner; button reads "Open brand as admin".
- **Tests:** `capabilities.contract.test.ts` — every capability × all 5 tiers against the real router (mutation-checked: two wrong entries are reported). `app.platform.impersonate.test.ts` +2 (act claim present / absent). Unit: `capabilities.test.ts`, `token.test.ts`. **Browser e2e** `apps/web/e2e/roles.e2e.mjs` — production web build in headless Chromium, 6 sessions incl. second-tab and legacy impersonation, 23/23; the same suite against the previous build fails 10 checks (reproduces UI-3/UI-6/UI-7). Now a CI job (`web roles e2e`). npm test 1093/1093 (+2 DB-gated); web build OK.

---

## #51 — A link rejected a withdrawal on page load (docs/42 UI-4) — FIXED (branch `fix/ui4-links-never-act`)
- **What:** `/admin/withdrawals?highlight=<tx>&do=reject` executed the rejection as soon as the page loaded (the push notification's Reject action builds that URL). Any link an admin opened — or a browser prefetch — could reject a withdrawal; the only barrier was knowing the tx id. It violated safe-method semantics (RFC 9110 §9.2.1: following a link must not request a state change).
- **Fix:** `lib/admin/deeplink.ts` parses the link into *selection + intent* only (validated tx id, known intents, `do` stripped from the address bar). The page highlights and scrolls to the row and shows a confirmation banner with the request's player, amount and phone (or its already-decided status); **the click** executes. Approve was already click-only (needs the owner password). Service-worker comment updated.
- **Tests:** `deeplink.test.ts` 2/2; npm test 1080/1080 (+2 DB-gated); web build OK.

---

## #50 — Affiliate payout approval sent real M-Pesa money without the owner password (docs/42 UI-1) — FIXED (branch `fix/ui1-affiliate-payout-password`)
- **What:** `POST /admin/affiliate/payouts/:id/approve` and bulk approve dispatch a real M-Pesa B2C (`affiliateservice.ts:82`) but, unlike withdrawals and commission payouts, never asked for the system owner approval password. A site-admin session alone (or a stolen one) could pay out affiliates; the UI offered a plain two-step confirm.
- **Evidence:** api `app.affiliate.ts:140,163` had no `requireApprovalPassword`; prod `affiliate_payouts` has 0 rows — latent, never exercised.
- **Fix:** both routes call `requireApprovalPassword` (bulk: once per batch, approve only; reject stays ungated because it only releases the reservation). The payouts panel uses the same `PasswordConfirmButton` as withdrawals; the field now reads "System owner password" (was "Superadmin password").
- **Tests:** `app.affiliate.payoutgate.ui1.test.ts` 3/3 (2 fail before the fix: missing/empty/wrong password → 403 `PASSWORD_REQUIRED` and the payout stays `requested`; bulk approve gated, bulk/single reject not). npm test 1078/1078 (+2 DB-gated); web build OK.

---

## #49 — Support conversations were not owner-bound; withdrawal alerts were scoped by a stale brand snapshot; unsubscribe was not owner-bound; `v_mfa_status` was stale (Issue 1 / F-48) — FIXED (branch `fix/issue1-f48-support-push-mfa`, migration 0157)
- **What (support, S1):** knowing a conversation id was enough to write to it. A stranger could post into anyone's conversation, get earlier turns replayed back through the assistant ("what did I ask before?"), and **re-point the escalation contact** so staff follow up with the attacker. A logged-in player could do the same to another player of the same brand (only the brand was checked).
- **What (support, S2 — shared device):** the widget kept the conversation id and full transcript in `localStorage` across logout/account switch, so the next person on the browser saw — and continued — the previous person's conversation.
- **What (push, P1):** withdrawal alerts (player phone, amount, Approve/Reject) went to subscriptions by the brand **stored at opt-in**: a subscription stored with a null brand (a claimless token, #43) received **every brand on every platform**; an admin moved to another brand kept the old brand's alerts; suspended/banned admins kept receiving them; a withdrawal with no known brand alerted every admin device.
- **What (push, P2):** `POST /admin/push/unsubscribe` deleted any endpoint for any admin — one admin could silence another's alerts.
- **What (MFA view, M1):** `v_mfa_status` listed `('admin','superadmin')` — the removed tier — and hid both platform tiers, whose 2FA is mandatory; it was granted to anon/authenticated (blocked only by `user_mfa` privileges).
- **Evidence (prod, read-only, 2026-09-23):** 4 support conversations (none owned, last 2026-08-15); 2 push subscriptions, both the owner's — **no exploitation**, the flaws were latent. Anon REST read of `v_mfa_status` → `permission denied for table user_mfa`. MFA: 1 of 3 site admins, the platform admin and the owner enrolled (the other two site admins are forced to enrol at their next sign-in).
- **Fix — support:** `POST /support/conversations` issues a 256-bit capability token once (`conversationToken`); only its SHA-256 is stored (`support_conversations.access_hash`, 4-arg `fn_support_start`, migration 0157). Every write needs the logged-in owner or the token (constant-time compare); without proof the answer is the same 404 as an unknown id; a different logged-in account is refused even with the token; brand mismatch still 403; legacy (hash-less) conversations accept only their owner. Operator DTOs never carry the hash. **Web:** the widget stores and sends the token, wipes a signed-in conversation (transcript, token, visitor id) the moment the person using the browser changes, and transparently replaces a conversation the server no longer accepts.
- **Fix — push:** one rule, `mayReceiveWithdrawalAlert(liveProfile, site, sitePlatform)`: active accounts only; owner → all; platform admin → its platform's brands; site admin → its brand; nobody else; unknown brand → owner only. The Postgres query mirrors it exactly (the DB e2e runs the SQL extracted verbatim from `push.ts`). Unsubscribe removes only the caller's own row (`removeForUser`); endpoint-wide removal is internal (410 pruning) only.
- **Fix — MFA view:** rebuilt for `admin`/`platform_admin`/`platform_superadmin` with site/platform/status columns, `security_invoker`, service_role only (proven unreadable by anon/authenticated even under Supabase default privileges).
- **Tests:** engine `push.test.ts` 12/12 (truth table, live-profile matrix, owner-bound removal); `app.push.e2e` 8/8 and `app.support.e2e` 15/15 — the new F-48 cases fail when the old logic is restored (mutation-checked); `support.pg.test.ts` + `onboardscope.pg.test.ts` against the real schema; `e2e_support_push_mfa.py` 26/26; web `format.test.ts` (identity reset + token decode). Full: npm test 1074/1074 (+2 DB-gated), DB e2e 30/30, web build OK, secret scan clean.
- **Compatibility:** migration first (3-arg `fn_support_start` kept for the old API; the 4-arg has no defaults so calls cannot collide). A browser still running the old widget gets a generic error on its next message until it reloads.

---

## #48 — Merges migrated production but never shipped the code: the Fly deploy jobs failed silently (deploy pipeline) — HARDENED (branch `ci/deploy-preflight-and-verify`); root cause: overdue Fly invoice (paid)
- **What:** every backend merge since 2026-09-23 06:25Z (F-43 → F-47, six runs) ran `verify` and `migrate` — migrations 0153–0156 are in production — but produced **no Fly release**: `invest254-api` stayed on v156 and `invest254-engine-pm` on v119 (2026-09-22 20:50Z). The API/engine code fixes for F-43, F-44, F-46 and F-47 were therefore not live.
- **Evidence:** until then each backend merge produced a release ~3 min later (19f0870 → v154, 415d3fd → v155, 49069df → v156). Nothing the image build uses changed after v156 (Dockerfile, fly configs, lockfile, tsconfigs identical), and the latest flyctl (0.4.106) predates the last two good deploys — so the failure is in the deploy job itself. The most likely cause is `FLY_API_TOKEN` being revoked/expired overnight (the secret held a Fly org token, and Fly credentials were reissued for this session). Actions logs are not reachable from the agent sandbox, so this is inferred, not read.
- **Why it was silent / harmful:** the deploy jobs ran AFTER `migrate`, so a bad token left production migrated but un-deployed, with no signal outside the Actions tab; flyctl was unpinned (`@master` → latest); nothing verified that the release that went live was the merged commit.
- **Fix (`.github/workflows/deploy.yml`):** new `fly-auth` preflight job (token must reach BOTH apps) runs BEFORE `migrate`, with an explicit error annotation and remediation; flyctl pinned (`FLYCTL_VERSION`); deploys are a `fail-fast: false` matrix; images labelled `git-<sha>`; after each deploy the workflow verifies the latest release carries this commit's label and the API health endpoint returns 200; production-repo-only guard (mirror skips). `HOSTING.md §2.6.1` documents the token (a dedicated long-lived org deploy token) and the rotate-then-re-run procedure. actionlint clean.
- **Root cause (owner-confirmed 2026-09-23):** an overdue Fly.io invoice blocked deploys; the org tokens are non-expiring and valid. Paid 2026-09-23 ~12:00Z. The deploy step now emits an explicit billing/builder hint on failure.
- **Owner action (still recommended at rotation time):** create a deploy token (`fly tokens create org -o personal -n github-deploy -x 8760h`) and update the `FLY_API_TOKEN` Actions secret, then re-run Deploy (Fly). Include this secret in every future Fly credential rotation.

---

## #47 — Platform admins saw every tenant's domains and could re-onboard (overwrite) another platform's brand (Issue 1 / F-47) — FIXED (branch `fix/issue1-f47-onboard-domain-scope`)
- **What:** slugs and domains are GLOBAL (one `sites` table, one system Cloudflare account) while a platform admin's authority is ONE platform, and the onboarding surface ignored that. (1) `GET /platform/domains/health` returned the Cloudflare Pages status of EVERY platform's brand domains — each other tenant's client list. (2) `GET /platform/onboard/domain-status?domain=` probed any domain on the system Cloudflare account. (3) `POST /platform/onboard` with an EXISTING slug upserted it — whatever platform owned it — overwriting that tenant's brand identity, domain and economy (house edge, stakes). (4) The domain check was case-sensitive (`UNIQUE(primary_domain)`), while host resolution is not, so `Brand.com` and `brand.com` could be claimed by two brands. A claimless platform-admin token also reached (1) because that route never resolved the caller's scope.
- **Evidence (prod, read-only, 2026-09-23):** no exploitation found — the only two platform-admin site edits were on its own platform; 13 brands, no case-variant/`www.`-variant duplicate domains, no brand without a platform.
- **Fix:** new `apps/api/src/onboardscope.ts` is the single place global identifiers meet platform scope: `refuseForeignReonboard` (`SLUG_TAKEN` 409 when the slug belongs to another platform), `refuseDomainClash` (`DOMAIN_TAKEN` 409, case-insensitive, `www.` normalised), `assertDomainInPlatform` (`DOMAIN_NOT_FOUND` 404 — no existence oracle for other tenants' domains), `platformDomainSet` (health filtered to own brands' apex + `www.`). Routes pass `adminScopePlatform(ctx)` (null = system owner, unrestricted; claimless platform admin → 403 `PLATFORM_CLAIM_MISSING`).
- **Tests:** `onboardscope.test.ts` 4/4 (DB-free); `onboardscope.pg.test.ts` against the fully migrated schema (rolled-back transaction; runs when `E2E_PG_DSN` is set); `app.platform.onboard.scope.f47.test.ts` 3/3 — all 3 fail on the pre-fix routes. npm test 1063/1063 (+1 DB-gated skip); `e2e_onboarding.py` green; secret scan clean.
- **Compatibility:** API-only, no migration. The owner's behaviour is unchanged; the console's Clients table only ever rendered the caller's own brands, so nothing visible is lost.

---

## #46 — The database scoped a site-tier actor by its PROFILE, the API by its TOKEN: impersonation hit the wrong brand, and site-admin RPCs had no brand fence (Issue 1 / F-46) — FIXED (branch `fix/issue1-f46-actor-scope`, migration 0156)
- **What (a) — impersonation mis-scope:** impersonating brand X mints `role='admin', site=X` for the operator's OWN user id. `fn_actor_target_sites()` (used by 22 functions) re-derived an `admin` actor's brand from its profile, so broadcasts, audience counts, category clears and tickets issued while impersonating X landed on the impersonator's HOME brand (for a platform admin, possibly a brand of another platform), and add-on requests for X were refused.
- **What (b) — no DB fence for site admins:** the user/money/brand RPCs (`adjust_balance`, `set_user_role`, `delete_user`, pool/withdrawal switches, `decide_advance`, `set_site_owner`, … 17 in all) only fenced the `platform_admin` branch. For `p_actor_role='admin'` the API was the single guard, which is exactly how the claimless-token escalation (#43) credited other brands' users in production. A demoted admin still holding an `admin` token was likewise unfenced.
- **Evidence (prod, read-only, 2026-09-23):** 6 owner impersonation actions (`actor_role='admin'`, profile `platform_superadmin`); 36 actions by an `admin`-role actor whose profile is now `player` — all BEFORE that demotion (last action Aug 13, demoted Aug 17), so no stale-token abuse occurred, but nothing in the DB would have stopped it. Production function bodies md5-identical to the repo before generation.
- **Fix — migration 0156:** PERMISSION is split from TARGETING, both checked against the actor's real profile. `fn_actor_scope_sites(actor, role)`: owner and platform admin unchanged; token role `admin`/`superadmin` → a genuine site admin's own brand, an impersonating platform admin's platform, an impersonating owner's all brands, anyone else (demoted/stale) NONE. `fn_actor_target_sites` (untargeted bulk) returns the own brand only for a GENUINE site admin, never an impersonator's home. `fn_actor_bulk_sites(actor, role, audience)` = named brands ∩ permission. `fn_assert_actor_site_scope` raises `SITE_SCOPE_FORBIDDEN` and is injected as the first statement of the 17 RPCs (bodies otherwise byte-identical; the e2e asserts the diff is exactly that one line). Add-ons use permission; audience/broadcast/category-clear use the bulk set (new 4-arg `fn_notification_clear_category(…, p_site)`); tickets accept an explicit brand only within permission, else the genuine admin's own brand, else `NOT_AUTHORIZED`. Grants: `service_role` only.
- **API/engine:** every site-tier bulk action now NAMES the token's brand (`scopedAudience`: `sites=[brand]` + the template's default audience); tickets use `adminScopeSite(ctx)`; add-ons refuse a site other than the token's (`SITE_SCOPE_FORBIDDEN`); the engine's `resolveCategory` passes the brand to the 4-arg function.
- **Deploy-order safety:** under the API currently in production (which never names a brand) an impersonated bulk action reaches NOBODY instead of the wrong brand; genuine site admins, platform admins and the owner behave exactly as before. The legacy `superadmin` role (whose untargeted bulk now resolves to nobody) has not been minted since the Sep 22 deploy.
- **Tests:** `e2e_actor_scope_impersonation.py` 37/37 (reproduces both defects on the pre-0156 schema, then proves fence, targeting, bulk, category clear, tickets, add-ons and the one-line RPC diff); `app.impersonation.scope.f46.test.ts` 6/6 (5 fail before the API change); fixtures corrected where an "admin" actor was not a genuine admin (`e2e_default_marketer_lock`, `e2e_platform_isolation` + a cross-brand DB-fence check). Full DB e2e 29/29; npm test 1056/1056; secret scan clean.

---

## #45 — Audit rows filed under the DEFAULT brand whatever they touched (cross-platform leak via the per-brand audit view) (Issue 1 / F-45) — FIXED (branch `fix/issue1-f45-audit-attribution`, migration 0155)
- **What:** `admin_actions.site_id` was `NOT NULL DEFAULT <default brand>`, and 26 of 50 audit-writing functions plus the API's `recordAction()` never set it. Every such row was filed under the default brand.
- **Evidence (prod, read-only, 2026-09-23):** all 570 `user`-targeted rows on the default brand, 251 of them about users of other brands; 550 `site`-targeted rows (impersonations, pool top-ups, …) about other brands also on the default brand; platform-level actions (platform create/update, global provider/M-Pesa config, templates, add-on pricing) masquerading as the default brand's.
- **Impact:** `GET /platform/sites/:id/audit` (platform admin, `site_id = $brand`) showed the default brand's operators actions taken on OTHER platforms' users (cross-platform leak) and hid each brand's own actions from its platform admin.
- **Fix — migration 0155:** `site_id` nullable, no default (NULL = platform-level, excluded from every per-brand view; the system owner still sees all). `fn_admin_action_site(type, target, detail)` derives the brand of the TOUCHED entity (profiles/marketers, sites, `withdrawal_pool` `site:day`, transactions, advances, notifications; else `detail.site_id`/`detail.after.site_id`). A `BEFORE INSERT` trigger makes that derived brand authoritative (it also overrides a wrong explicit value); with nothing derivable, a GENUINE site admin's untargeted action goes to its own brand and anything else stays NULL — an impersonator's untargeted action is never mis-filed under its home brand. Backfill uses the same rule, keeps deliberately-set non-default sites, and keeps the legacy singleton `game_config` rows (the pre-multitenant era's only brand) on the default brand.
- **Prod dry-run before shipping (read-only):** 550 site + 251 user + 4 expense + 1 affiliate rows move to the brand they concern; 58 platform-level rows become NULL; transaction/pool/advance/per-brand game-config rows untouched.
- **Tests:** `e2e_audit_attribution.py` 22/22 — reproduces the leak pre-0155 (the default brand's audit view shows brand B's actions), then proves backfill, trigger, wrong-explicit override, impersonation → NULL, and the exact per-brand view using the same query as `listAudit`. Full DB e2e 28/28 (576); npm test 1050/1050.
- **Compatibility:** migration-only; safe with the currently deployed API (its `recordAction` inserts are attributed by the trigger; `listAudit` handles NULL).

---

## #44 — Operator routes addressed a target by id without checking its brand (Issue 1 / F-44) — FIXED (branch `fix/issue1-f44-admin-target-scope`, migration 0154)
- **What:** id-addressed operator routes resolved scope from the caller's token but never checked the TARGET's brand: `GET /admin/users/:id`, `/:id/activity`, `/:id/overrides`; `GET|POST /admin/users/:id/notifications` and `POST /admin/notifications/:id/resolve` (sequential ids; also reachable by a raw `platform_admin` of ANY platform); **all** of `GET|PATCH /admin/marketers/:id`, `/credit`, `/withdraw`, `/fuliza`, `/airtime`, `/statement`, **`/pin`** (reset any tenant's marketer PIN → account takeover), `/status`, `/bulk`; `GET|POST /admin/affiliate/expenses` (and the RPC never checked the marketer's brand while the withdrawable total nets across brands → cross-tenant financial sabotage); `/admin/affiliate/accrue` (any brand, or all). `GET /admin/audit` and `GET /admin/mpesa-config` served cross-brand/global data to every site admin (the UI hid them; the API did not). The remaining moderation routes (withdrawals, affiliate/commission payouts, advances) used a guard that is tolerant of an unresolved target and passed it through to the money RPC.
- **Production forensics (2026-09-23, read-only):** 12 real-money `balance.adjust` actions by a brand-A site-admin account on users of two other brands (Sep 12–14; KES 3,200 total). The wallet route does check the target's brand, so this required a claimless token — i.e. the #43 refresh escalation was used in production (owner to review whether the operator was authorised). Separately, 4 marketer expenses the system owner logged for other brands' marketers were stamped on the owner's home brand (mis-attribution, not an attack) — corrected by 0154.
- **Fix:** new `apps/api/src/scope.ts` — ONE fail-closed tier rule (`assertSiteTarget` / `assertUserTarget`): system → any brand; platform admin → only brands of its platform; site admin → only its brand; an unresolvable target → 404, never passed through. Applied to every route above and to all 11 remaining moderation call sites (the tolerant guard is no longer used by any route; the in-memory payout mirror now resolves a payout's brand like Postgres does). Audit trail + global M-Pesa config → System-owner-only. Expenses are recorded on the MARKETER's brand; a site admin's accrual is confined to its brand. Migration **0154**: `fn_admin_add_marketer_expense` refuses a brand-bounded actor crossing brands (`MARKETER_SITE_MISMATCH`), normalises the global owner's expense onto the marketer's brand (deploy-order safe with the previous API), and re-stamps the 4 mis-attributed rows (amounts/withdrawable unchanged).
- **Regression guard (future-proof):** `app.scope.matrix.e2e.test.ts` reads EVERY id-addressed `/admin|/platform|/tickets|/addons|/support` route from the real router (`Router.listRoutes`, 72 routes) and attacks each as brand B's site admin AND as another platform's admin against real brand-A entities with VALID bodies (only 403/404 pass; 400 counts as a failure so validation can't mask a missing check), then proves brand A untouched (marketer balance/status/PIN, user status/wallet, notifications, advance). **144/144 refused on the fix; on the pre-fix source it reports 19 breaches** (incl. PIN reset 200, marketer credit/withdraw 200, foreign platform admin injecting notifications 201). A new route is attacked automatically. DB: `e2e_marketer_expense_scope.py` 13/13 (reproduces the prod defect pre-0154).
- **Contract change (intentional):** an UNKNOWN id in a bulk withdrawal approve now fails its row (was a silent no-op success); the UI never submits unknown ids and already reports failed rows.
- **Verification:** npm test 1050/1050; DB e2e 27/27 files (554 checks); `tsc -b` clean; secret-scan clean.

---

## #43 — Token scope loss: re-minted tokens dropped `site`/`platform`, and a claimless site `admin` was read as UNRESTRICTED (every brand, every platform) — FIXED (branch `fix/issue1-f43-token-scope-claims`)
- **What:** four token-mint paths omitted the holder's scope: `POST /auth/refresh` (`issueToken(userId, role)`), `POST /affiliate/enroll`, and both marketer-app logins (`/marketers/auth/login`, `/login-web`). Independently, `adminScopeSite()` returned `claims.site ?? null` for a site `admin`, and `null` means *unrestricted* — the #38 class, which had only been closed for `platform_admin`.
- **Exploit chain (reproduced end-to-end):** a brand-A account is promoted to `admin` → the web sees token-role ≠ live role and calls `/auth/refresh` automatically (`SessionBootstrap.tsx:35`, `useAuthActions.ts:64`) → the refreshed token has no `site` → every `/admin/*` list and every `assertTargetSiteInScope` write treats it as cross-brand → the new site admin reads and mutates users, balances, withdrawals and marketers of **every brand on every platform**. Any site admin could also call `/auth/refresh` directly. A claimless `platform_admin` was fail-closed by #38 (locked out instead of escalated); a partial fix for that case (`03c269c`) sat unmerged. Tokens live 7 days.
- **Fix (two independent halves):** (1) **root cause** — new single choke point `AuthService.issueSessionToken(userId)` re-reads the LIVE profile (`profiles.site_id`, `platform_id`) and stamps role + site + platform exactly as login does; refresh and enrolment use it; marketer-app tokens are stamped with the marketer's brand. (2) **defense-in-depth** — `adminScopeSite()` now **fails closed**: a site `admin` without a `site` claim gets `403 SITE_CLAIM_MISSING`; new `adminListSite()` replaces every raw `ctx.claims.site` read in admin lists/writes so the rule cannot be bypassed. The system owner's behaviour is unchanged.
- **Tests:** new `app.auth.scope.f43.e2e.test.ts` (7): decodes the REAL refreshed JWT and replays its claims — brand-A admin sees only brand A; claimless admin refused on 20 back-office surfaces + a write; platform_admin keeps its platform claim; enrolment and both marketer-app logins keep the brand; owner + scoped admin unaffected. **On the pre-fix source 5/7 fail for the exact reasons** (missing `site`; claimless admin → 200 everywhere). 136 legacy test tokens that encoded "claimless `admin` = all brands" were migrated: 134 to `admin`+`site` (the brand their fixtures live in) and 2 explicit "unrestricted operator" constants to `platform_superadmin`; 2 tests that acted cross-brand now assert the refusal and use the owning brand's admin. Full suite **1044/1044**, `tsc -b` + web build clean.
- **Residual (owner action):** tokens already minted claimless in the last 7 days: `admin` ones are now refused (sign in again); player/marketer ones fall back to the default brand until expiry. Rotating `SUPABASE_JWT_SECRET` (BUGLOG #41 action 2) ends all of them immediately.

---

## #42 — PostgREST TABLE/VIEW surface open to the public anon key: 36 tables without RLS + 14 owner-run views — FIXED in code (branch `security/postgrest-table-surface`, migration 0153); prod state to be confirmed
- **What:** #39/0151 closed the PostgREST **function** surface; the **table/view** surface was never audited. Supabase's default privileges grant `ALL` on every new public table/view/sequence to `anon` + `authenticated`, so RLS is the only gate. In the repo schema **36 of 70 public tables were never RLS-enabled** (incl. `sites`, `platforms`, `marketers`, `marketer_credentials` [PIN hashes], `marketer_wallets`, `commission_payouts`, `withdrawal_pool`, `site_game_config`, `platform_global_config`, `admin_actions`, `system_logs`, `tickets`) and **all 14 public views ran as owner** (no `security_invoker`), bypassing the RLS of the tables beneath them (`v_real_profiles` → every player's phone on every platform).
- **Evidence (reproducible, not inferred):** new `packages/db/_testkit/e2e_postgrest_surface.py` builds the DB under Supabase's real default-privilege posture, seeds two platforms, and attacks as `anon` and as a claimless `authenticated` (Supabase self-signup) JWT. On the pre-fix schema (`E2E_UPTO=0152`) it **fails 37 checks**: anon reads `admin_actions`, `marketer_credentials`, `marketer_wallets`, `platforms`, `sites`, `system_logs`, `tickets`, `withdrawal_pool`, `platform_global_config`, … and succeeds at crediting marketer wallets, flipping the platform withdrawal kill-switch, inflating the pool, forging and **erasing** the audit trail, `TRUNCATE system_logs` (TRUNCATE ignores RLS), re-parenting brands, minting platforms and resetting marketer PINs. Independent static replay of all 153 migrations flags exactly the same 36 tables / 14 views (0 false positives/negatives).
- **Doc correction:** docs/40 §0 stated "`sites`/`platforms`/`marketers` — RLS enabled, 0 policies" from a live read. **No migration enables RLS on those tables**, so either prod drifted out-of-band or that line was wrong (docs/40 also reported "70 RLS tables" — 70 is the *total* table count in the repo schema, of which 34 have RLS). The live state is unverified from this sandbox (egress-blocked); 0153 is idempotent, so it converges whichever is true.
- **Fix — migration `0153_postgrest_table_surface_lockdown.sql`:** (0) **fail-closed guard**: aborts before any change unless the migrating role owns or BYPASSRLS every public table (so it can never lock the app out); (1) RLS on every public table (no policy = deny-all); (2) `security_invoker = true` on every view; (3) anon/authenticated lose INSERT/UPDATE/DELETE wherever no write policy exists for them (only `push_subscriptions` own-row keeps it), lose TRUNCATE/REFERENCES/TRIGGER everywhere, and lose all sequence access; (4) `sites`: no table-wide SELECT for public roles — `authenticated` keeps only `(id, platform_id)`, row-scoped by a **claims-only** policy mirroring `is_site_admin` (no recursion), so the platform branch of RLS keeps working without exposing brand config; (5) default privileges so future tables/sequences are not auto-writable. The `v_real_*`/`v_demo_*` views now **fail closed** for public roles (their marketer classifier is a DEFINER fn that 0151 made non-executable) — deliberately not re-granted, as that would create a cross-tenant "is this user a marketer?" oracle.
- **App impact: none.** API/engine never run as anon/authenticated (no `SET ROLE`, no JWT GUCs, no PostgREST, no supabase-js); they connect as the table owner. Verified: owner row counts identical in all 84 relations; owner writes + SECURITY DEFINER RPCs unaffected.
- **Regression guards:** (a) `e2e_postgrest_surface.py` 50/50 (fix) vs 37 failures (pre-fix); (b) new DB-free `packages/db/migrations.guard.test.ts` in `npm test`/CI fails any future migration that creates a public table without RLS, creates/replaces a view without `security_invoker` (a bare `CREATE OR REPLACE VIEW` silently **resets** the option — verified), or grants write privileges to anon/authenticated. Full DB e2e **26/26 files, 541 checks** green.

---

## #41 — PRODUCTION `DATABASE_URL` (+ API token-signing secret) committed to the PUBLIC repo — FIXED in code (branch `security/remove-committed-e2e-env`); ⚠️ credential ROTATION required (owner action)
- **What:** `.e2e.env` was committed on 2026-08-04 (`f1532eb`) and mirrored to the template. It holds the production Supabase `DATABASE_URL` **with password** and a `SUPABASE_JWT_SECRET` value (the variable the API uses to sign every auth token and withdrawal-action link).
- **Evidence (2026-09-23):** `invest254` is public by design (`mirror-sync.yml`: "Reads PUBLIC upstream with no secret"); an unauthenticated `GET https://raw.githubusercontent.com/petermuchendu1000/invest254/main/.e2e.env` returned **HTTP 200**. The committed `DATABASE_URL` is byte-identical to the live production connection string. The committed JWT secret does **not** verify the Supabase project anon/service_role keys (offline HMAC check), so it is not the PostgREST key; whether it equals the API's production signing secret cannot be checked from the repo — treat it as compromised. Full-history secret sweep of both repos: every other hit is a test/dev placeholder.
- **Impact:** the most severe possible scope leak. A direct Postgres connection as the pooler `postgres` user bypasses **every** layer of the isolation model (RLS, API role/scope guards, in-definer platform checks) — read/write every platform's PII, balances, roles, withdrawals. If the JWT secret is the prod value, anyone can also mint a `platform_superadmin` token. Exposure window: ~7 weeks.
- **Code fix:** file removed from HEAD; `.gitignore` now ignores `*.env` / `.env.*` (only `*.example` tracked); new CI gate `scripts/secret_scan.mts` (+ 6 unit tests) fails the build on any tracked env file, a remote Postgres URL with a real password, or real-shaped GitHub/Supabase/Telegram/Cloudflare/Fly/Stripe/private-key/Supabase-JWT secrets — it never prints a value. Verified: gate FAILS on the pre-fix tree (`.e2e.env` flagged), PASSES after (760 files, 0 findings). Nothing in the code read `.e2e.env`.
- **Owner action (cannot be done from code):** (1) reset the Supabase DB password and update `DATABASE_URL` on both Fly apps + GitHub Actions secrets; (2) rotate `SUPABASE_JWT_SECRET` on both Fly apps (invalidates all sessions — intended); (3) review Supabase Postgres logs since 2026-08-04 for unknown clients; (4) decide whether the upstream should stay public. History still contains the old value — harmless once rotated; a history rewrite (force-push) is optional and was not done.

---

## #40 — Legacy `superadmin` tier removed; owner-tier config moved to the system console (Issue 1 / F1 + F2) — FIXED (branch `issue1-remove-superadmin`)
- **What:** the codebase carried a 6th, out-of-hierarchy role `superadmin` (per-brand "owner" tier) that duplicated the site tier in RLS while also holding owner-tier powers, and was minted at runtime as the system owner's site-fenced impersonation token. This muddied the authoritative 5-tier model (`platform_superadmin > platform_admin > admin > marketer > player`).
- **Evidence:** live DB had **0** `superadmin` holders (`select role,count(*) from profiles`), yet the role was wired into `profiles_role_check`, `is_site_admin`, `ROLE_RANK`, `PRIVILEGED_ROLES`, ~273 non-test refs, and the `/platform/sites/:id/impersonate` minting. `is_site_admin` also carried unreachable `finance_admin`/`support` branches (not in the role CHECK, never minted) — F2.
- **Resolution (Option B):** migration `0152_remove_superadmin_role.sql` fail-closed-guards on 0 holders, drops `superadmin` from `profiles_role_check`, and simplifies `is_site_admin` (removing the `superadmin` + dead `finance_admin`/`support` branches). Code: removed `superadmin` from `ROLE_RANK`/`requireSiteAdmin`/`PRIVILEGED_ROLES`/MFA roles/role-set validation and the in-memory admin mirror; **impersonation now always mints a day-to-day `admin`** (system owner and platform admin alike); owner-tier `/admin/*` levers (game/economy config, seed rotation, M-Pesa config, per-brand withdrawal pool, Fly ops, per-user overrides) are re-gated to `requireRole("platform_superadmin")` (System console), and the web owner-tier UI is System-owner-only. The ~29 other `fn_*` keep their harmless `superadmin` allow-list/protected-target literals as inert defense-in-depth (the CHECK now forbids the role); a follow-up (F1c) may sweep them.
- **Impact:** none for live users (0 `superadmin` accounts; owner-tier `/admin` routes were only reachable by the system owner in practice). Site admins do NOT gain owner-tier powers.
- **Tests:** migration applied on ephemeral PG; **DB e2e 25/25 files green**, **TS 1035/1035 green** (backend 960 + web 75), `tsc -b` + web `tsc` clean. New/updated assertions: `superadmin` is not privileged, not assignable via `/role`, owner-tier is System-only, impersonation mints `admin`, fences hold via the `admin` site claim.
- **Deferred (documented):** F1b — allow a `platform_admin` to manage its OWN brands' owner-tier economy (requires widening the economy RPCs with platform scope); F1c — sweep inert `superadmin` literals from the 29 `fn_*` bodies; F1d — brand selector on the System-console owner-tier pages.

---

## #38 — Cross-tenant leak: a platform_admin with NO platform claim was read as "unrestricted"; an unresolved target was deferred — FIXED (branch `fix/issue1-platform-scope-fail-closed`)
- **What:** A `platform_admin` reached brands in ANOTHER platform. Live audit: actor `51ecc888` (**@thegenius**, `platform_admin`, `platform_id = a8502771…` = **NDUATI**) ran `platform.impersonate` against sites in **MUCHENDU** (owned by **@zrinok**) on 2026-09-21 — **Tamu Traders** (`47e2ab1f…`) and **Invest254** (`00000000-…-001`). "One missing platform claim opens all thirteen brands" (12 MUCHENDU + 1 NDUATI).
- **Evidence:** read-only forensics on prod (`admin_actions`, `profiles`, `sites`, `platforms`) reconstructed the actor/target/platform mapping. New e2e `apps/api/src/app.platform.scope.failopen.e2e.test.ts` reproduces the mechanism against the app: a `platform_admin` token carrying **no** `platform` claim → `GET /platform/sites` returned **200 listing every platform's brands** (expected 403) and `POST /platform/sites/:id/impersonate` on a cross-platform brand returned **200 + a minted admin token**.
- **Root cause:** `apps/api/src/http.ts` `adminScopePlatform()` returned `ctx.claims.platform ?? null`; a **missing** claim → `null` → treated identically to the system owner (unrestricted). `scopeSiteParam` then early-returns and `listSites(null)` returns every platform. Independently, `assertTargetPlatformInScope()` **deferred** (returned) on an unresolved target platform ("defer to the RPC's own guard"). The claim is only minted at login when `profiles.platform_id` is set (`authservice.issueToken` 4th arg), so any `platform_admin` without a `platform_id` — or any path that drops the claim — silently escalates to system-wide.
- **Also caught (latent):** `PgPlatformRepository.platformOfSite()` returned the **string `"null"`** for a site whose `platform_id` IS NULL (`String(null)`), and would **throw on an empty `siteId`** (invalid-uuid cast) — both defeat a fail-closed target check.
- **Impact:** a single-platform admin (or any claimless token) could enumerate, edit, and impersonate-admin **every brand across all platforms** — cross-tenant full access. Blast-radius check on prod: **0** `platform_admin`s with null `platform_id`, **0** sites with null `platform_id` → the fail-closed fix locks out nobody legitimate.
- **Fix:** `adminScopePlatform()` now **throws `PLATFORM_CLAIM_MISSING` (403)** for a `platform_admin` with no platform claim (never `null`=unrestricted). `assertTargetPlatformInScope()` now **refuses an unresolved target** (403 `PLATFORM_SCOPE_FORBIDDEN`) for any bounded caller; only the system owner (null scope) is unrestricted. `platformOfSite()` hardened (empty→null; NULL `platform_id`→null).
- **Verification:** new failopen e2e (3 scenarios: claimless refused; unresolved target refused; legit `platform_admin` + system owner unaffected). `http.platform.test.ts` updated to the fail-closed contract + a claimless-admin unit test. **Full suite 1035/1035 green; `tsc -b` clean.**

## #39 — PostgREST exposes SECURITY DEFINER admin/financial `fn_*` to anon/authenticated; `fn_*` trust the caller-supplied `p_actor_role` — FIXED & DEPLOYED (migration 0151, applied to prod 2026-09-22)
- **Resolution status update (Issue 1 / F3):** migration `0151_revoke_public_function_execute.sql` is APPLIED in production (`schema_migrations`, applied_by `issue1-buglog39`, 2026-09-22). Live grant audit confirms **anon/authenticated can EXECUTE 0 of 152 SECURITY DEFINER functions** (spot-checked `fn_admin_adjust_balance`, `fn_admin_set_user_role`, `fn_platform_appoint_platform_admin`, `fn_admin_delete_user` → all denied). The earlier "pending prod approval" note was stale.
- **What:** Nearly every `fn_*` in schema `public` is `EXECUTE`-able by `anon`/`authenticated`/`PUBLIC`, and the exposed admin/financial functions authorize on the **`p_actor_role` argument** rather than the caller's real role.
- **Evidence (read-only prod):** 90+ public functions granted `EXECUTE` to anon/authenticated incl. `fn_admin_adjust_balance`, `fn_admin_adjust_balance_kind`, `fn_admin_clear_balance`, `fn_admin_delete_user`, `fn_admin_set_user_role`, `fn_admin_rotate_seed`, `fn_approve_withdrawal`, `fn_complete_withdrawal`, `fn_create_withdrawal`, `fn_reject_withdrawal`. Surface is **LIVE**: `POST /rest/v1/rpc/fn_first_name` with only the **public anon key** returned `200 "Test"`. `fn_admin_adjust_balance` (0135) is `security definer` and gates only on the **string** `p_actor_role` (line 24); passing `p_actor_role='superadmin'` also **skips** the platform-scope branch (which only runs for `'platform_admin'`). `fn_platform_*` and `fn_addon_*` are already correctly revoked (the fix pattern exists).
- **Root cause:** the default Supabase EXECUTE-to-anon/authenticated posture was never revoked for the `fn_*` family; functions authorize on a passed-in role instead of `profiles.role`.
- **Impact:** any holder of the public anon key (embedded in the frontend) can call admin/financial RPCs **directly via PostgREST, bypassing the API guard entirely** — adjust any balance, set any role, approve/complete withdrawals, delete users, across all brands. Highest-severity path. No anonymous actor ids in `admin_actions` to date.
- **Fix (PREPARED, not yet applied):** `packages/db/migrations/0151_revoke_public_function_execute.sql` — revoke `EXECUTE` from `anon, authenticated, PUBLIC` on every **`SECURITY DEFINER`** function in `public`; `GRANT EXECUTE … TO service_role`; `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, PUBLIC` (no future function auto-exposes). **Verified safe:** the web app uses no PostgREST/anon RPC (no `@supabase/supabase-js`, no `.rpc(`; all traffic via `fetch` to the API), and the API/engine connect as the `postgres` owner — neither is affected. Idempotent + reversible.
- **⚠️ Refined from the original report (caught by test):** the report prescribed *"REVOKE EXECUTE ON ALL FUNCTIONS"*. A blanket revoke **broke the anon/authenticated RLS read path** — RLS policies call `SECURITY INVOKER` helpers (`current_site`, `is_site_admin`, `current_platform`, `jwt_role`) evaluated with the querying role's privileges, so stripping their `EXECUTE` yields `permission denied for function current_site` (reproduced via `e2e_platform_isolation.py`). Corrected to revoke **`SECURITY DEFINER` only**: DEFINER functions run as OWNER (the actual escalation surface); INVOKER functions run as the caller and cannot escalate, so they stay callable and RLS keeps working. Empirically: 228 anon-exposed pre-fix → **0 SECURITY DEFINER** anon-exposed post-fix, with RLS intact.
- **Regression guard (prepared):** `packages/db/_testkit/e2e_function_grants.py` — fails the build if ANY `SECURITY DEFINER` public function is `EXECUTE`-able by anon/authenticated/PUBLIC, asserts the specific admin/financial RPCs are closed, AND asserts the RLS helpers stay executable (so the fix can't regress into breaking RLS).
- **Deferred (larger, tracked):** rewrite each `fn_*` taking `p_actor_role` to read the actor's real role from `profiles` and ignore the parameter, so a future grant mistake is not a compromise.
- **Status:** PENDING — production DB change; **do not apply without explicit approval**.

## #37 — DB e2e harness silently tested a 30-migration-STALE schema (+ 2 stale test fixtures) — FIXED (branch `issue1-platform-tier`)
- **Surfaced while building Issue 1** (platform tier). Ran the whole `packages/db/_testkit/e2e_*.py`
  suite to establish a regression baseline; 6 of 18 scripts crashed on setup.
- **Root cause A (systemic):** every `reset_and_migrate()` applied migrations with
  `glob("00*.sql")`. That pattern matches `0001`–`0099` but **NOT `0100`–`0130`** (they start with
  `01`). So for a long time the DB e2e suite has been building its test DB from a schema **missing
  the last 31 migrations** — every `v_real_*`/`v_demo_*` view (0101), `min_withdrawal_native` (0120),
  payment-provider config (0130), etc. Any test touching a ≥0100 object crashed; tests that didn't
  simply passed against a stale schema (false confidence). Fixed the glob to
  `"[0-9][0-9][0-9][0-9]_*.sql"` in all 9 affected scripts (2 others had already fixed it locally with
  a comment about this exact pitfall).
- **Root cause B (fixture drift):** with the full schema now applied, two more pre-existing staleness
  bugs surfaced:
  - `fn_open_position(...)` calls hard-coded `config_version = 1`, but migration 0089 added the
    composite FK `positions(site_id, config_version) → site_game_config_versions(site_id, version)`
    and the default site's config is now at **version 3** (only the current snapshot is retained).
    A brand-new deployment opening at v1 would hit the same FK. Test fix: seed the default site's
    historic v1 snapshot in setup (test-created sites already get a v1 snapshot via the config
    insert trigger). *Note for prod: a fresh single-tenant bootstrap should ensure a v1 snapshot
    exists — tracked separately; not triggered on the live DB because its snapshots pre-date 0085.*
  - `fn_admin_set_user_overrides` was called with `house_edge:0.05` / `win_rate:0.9`, both of which
    migration 0074's `OVERRIDE_FAVORS_PLAYER` guard correctly rejects (better-than-house). Test fix:
    use punitive/valid override values (`win_rate:0.1`), which is what the guard permits.
  - The RLS tests (`e2e_rls_sites`, `e2e_rls_admin_sites`) `set role authenticated` but the shim
    never `grant`s that role SELECT, so they errored on the grant before RLS was ever evaluated
    (they had not run to completion in a long time). Test fix: `grant select on all tables in schema
    public to anon, authenticated` in setup, mirroring Supabase's default-privilege posture so RLS
    is the operative gate (matches the design intent of migrations 0051/0056).
- **Impact:** the DB e2e safety net was effectively inert for 0100+ behaviour. No production impact
  (harness-only), but it masked regressions.
- **Resolution:** all fixes above; the full suite is now **18/18 green** (incl. the new
  `e2e_platform_isolation.py`, 32 scenarios). See docs/38.

## #36 — Daraja B2C payouts failed SILENTLY when initiator/credential unset → withdrawals stranded in `processing` — FIXED (branch `fix/daraja-b2c-fail-loud`)
- **Surfaced by log analysis (post-#34/#35):** the only recurring non-4xx warning was
  `[payments] Daraja credentials not configured … using StubDarajaClient`. That specific line is benign
  (a boot-time ENV fallback; the API immediately loads the real STK creds from `mpesa_config` — "mpesa_config
  loaded from database"). But investigating it exposed a real latent gap.
- **Root cause:** `missingDarajaCredentials` only validates the **STK-4** (consumerKey/secret/shortcode/passkey).
  Live `mpesa_config` has those set, so the API builds a real `HttpDarajaClient` — but `b2c_initiator`
  and `b2c_security_credential` were **EMPTY**. `HttpDarajaClient.b2cPayment` POSTed those empty fields
  straight to Safaricom, which rejects the payout with no usable ConversationID/result callback. Because
  `fn_approve_withdrawal` flips the row to `processing` **before** the API dispatches, a rejected B2C left
  the withdrawal **stuck in `processing` with `conversation_id = NULL`** — the exact stranded-withdrawal
  state the operator had to clear by hand, with nothing in the logs explaining why.
- **Fix (code — surfaces the misconfig; the credentials themselves are operator config):**
  - New `missingB2cCredentials(cfg)` (b2cInitiator, b2cSecurityCredential, b2cResultUrl, b2cTimeoutUrl) —
    B2C readiness is now checked **independently** of STK.
  - `HttpDarajaClient.b2cPayment` now **fails loudly** with `MPESA_B2C_NOT_CONFIGURED:<missing>` *before*
    any network call, instead of POSTing empty creds and getting a silent Safaricom rejection.
  - `makeDarajaClientFromConfig` logs a clear **warning at every build/reload** when STK is ready but B2C
    is not — so the gap shows up proactively in the System logs UI (thanks to #34), not only when a
    withdrawal is attempted.
  - API `DOMAIN_STATUS`: `MPESA_B2C_NOT_CONFIGURED → 503`, so an admin approve returns a clear message.
- **Operator action still required:** set **B2C Initiator Name** + **B2C Security Credential** (Safaricom
  Daraja) in Admin → M-Pesa. STK deposits are unaffected and already live.
- **Tests:** `daraja.b2c.test.ts` (3 — missing-creds detection independent of STK; b2cPayment fails loud
  with no network; STK-only config still yields a usable deposit client with B2C guarded). Suites green:
  engine 314 / API 333; typecheck clean. No migration, no web change.

---

## #35 — Engine starved the session pooler: one LISTEN connection per brand for a GLOBAL channel — FIXED (branch `fix/engine-config-listen-multiplex`)
- **Surfaced by #34:** with system logs now capturing the engine, `[config] listen-connect [site …]:
  timeout exceeded when trying to connect` was firing ~49×/30min across brands.
- **Root cause:** the engine opened a **dedicated session-pooler LISTEN connection per brand** for the
  per-site config store (`configFor` → `SiteGameConfigStore({ connect })`), each held forever
  (`idleTimeoutMillis: 0`). But `listenPool` `max = 4` and there were **10 active brands** (plus the
  sites-store + deposit-feed LISTENs), so the first few brands permanently occupied the pool and every
  other brand's `connect()` timed out at 10s — forever — leaving those brands on the 15s poll fallback
  and spamming errors. `site_game_config_changed` is a **GLOBAL** channel (payload = the changed
  site_id), so N connections all listening to the same channel was pure waste.
- **Fix:** a `SharedSiteConfigListener` — **ONE** session connection LISTENing on the global channel,
  fanning each notification out to the matching brand's `refresh()` by payload (refresh-all when a
  notification carries no payload). Per-brand stores are now **poll-only** (the 15s fallback stays as a
  safety net), so a dropped shared connection degrades to polling, not silence; the shared listener
  reconnects with backoff. Engine session-LISTEN usage drops from ~12 → 3 (shared-config + sites +
  deposit) regardless of brand count. Also raised `PG_LISTEN_POOL_MAX` default 4 → 6 for reconnect
  headroom. No migration, no per-request/hot-path change.
- **Tests:** `siteconfiglisten.test.ts` (5 unit — one connection for many brands, payload dispatch,
  refresh-all on no payload, unknown-brand no-op, a throwing handler doesn't break others, reconnect
  after error re-arms LISTEN, `stop()` halts reconnects). Suites green: engine 311 / API 333; typecheck
  clean. Verified post-deploy that the timeout errors stop.

---

## #34 — System logs were only half-wired: the WS engine + all direct console.* were never captured — FIXED (branch `fix/system-logs-wire-all`, migration 0129)
- **Report (follow-up to #33):** "map and wire the ENTIRE logs" — #33 only persisted API request/error
  lines; the rest of the system was still invisible.
- **Map (exhaustive, no assumptions):** grepped every `createLogger` and every `console.*` in the
  backend. Findings: (a) the **WS engine has NO structured logger** — its boot, **crash recovery**,
  **daily-seed rotation**, **pool top-ups**, **payments/Daraja/MegaPay**, and WS error reporting are all
  `console.*` → stdout only; (b) the **API had 22 `console.*`** (boot/pool via `makePgPools`) bypassing
  the sink; (c) all these are low-frequency events — no per-tick/per-message hot path — so safe to persist.
- **Fix (both processes, one shared module):** new `systemlog.ts` `makeSystemLogPersister(pool,{app})`
  provides (1) a `loggerSink` for the structured logger and (2) `captureConsole()` that monkey-patches
  `console.{log,info,warn,error,debug}` so EVERY direct console call is persisted too — fully guarded
  (fire-and-forget, re-entrancy-safe, never throws/blocks/recurses). The **API** uses it as its logger
  sink AND captures console (`app='api'`); the **engine** installs `captureConsole()` (`app='engine'`)
  right after its pool is created. Added migration 0129 (`app` column + index, backfilled `'api'`) so
  the UI can filter by process; the read path, `GET /admin/logs`, and the UI gained an `app` filter +
  per-row service badge. Default persist level raised to **`info`** (captures the full request stream +
  every event; `debug`/health excluded); retention prune unchanged.
- **Coverage now:** API requests + errors + money-path (reconcile) + boot console; engine boot + crash
  recovery + seed rotation + pool realtime + platform live-feed + payments (Daraja/MegaPay) + WS errors.
- **Tests:** `systemlog.test.ts` (4 unit: sink promotes columns + drops below-threshold; console capture
  maps level, tags app, serializes Errors, marks `via:console`, restores originals; null-pool no-op;
  idempotent install) + `e2e_system_logs.py` extended to 13 (adds `app` filter). Suites green: engine
  307 / API 333; backend + web typecheck clean; `next build` clean; migrations idempotent.

---

## #33 — System logging was implemented but had no UI (owner couldn't view logs) — FIXED (branch `fix/system-logs-ui`, migration 0128)
- **Report:** "I don't have a UI to see all system logs — it was implemented but the UI was never."
- **State found:** the shared structured logger + per-request logging (docs/36) were implemented, but
  emitted **stdout only** (Fly). There was no queryable store, no API and no UI — distinct from the
  business **Audit log** (`admin_actions`, which already has `/admin/audit`). So system/request/error
  logs could only be seen via `fly logs`.
- **Fix (end-to-end):**
  * **DB (migration 0128):** append-only `system_logs` table (promoted queryable columns + `fields`
    jsonb) with keyset + filter indexes, and `fn_prune_system_logs(keep_days)` for retention.
  * **API sink (`server.ts`):** a logger sink that keeps the stdout line AND persists lines at
    `>= LOG_PERSIST_LEVEL` (default `warn`) to `system_logs` — fire-and-forget, so logging can never
    block/fail a request. Wired as the app + reconcile-sweep logger (so money-path errors persist too),
    plus a periodic retention prune (`LOG_RETENTION_DAYS`, default 30).
  * **Read path:** `GET /admin/logs` — **platform_superadmin only** (system logs are cross-brand
    operational data) — via `AdminService.listSystemLogs` with filters (level, status, q on msg|path,
    requestId, since) + cursor pagination; in-memory harness returns an empty page.
  * **Web:** a **System logs** page (`/admin/logs`) under the owner Platform nav — level filter,
    debounced message/path search, level/status badges, request-id correlation, load-more.
- **Tests:** `e2e_system_logs.py` (11 DB scenarios: newest-first, level/status/requestId/since/text
  filters, keyset paging, retention prune) + `app.admin.test.ts` +1 (owner-only gate: admin/superadmin
  403, anon 401, platform_superadmin 200 page shape). Full suites green: engine 303 / API 333; backend
  + web typecheck clean; `next build` clean (`/admin/logs` builds); migration idempotent.
- **Scope note:** persists API logs (requests, errors, money-path, Mega Pay/Daraja reconcile) — the
  actionable set. Engine (WS) logs can be wired to the same sink as a follow-up. Default persist level
  is `warn` (errors + rejections); set `LOG_PERSIST_LEVEL=info` to capture the full request stream.

---

## #32 — Approved withdrawals stuck in "processing" forever; no way to mark a payout paid when the B2C callback fails — FIXED (branch `fix/admin-mark-withdrawal-paid`, migration 0127)
- **Report:** approved/paid withdrawals still show "processing"; the admin needs to mark a payment paid
  manually when the rail (e.g. Mega Pay) fails to reflect it, and that must show as paid on the client.
- **Root cause:** the withdrawal lifecycle debits the wallet at request (`fn_create_withdrawal`), flips to
  `processing` on approval (B2C dispatched), and only reaches `success` when the provider's async result
  callback arrives (`fn_complete_withdrawal`). When that callback never lands — a known Mega Pay / Daraja
  failure mode — the row is stranded in `processing`: the money already left the wallet, the player was
  paid out-of-band, but the client shows "processing" indefinitely and there was **no admin action** to
  finalise it (only approve/reject existed). 4 live rows were stuck (invest254 ×2, madolar ×2).
- **Fix:**
  * **DB (migration 0127):** `fn_admin_mark_withdrawal_paid(tx, admin, receipt)` transitions a
    pending/processing withdrawal → `success` with a manual receipt + an `admin_actions` audit row.
    **No wallet change** (money already debited at request). Idempotent on an already-paid row; **refuses**
    a failed/reversed row (`WITHDRAWAL_ALREADY_REVERSED`) so a returned payout is never double-paid.
  * **API:** `POST /admin/withdrawals/:id/mark-paid` — same guards as approve: `requireRole('admin')` +
    superadmin approval-password + `assertTargetSiteInScope` (brand-scoped). Threaded through
    PaymentService/PaymentRepository (pg + in-memory) → fires the same success event as the B2C path so
    the activity feed reflects it.
  * **Web:** a password-gated **"Mark paid"** action in the Withdrawals queue for `pending`/`processing`
    rows; the player's client then shows the withdrawal as paid (reads the same tx status).
- **Tests:** `e2e_admin_mark_withdrawal_paid.py` (17 DB scenarios: processing→paid with wallet unchanged,
  idempotent, pending→paid, reversed refused, unknown tx, audit row) + `app.approvalgate.e2e.test.ts` +4
  (password gate, processing→success + idempotent, brand-scope, reversed→409). Full suites green:
  engine 303 / API 332; backend + web typecheck clean; `next build` clean; migration idempotent.
- **Note:** the 4 currently-stuck rows are left for the operator to mark paid (or reject) per-row via the
  new control — only the operator knows whether each recipient was actually paid out-of-band.

---

## #31 — A soft-DELETED same-phone account shadowed a marketer's login; @jake locked out of the mpesa app — FIXED (branch `fix/marketer-login-deleted-shadow`)
- **Report:** @jake (marketer) still could not log into the mpesa app after the #30 PIN fix.
- **Investigation (live data, no guessing):** jake has 5 same-phone (`0113488568`) accounts across brands,
  oldest-first: **`@dave` player invest254 `status=deleted` (has password)**, `@jake` marketer safitraders
  active, `@boyz` tamutraders banned, `@jake` madolar player active, `@boyz` 33traders active. His marketer
  wallet is on safitraders (active). The app's non-PIN path is `login-web` (password) → `auth.login({anyBrand:true})`.
- **Root cause:** `AuthService.login` built the candidate list oldest-first, **broke on the FIRST password
  match, then rejected it if `deleted`**. Since jake reuses one password, the first match was his OLDEST
  account — the soft-deleted `@dave` — so login threw `INVALID_CREDENTIALS` and never reached his active
  safitraders marketer account. A soft-deleted account was **shadowing** a valid same-phone account in the
  cross-brand (marketer-app) path. (Not the default-marketer bug — verified independent code paths.)
- **Fix (`apps/engine/src/authservice.ts`):** SKIP `deleted` candidates during password matching, so a
  soft-deleted account can never shadow a valid same-phone account; keep the hard "deleted can't sign in"
  rule (a deleted-ONLY phone still 401s) and constant-time behaviour (a dummy verify when every candidate
  was skipped). Single-account (normal per-brand web) login is unchanged. Code-only (no migration); ships
  on the next Fly deploy.
- **Ripple checked:** callers of `auth.login` are the per-brand web login (single candidate — unchanged)
  and the marketer `login-web` (`anyBrand` — fixed). After the fix jake resolves via ANY non-deleted match
  (his safitraders marketer directly, or a player/banned account → `profileByPhone` any-brand fallback →
  safitraders wallet). Combined with #30 (PIN sig-9) and his now-present marketer PIN, BOTH app login paths
  work. If a marketer's password matches ONLY a deleted account, that is a password-reset case, not this bug.
- **Tests:** `app.marketers.webauth.test.ts` +2 — the deleted-shadow scenario now logs in (was 401), and a
  deleted-ONLY phone still 401s. Full suites green: shared 219 / engine 303 / API 328; typecheck clean.

---

## #30 — Marketer PIN login (mpesa_2 quick-login) failed on any non-07 phone format, on every brand — FIXED (branch `fix/marketer-login-phone-sig9`, migration 0126)
- **Report:** "some marketers cannot log into one or both apps" (mpesa_2 / truecaller).
- **Root cause:** `fn_marketer_login` (PIN path, `POST /marketers/auth/login`) matched `marketers.phone =
  v_phone` EXACTLY (btrim only) — the ONE marketer lookup never migrated to the canonical
  `fn_phone_sig9` (right-9-digits) rule that `profileByPhone`, `fn_marketer_game_withdraw`,
  `fn_is_marketer_account` (0086/0100) all use. The apps send the phone exactly as typed
  (mpesa_2 `PinLoginScreen` reuses `AppState.phone` captured at first sign-in), so a marketer who
  entered `+254…`/`254…`/bare `7…` could sign in with a PASSWORD (`login-web` → `profileByPhone`
  normalizes) but then FAILED the PIN quick-login on relaunch (exact match vs stored `07…`), on ANY
  brand. truecaller uses password-only, so it was unaffected — hence "one or both apps".
- **NOT the default-marketer bug:** marketer login resolves the `marketers` wallet + `marketer_credentials`
  PIN / website password — never `profiles.role` or `sites.owner_user_id`. Verified the two are
  independent code paths.
- **Fix (migration 0126, same 3-arg signature — CREATE OR REPLACE, no app/engine change, no deploy
  window):** match candidates AND the failed-attempt throttle on `fn_phone_sig9(phone)=fn_phone_sig9(input)`
  with a length-9 validity guard; PIN verify, per-account lockout, active-status and optional site scope
  unchanged. Fixes both apps for every marketer on every brand with no APK rebuild (server-side).
- **Also confirmed correct (no change needed):** the mpesa_2 "hardcode SITE=33traders on login" commit
  was rightly REVERTED (a single generic build must not name a brand); the apps send no site and the
  server resolves the brand from the credential (`login-web` via `auth.login anyBrand`; PIN via
  `fn_marketer_login` cross-brand). Those server fixes were already live (deployed 2026-09-12).
- **Tests:** `e2e_marketer_login_phone.py` — 14 scenarios (07/254/+254/bare/spaced all resolve;
  wrong-PIN + 5-miss lockout; cross-brand no leakage; site-hint scoping; malformed phone). Idempotent;
  backend typecheck clean. Read-only prod check: all 8 active marketers now match under 254-format entry.

---

## #29 — Default marketers on brands that lacked a default when deposits happened showed zero stats — FIXED (data backfill)
- **Report:** "the dashboard isn't populating accurate figures — e.g. the 66investors default marketer
  can't see his statistics."
- **Root cause:** `fn_pay_referral_commissions` roots the 25% at the brand's default marketer
  (`sites.owner_user_id`). Brands that had NO default marketer when deposits occurred (66investors,
  tamutraders never assigned; invest254 partially) accrued NO commission, so the (now-assigned) default
  marketer's dashboard read zero — a DATA gap, not a query bug (33traders/invest254/madolar/safitraders
  with defaults at deposit time were accurate).
- **Fix (data):** replayed the idempotent production accrual RPC over the 373 uncredited successful
  deposits. Result (all `accrued`, zero wallet-affecting rows — no depositor had a referrer so the 5%
  player perk never fired): joy +2,157,175¢ (invest254), mark_mumo +577,500¢ (66investors),
  Blessing.21 +50,000¢ (tamutraders). Every brand gap closed to ≤1¢ (float rounding). cpfmarket's 25%
  was already paid to its prior owner, so its new default legitimately starts at 0. Committed inside a
  transaction that asserted wallets untouched and gaps closed. Recurrence is prevented by the default
  now being set on every brand plus the 0104/0124/0125 default-marketer guards.

---

## #28 — Platform owner couldn't manage a brand's default marketer while impersonating it (Issue-1 control unreachable via impersonation) — FIXED (branch `fix/impersonation-default-marketer-scope`, migration 0125)
- **Report:** while impersonating **66investors**, `Make brand default` / `Remove as default` on a
  66investors marketer (`mark_mumo`) failed `SITE_SCOPE_FORBIDDEN` — a *same-brand* action that should
  succeed.
- **Root cause:** `fn_admin_set_site_owner` (0104/0124) was the ONLY RPC that fenced by the ACTOR's own
  `profiles.site_id`. Impersonation mints a token `role='superadmin', site=<brand>` but keeps the
  SUBJECT = the platform owner (for audit). So `p_actor` is the owner (home brand = the platform's own
  site), while the acted-on brand is the impersonated one. The RPC's actor-home check therefore raised
  `SITE_SCOPE_FORBIDDEN` on every make-/clear-default while impersonating any brand other than the
  owner's home — making the admin-panel default-marketer control (Issue 1) unreachable exactly the way
  the operator uses it. The API's own `ensureUserInScope` (token-scoped) had already allowed it; the
  redundant DB actor-home check contradicted the token.
- **Reproduced (read-only local PG, all migrations):** actor home=SITE_A, `fn_admin_set_site_owner(owner,
  'superadmin', <SITE_B marketer>, true)` → `SITE_SCOPE_FORBIDDEN`.
- **Fix (migration 0125, same 4-arg signature — CREATE OR REPLACE, no call-site/engine change, no
  deploy window):** skip the RPC's actor-home fence when the actor's PROFILE role is
  `platform_superadmin` (the platform owner is inherently cross-brand even via an impersonation
  superadmin token). The impersonation fence stays enforced at the API/token layer
  (`assertTargetSiteInScope` on the token's `site` claim). A REAL per-brand admin/superadmin remains
  home-fenced (defence in depth). The RPC still validates active-marketer-on-site for ASSIGN.
- **Tests:** `e2e_default_marketer_lock.py` extended to **35 scenarios** — owner impersonating SITE_B can
  make + clear a SITE_B default (was forbidden); a real SITE_A superadmin still cannot reach SITE_B; owner
  impersonating their home brand still works. Backend typecheck clean; API 326/326; migration idempotent.
  (The API in-memory harness mocks this RPC, so the DB e2e is the authoritative coverage.)

---

## #27 — Impersonation was invisible: the console showed "OWNER · FULL AUTHORITY" while fenced to one brand, and logout didn't clear the fence — FIXED (branch `fix/impersonation-clarity`)
- **Report:** as the platform owner (`@zrinok`), every write on a `mark_mumo` (brand **66investors**)
  page failed with `SITE_SCOPE_FORBIDDEN`, even after logout + hard refresh.
- **Root cause (NOT a security bug — a clarity/lifecycle bug):** `/platform/sites/:id/impersonate`
  deliberately mints a **brand-scoped `superadmin`** token (`site` = target brand) so the owner acts
  only within that client's brand. That enforcement is correct. But:
  1. **Invisible fence.** `AdminShell` derived its identity from the live `/auth/me` role
     (`platform_superadmin`), so it displayed "invest254 Console · Owner · full authority / ★ System
     owner" *even while impersonating another brand*. The owner couldn't tell the session was fenced,
     so a cross-brand write looked like a broken permission rather than the wrong brand.
  2. **Sticky after logout.** `logout()` cleared the session token but not the impersonation
     sessionStorage (`pp-impersonating-brand` / `pp-platform-return-token`), and `SessionBootstrap`
     deliberately suppresses the token drift-refresh while `isImpersonating()`. So the fence could
     survive a logout, and a stale brand scope leaked into the next view.
  3. **Dead-end nav.** The cross-brand "All brands" (platform) nav stayed visible while impersonating,
     but the brand-scoped token 403s against `/platform/*`.
- **Fix (`fix/impersonation-clarity`):**
  * Extracted the impersonation state machine into a **framework-free core** (`impersonate.core.ts`)
    with strict validation (fail-closed on a corrupt/tampered brand blob or malformed mint result) and
    a new `clearImpersonation()`; `impersonate.ts` is now a thin sessionStorage/session/window wrapper.
  * **Logout and forced-401 now clear the fence** (`useAuthActions.logout`, `SessionBootstrap`) — a
    brand scope can never outlive the session that created it.
  * **AdminShell reflects the fence:** while impersonating it shows "{Brand} Console · Impersonating ·
    superadmin" and a warn "◉ Impersonating {slug}" badge instead of "Owner · full authority / ★ System
    owner", and it hides the cross-brand "All brands" nav (return via the banner's "Exit to platform").
  * **Banner** made unmistakable: "Impersonating {Brand} as superadmin · {domain} · actions are fenced
    to this brand" with a warn-accented Exit.
- **Tests (tested + retested across different brands):**
  * `impersonate.core.test.ts` — 13 pure unit tests: parse/validation, begin/read/end round-trips,
    switching between brands A→B→C, independent round-trips per brand, clear/idempotency, and
    fail-closed on malformed input / null storage.
  * `app.platform.impersonate.test.ts` — 7 server tests proving the real ENFORCEMENT: the route is
    platform-only; it mints a superadmin token fenced to the TARGET brand for two distinct brands; an
    impersonation-shaped token (`site=B`) can write to B but NOT A, and swapped (`site=A`) can write to
    A but NOT B (SITE_SCOPE_FORBIDDEN), including the default-marketer routes; and an un-fenced session
    is unrestricted on both brands (the exit state).
  * Full suites green: shared 219, engine 303, API 326; web lib 71 (incl. 13 new); backend + web
    typecheck clean; web `next build` clean.
- **Note:** frontend chrome (banner/sidebar) is presentational over the unit-tested core; the
  security-relevant scoping is enforced server-side and covered by the API suite above.

---

## #26 — A brand's DEFAULT marketer could be demoted to 'player', stranding it un-removable + dashboard-less — FIXED (branch `fix/default-marketer-role-lock`, migration 0124)
- **Report (Issue 1):** "the admin must be able to remove a default marketer" and "some marketers cannot
  see their dashboard."
- **Evidence (read-only, production):** three brands had a default marketer (`sites.owner_user_id`)
  whose role had been demoted to **`player`**: `1000wins → @claudia`, `cpfmarket → @marketer001`,
  `muchwins → @sheila`. The `admin_actions` audit shows each was promoted to `marketer`, assigned as
  the brand default, then a superadmin ran `user.set_role` → `player` (claudia 2026-09-13, marketer001
  2026-09-14, sheila 2026-09-15). All three still hold active `affiliates` rows and were still being
  credited deposit commission (marketer001 had KES 100 accrued, sheila KES 194.15) — money routed to
  accounts that can no longer open the marketer dashboard.
- **Root cause:** migration 0104 locked *status* changes (ban/suspend) on a brand default
  (`fn_admin_set_user_status` → `DEFAULT_MARKETER_LOCKED`) but **never locked *role* demotion**.
  `fn_admin_set_user_role` freely moved a brand default out of `'marketer'`, producing an invalid
  state the guarded assign RPCs can't even create. That state then wedged two ways:
  1. **Un-removable:** `fn_admin_set_site_owner` validated `role='marketer'` for BOTH the assign AND
     the clear path, so clearing a now-`player` owner raised `OWNER_NOT_MARKETER`; and the admin panel
     hid the whole control because it was gated on `q.data.role === 'marketer'`.
  2. **Dashboard-less:** `/dashboard` (and the marketer HUD) require `role === 'marketer'`, so a
     demoted default is redirected home even though it is, in substance, the brand's earning marketer.
- **Fix (migration 0124 + web):**
  * **DB:** split `fn_admin_set_site_owner` validation — ASSIGN still requires an ACTIVE marketer on
    the actor's own brand; CLEAR now works for ANY current owner (role/status irrelevant) and derives
    the cleared brand from the ownership row itself, so a corrupt default is always removable. Added
    the symmetric **role-demotion lock** to `fn_admin_set_user_role`: a brand default cannot be moved
    out of `'marketer'` until removed/reassigned (`DEFAULT_MARKETER_LOCKED`); setting/keeping
    `'marketer'` and auto-enroll-on-promotion are unchanged.
  * **Web (`admin/users/[id]/view.tsx`):** render the default-marketer control whenever the account
    *is* a brand default (even if its role drifted off `marketer`) so the Remove action is reachable;
    only offer "Make brand default" for an actual marketer; warn on a stale (non-marketer) default;
    and surface a plain-language `DEFAULT_MARKETER_LOCKED` message on the role control ("remove them as
    the brand default first, then change their role").
- **Why this is the once-for-all fix:** the DB RPC is the authoritative production guard (the API and
  in-memory dev mirror sit behind it). GAP 1 makes removal always possible for every current/future
  corrupt row; GAP 2 stops the corruption from ever being re-created. The pre-existing three rows are
  repaired by a separate operator-confirmed data step and are now also removable directly in the panel.
- **Tests:** new `packages/db/_testkit/e2e_default_marketer_lock.py` — 28 adversarial scenarios on a
  real PG17 with ALL 124 migrations (auth gate, assign active-marketer-only, suspended/​player rejects,
  demotion lock for admin+superadmin, keep-marketer allowed, site-scope on clear, removal, re-enable
  after removal, repair of a forged player-owner default, idempotent no-op clear, platform cross-brand
  clear). Full suites green: shared 219, engine 303, API 319; backend + web typecheck clean; web
  `next build` clean. Migration re-applies idempotently.
- **Note:** the DB-e2e harness's `reset_and_migrate()` globs `00*.sql`, which silently stops at 0099
  (misses 0100–0124); the new test uses `[0-9]*.sql`. Pre-existing suites `e2e_platform_console.py` and
  `e2e_affiliate_sites.py` fail on stale test bodies (a removed `min_withdrawal_native` column; a
  `config_version` FK) independent of this change — logged for a follow-up test-maintenance pass.

---

- **Request (operator, Issue 1):** remove the "Demo balance (for showcasing the game)" card from the
  marketer dashboard, then reorganise the dashboard to bank standards — "if we have 50 expenses, do we
  really list all of them? pages? tables?"
- **Change 1 — demo card removed.** Deleted the self-service demo-wallet section (`useMarketerProfile`
  + `useMarketerDemoTopup` usage, `demoWallet`/`demoTopup`/`demoMsg` state and the `topUpDemo` handler)
  from `apps/web/src/components/marketer/MarketerDashboardView.tsx`. **Frontend-only** — the backend
  demo-topup endpoint, hooks (`api.marketerMe`/`api.marketerDemoTopup`), migration 0102 and
  `app.marketers.demotopup.test.ts` are untouched, so nothing else regresses and the capability can be
  re-surfaced elsewhere if ever wanted.
- **Change 2 — bank-standard IA (progressive disclosure).** The four unbounded lists were the real
  defect: **Expenses rendered EVERY row** (`expRows.map` with no cap — the literal "50 expenses" dump),
  while Earnings/Referrals hard-capped at `.slice(0, 8)` with **no way to see the rest** (referrals even
  had cursor pagination available but unused). Replaced them with ONE tabbed **Activity** ledger
  (Earnings · Expenses · Referrals · Advances), each paged at `LEDGER_PAGE_SIZE = 6` with an explicit
  "Showing X-Y of N · page/pages · Prev/Next" pager; referrals additionally drive the real
  `useAffiliateReferrals` cursor via a "Load more" control. The reconciling commission statement was
  promoted to its own summary card (the trust anchor), and the advance REQUEST form kept as an action
  card with its history moved into Activity ▸ Advances. Hero ("Available to withdraw") stays the
  dominant, role-first metric. Grounded in fintech-dashboard research: lead with one metric, disclose
  detail progressively, paginate with explicit indicators (not infinite scroll) on mobile.
- **Latent bug caught (pre-existing):** the removed demo card and (initially) the new tab control used
  the Tailwind class `bg-card`, but **`card` is not a defined colour token** (tailwind.config only
  defines bg/surface/surface-2/border/fg/muted/up/down/accent/accent-fg/brand/warn/info). Evidence: the
  compiled stylesheet contains **zero** `bg-card` rules (`grep -c bg-card .next/static/css/*.css → 0`).
  Impact: any element relying on `bg-card` for its fill silently rendered transparent. Resolution: the
  new Activity tabs use the app's established segmented-control tokens (`bg-accent text-accent-fg
  shadow-sm` for the active tab, matching `WalletModal`); `bg-card` no longer appears anywhere.
- **New pure module + tests:** `apps/web/src/lib/affiliate/paginate.ts` (`pageInfo`, `pageSlice`) is
  total by construction — hostile input (page 0/999, negative/NaN size, empty list) is clamped, never
  thrown, so a transient data shape can't crash the page. Covered by `paginate.test.ts` (10 cases incl.
  a 5,000-iteration fuzz proving the pages tile the list exactly once, in order, with no gaps/overlaps).
- **Verification (E2E, real-life scenarios):** green baseline captured first (`tsc --noEmit` + full
  `next build`), then re-run after the change — both exit 0, `/dashboard` builds. Full web lib suite:
  **52/52 pass** (incl. the 10 new pagination tests), zero regressions. Rendered the redesign against
  the app's actual compiled Tailwind + default dark tokens with mock data at scale (12 earnings, **50
  expenses**, 26 referrals, 3 advances) and screenshotted mobile (400px) + desktop (920px) across every
  tab and page — confirms the demo card is gone, the 50-expense list is paged 6-at-a-time (1/9), and
  layout reflows to a 4-col grid on desktop. No money-path or API changes; the reconciliation ladder
  (earned − expenses − paid − held ⇒ available) is preserved byte-for-byte.

## #24 — Migration 0118 (real-time pool top-up) was NEVER applied to prod, yet the live engine calls it — FIXED (migration 0118 applied + ledger reconciled)
- **Caught while** reconciling the migration ledger during the BUGLOG #23 rollout: the CI `migrations-ledger`
  gate had been RED for 6+ consecutive runs on `main` (i.e. before the #23 merge), flagging 0117–0120 as
  UNRECORDED.
- **Investigation (no assumptions — checked the LIVE DB, not just the files):**
  * 0117 (`fn_pay_referral_commissions` rail-agnostic + `v_owner` root), 0119 (`fn_pool_ensure_day`) and
    0120 (`site_game_config.min_withdrawal_native`) were APPLIED but never `--record`ed in
    `schema_migrations` → recorded them (metadata only, no behaviour change).
  * **0118 (`fn_pool_topup_today`) was genuinely ABSENT from prod.** But the deployed engine calls it on
    every deposit-triggered reallocation (`apps/engine/src/server.ts:265`), and the platform envelope is
    LIVE (`platform_global_config.global_daily_pool_cents = 20,000,000` = KES 200k), so the gate was open.
- **Impact:** each real-time pool reallocation threw `undefined_function` (caught by the engine's
  `onError`, logged, non-fatal), so **intra-day withdrawal-pool top-ups to under-served brands silently
  never happened** (docs/25 §15.1) — the daily distributor's once-a-day budget was the only allocation,
  degrading payout headroom for brands seeing live demand.
- **Verification before applying (rollback-only txn against the real pool row, site 000…001, today):**
  never-clawback (request < current ⇒ unchanged 7,012,995), raise (request > current ⇒ set to request),
  role-gate (non-superadmin ⇒ `NOT_AUTHORIZED`). Confirmed ZERO persistence from the test (amount
  restored, function absent) before the real apply.
- **Resolution:** applied migration 0118 to prod (additive, idempotent, revertible, money-safe by
  construction — only ever raises via `greatest()`), recorded it + 0117/0119/0120/0121 in
  `schema_migrations`. Ledger now reconciles exactly (121 files = 121 rows, 0 problems), so the
  `migrations-ledger` CI gate goes green.
- **Follow-up (DONE — `chore/auto-apply-migrations-on-deploy`):** the root cause was that migrations
  were applied to prod out-of-band, decoupled from recording. Added `scripts/migrate.mts` — an
  idempotent runner that APPLIES each unrecorded migration and RECORDS it in the SAME transaction
  (apply+record atomic ⇒ the ledger physically cannot drift), refuses to touch a CHANGED (edited-after-
  apply) file, and aborts on first failure. Wired into `deploy.yml` as a gate: `verify → migrate →
  deploy`, so prod schema is always current before the new code boots. (A plain `migrations_status
  --record` was rejected: it stamps files as applied WITHOUT running them, which would mask exactly this
  class of gap.) Validated e2e against the live DB (apply / idempotent / CHANGED-abort / FAILED-rollback,
  then cleaned up).

## #23 — Marketer "Net after expenses" didn't reconcile with withdrawable; expense TOTAL summed a capped page — FIXED (branch `fix/marketer-net-after-expense`, migration 0121)
- **Report (operator):** "fix the bug in the calculation of Marketers net after expense."
- **Root cause (three distinct defects, banker's ledger view):** the marketer's money is one ledger —
  `E` = accrued marketer commission, `X` = Σ logged expenses/advances, `P` = paid commission payouts,
  `H` = held (requested/approved) payouts, and the authoritative withdrawable is
  `Available = max(E − X − P − H, 0)` (`fn_commission_balance`, migration 0105). The dashboard broke that ledger in three ways:
  1. **"Net after expenses" = `earned − expenses`** (`MarketerDashboardView.tsx`) ignored `P` and `H`, so
     it overstated the position of any marketer who had been paid. Evidence (prod, read-only): *jake*
     showed **+KES 410** "net" while his real `Available` was **0** (E 850 − X 440 − P 562.50 → floored 0).
  2. **Expense TOTAL summed a limit-capped page**, not all rows. `GET /affiliate/expenses` and
     `GET /admin/affiliate/expenses` returned `totalCents = reduce(items)` where `items` is capped at
     `limit` (default 100), while `fn_commission_balance` nets the FULL SQL sum. Rollback-txn e2e: 150
     expense rows → the page-sum reported **10,000** vs the true **59,000** (a 49,000 undercount) — the
     displayed total silently diverges from what actually reduces the withdrawable.
  3. **`earned` was defined two ways.** `myReferral` computed `earnedCents` as an UNFILTERED sum of all
     the user's `deposit_commissions`, but pulled `held/paid/available` from `fn_commission_balance`
     (accrued-marketer only). For a player (instant 5% `status='paid'` rows) later promoted to marketer,
     "Earned all-time"/"Net after expenses" would include already-paid player commission and diverge
     from `Available`. Latent (0 cases in prod today) but a real correctness defect.
- **Operator direction:** think like a banker; find and fix ALL the miscalculations; no guesswork; test e2e.
- **Resolution (branch `fix/marketer-net-after-expense`):**
  * **Migration 0121:** `fn_marketer_expenses_total(uuid)` — the authoritative full sum, mirroring the
    `ex` term in `fn_commission_balance`. Additive, idempotent, read-only, `service_role`-only.
  * **API:** `MarketerExpensesDeps.total()` (pg + test fake); both expenses endpoints now return
    `totalCents` from the full sum, never the page. `ReferralSummary` gains `marketerEarnedCents`
    (= `fn_commission_balance.earned_cents`) so the marketer balance context uses one consistent `earned`.
  * **Web:** the dashboard's Expenses section is now a **reconciling statement** —
    `Earned → −Expenses (= Net after expenses) → −Paid out → −Pending → = Available to withdraw` — that
    ends on the exact figure the hero/KPI show. "Net after expenses" is kept as a labelled subtotal (now
    on the FULL expense sum) and can no longer mislead because the ladder continues to the true withdrawable.
    `ReferralCommissionsCard` shows `marketerEarnedCents` for marketers (players keep `earnedCents`).
- **Verification:** typecheck clean; 880/880 unit tests pass (incl. a new regression test proving
  `totalCents` is the full sum with `limit` < row count). Rollback-only DB e2e against the LIVE functions:
  for every marketer `max(E−X−P−H,0) == fn_commission_balance.available` AND `fn_marketer_expenses_total == SUM(expenses)`; the 150-row divergence proof above; ROLLBACK verified (function absent post-rollback, no rows written).
- **Known follow-up (not changed here — money-flow gating needs sign-off):** `fn_approve_commission_payout`
  / `fn_mark_commission_payout_paid` don't re-validate the payout against a balance reduced by an expense
  logged AFTER the request. The hold is locked at request time, so an expense added between request and
  pay is only recovered from FUTURE commission (the ledger stays floored ≥ 0, never negative). Payouts are
  human-gated (admin approval + superadmin password), so exposure is low. Recommend a re-check at
  approve-time as a separate, reviewed change.

## #22 — Deposit page + API ignored the `mpesa` gateway switch (Daraja always shown) — FIXED (branch `fix/deposit-gateway-switch-gating`)
- **Evidence:** in the first cut of the gateway switches (0116), `DepositPanel` rendered the "STK Push"
  and "Pay Bill" (Daraja) tabs **unconditionally**, and the API `/deposits` + `/deposits/paybill/claim`
  routes had no provider check. So switching the `mpesa` provider **off** (superadmin, e.g. because
  Pay Bill was faulty) still left Daraja visible and usable — the switch only governed Mega Pay.
- **Impact:** a superadmin who disabled M-Pesa still exposed the broken Daraja/Pay Bill rail to real
  players. Caught immediately after go-live (the operator had turned M-Pesa off + Mega Pay on).
- **Resolution:** the `mpesa` provider now governs BOTH Daraja rails. `DepositPanel` renders STK Push +
  Pay Bill only when `mpesa` is effective-enabled and Mega Pay only when `megapay` is (loading + empty
  states handled; single-method hides the tab bar). Server-side, `/deposits` and `/deposits/paybill/claim`
  refuse with `PROVIDER_DISABLED` when `mpesa` is off — mirroring the `/deposits/megapay` gate. New test
  in `app.megapay.test.ts` locks it. Fail-open (M-Pesa) still applies if the provider lookup errors.

---

## #21 — Deposit `ABOVE_MAX` mapped to HTTP 500 instead of 400 — FIXED (branch `feat/megapay-gateway`)
- **Evidence:** `PaymentService.initiateDeposit` throws `ABOVE_MAX` when a deposit exceeds the
  platform-global max single deposit (migration 0099), but `DOMAIN_STATUS` in `apps/api/src/app.payments.ts`
  had no entry for `ABOVE_MAX`, so the router mapped it to a generic **500 Internal Server Error**.
- **Root cause:** the max-deposit enforcement (0099) added the `ABOVE_MAX` throw but the HTTP error map
  was not updated, so a legitimate client-side validation failure surfaced as a server fault.
- **Impact:** a player entering an over-cap amount got a 500 (looks like an outage / no actionable
  message) instead of a clean 400 "amount exceeds the maximum". Pre-existing; low severity, no money effect.
- **Resolution:** added `ABOVE_MAX: 400` (plus the new Mega Pay codes `PROVIDER_NOT_FOUND`,
  `PROVIDER_DISABLED`, `MEGAPAY_NOT_CONFIGURED` 503, `MEGAPAY_INITIATE_REJECTED` 502,
  `MEGAPAY_VERIFY_PENDING` 409) to `DOMAIN_STATUS`. Covered by the deposit-floor/junk test in
  `app.megapay.test.ts`.

---

## #20 — Multipliers were pool-blind, tick-blind, transport-less and crash-unsafe — FIXED (branch `feat/issue1-multipliers-live`)
- **Evidence:** the Phase-2 multiplier engine methods existed but (a) TP/SL/stop-out/DC were never
  evaluated by any loop (the settle methods were dead code nothing called), (b) no WS/REST transport
  reached them, (c) P/L priced off the classic BTC/KES curve instead of the instrument the player was
  viewing, (d) open contracts lived only in memory (a restart stranded the debited stake), and
  (e) the pool fund did not govern them — an uncapped, player-timed cash-out book (manual close at
  any green tick) is even more loss-exposed than fair digits.
- **Resolution (same central algorithm as digits/rise-fall):**
  * Instrument feed pricing + per-tick evaluation via `tickMultipliers` (driven by the per-(site,
    instrument) streamer): TP / SL / stop-out / deal-cancellation auto-close; `mult_update` /
    `mult_closed` pushed to owners; `open_multiplier` / `close_multiplier` messages.
  * **Pool mode = timed bracket contract** decided at open with `decideReserveFixed` (candidate
    payout = stake + TP, default TP = +100% of stake): reserve → seeded 20–60s reversing path →
    auto-settle at exactly +TP (commit) or stop-out at −stake. SL/DC/manual close unavailable in
    pool mode (decision B). ONE shared budget + turnover + RTP ceiling across all three surfaces.
  * Crash recovery: pool contracts settle/re-arm from the persisted decision; statistical ones
    re-arm from `positions.contract`; boot re-arms instrument streamers so recovered contracts keep
    evaluating with zero clients connected.
  * Web `MultipliersPanel` trades real server-acked contracts (simulation removed).
- **Impact:** multiplier losses are hard-capped by the same central pool; realized RTP ≤
  1 − house_edge at every volume. Tests: full suite **813/813** (new: 6 statistical feed scenarios,
  6 pool scenarios incl. shared-budget + double-crash recovery, 2 WS e2e); typecheck clean.

---

## #19 — Digits shipped POOL-BLIND: a fair 5%-edge book with no budget cap (the exact "huge losses" failure mode) — FIXED (branch `feat/issue1-digits-live`)
- **Report (operator):** before merging digits, apply the pool-fund algorithm — "all clients have a
  central control point of configurations… I had tested with the other algorithm, but made huge losses."
- **Evidence / risk analysis:** the first digits increment settled EVERY trade on the provably-fair
  uniform digit at factor 0.95 (5% edge), ignoring `pool_mode` entirely. That book is the exact shape
  that loses money in practice:
  * **Variance vs a thin edge:** even/odd at 1.9× and 5% edge swings wildly; on thin-volume days the
    house is underwater a large fraction of days (the same hole docs/25 §14 closed for rise/fall).
  * **Martingale extraction:** the built-in AUTO bot doubles on loss — against an uncapped fair book a
    lucky streak cashes the whole float; nothing bounded daily payouts.
  * **No central control:** daily pools, dynamic per-client distribution, `pool_mode`, and the
    `house_edge` dial governed rise/fall only; digits bypassed all of it.
- **Root cause:** digits were wired to the statistical engine only; the PoolController (docs/25 — the
  managed-book brain with the hard cash cap + RTP-budget ceiling that already protects rise/fall) was
  never consulted for contracts.
- **Resolution (exact algorithm, fixed-odds adaptation):**
  * `decidePoolOutcomeFixed` (shared) + `decideReserveFixed` (controller): the SAME brain — propensity
    with base p = targetRtp/m (edge invariant E[RTP] ≤ 1 − house_edge), pool cash fuse, per-player
    no-scoop share, hard ceiling `paid + reserved ≤ ⌊targetRtp × turnover⌋`, near-miss lever,
    reserve→commit/release atomicity, persisted `position_decision` — with one fixed-odds rule: a win
    pays exactly the contract return or the trade loses (no shrunk wins).
  * `game.ts` routes digits exactly like rise/fall: pool path for non-marketers in pool-mode brands;
    provably-fair statistical path for pool-off brands and marketers/demo. One open digit contract per
    (user, instrument). Displayed digit is decision-consistent (seeded from the decision) and the
    owner's settle-index tick is overridden to match (chart == result).
  * **Shared central budget:** digits + rise/fall reserve from the SAME `withdrawal_pool` row,
    turnover, and ledger per brand — so per-client pools, the dynamic all-client distribution
    (docs/25 §15), and `pool_mode`/`house_edge` govern both surfaces with zero extra configuration.
  * Recovery: pool-decided digit contracts recover from the stored decision (commit on win),
    statistical ones from the seed. Idempotent.
- **Operational note (caught by test):** the 15% no-scoop share must exceed the largest fixed payout
  or players can never win — size a client's daily pool ≥ ~7× the largest digit payout (docs/34).
- **Impact:** digit losses are now hard-capped by the same central pool that already protects
  rise/fall; realized digit RTP ≤ 1 − house_edge at every volume. Tests: full suite **804/804**
  (new: 7 fixed-odds brain invariants, 9 engine pool-digit scenarios incl. combined rise/fall+digits
  budget + crash recovery, 1 WS pool-mode e2e); `tsc -b` + web `tsc` clean.

---

## #18 — Deriv-style DIGIT contracts were unreachable AND mispriced (would return 0.5× a "win") — FIXED (branch `feat/issue1-digits-live`)
- **Report (Issue 1):** the Phase-2 Deriv-style digits bot was built bottom-up (shared math + DB
  `fn_open_contract` + engine methods + a full web screen) but **no client could place a real digit
  contract**, and the web screen self-labelled "Preview mode · no real-money movement yet".
- **Evidence:**
  * WS transport (`multiengine.ts`) handled only `auth`/`open_position`/`sell`/`ping` — **no
    `open_digit`/instrument messages**, so `game.ts.openDigitContract()` was dead code (only tests
    reached it). No REST contract endpoints either.
  * The web `DigitsTradeScreen` generated its OWN client-side GBM prices (`useInstrument`) and settled
    locally — decoupled from any server, so outcomes were neither authoritative nor provably fair.
  * **Latent money bug:** `settleDigitContract` priced payouts with `factor = 1 − houseEdge`. But
    `houseEdge = 0.75` (the rise/fall crash-game economics) ⇒ an even/odd **win** would return
    `round(stake × 0.25 / 0.5) = 0.5× stake` — i.e. "winning" LOST half the stake. Unplayable and
    grossly unfair had it ever been wired.
  * Digit outcomes derived from `lastDigit(curve.rate(t))` of the single shared curve — a smooth,
    green-biased `tanh` curve whose last pip is **not uniform**, so even/odd ≠ 0.5 (edge drift).
  * Open digit contracts lived only in an in-memory map — a restart between open and settle would
    **strand a debited stake** with no recovery.
- **Root cause:** the feature was intentionally "demo-first / unwired" (per commit messages and
  migration 0113's header) and never had a transport, an authoritative price source, a digit-specific
  payout knob, or crash recovery.
- **Resolution (server-authoritative, provably fair, per-instrument):**
  * **Per-instrument seeded feed** (`packages/shared/instrumentfeed.ts`): extends the daily-seed model
    to each Deriv Volatility Index (Vol 10–250, 1s/2s). The settling last digit is
    `HMAC(daySeed, "dg:<instrument>:<index>") mod 10` — **exactly uniform**, so the payout factor IS
    the edge with no distributional drift; the displayed quote's last pip equals that digit
    ("chart digit == settled digit"). Pure & recomputable ⇒ provably fair + trivially recoverable.
  * **Digit payout factor** (`config.ts` `digitPayoutFactor`, default **0.95 = 5% edge**), independent
    of the rise/fall `houseEdge`. Fixes the 0.5× bug; operators can set 0.976 to mirror Deriv's
    on-screen "95.2% payout".
  * **WS transport** (`multiengine.ts`): `subscribe_instrument` → authoritative `inst_history` +
    live `inst_tick`; `open_digit` → `digit_opened` + balance; a per-(site,instrument) streamer
    settles every due contract (`settleDueDigits`) and fans `digit_settled` to owners. Unknown
    instrument ids are rejected (no spoofing).
  * **Crash recovery** (`recovery.ts`): open `kind='digit'` positions re-settle deterministically from
    the committed `{instrument, settleIndex}` in `positions.contract`, idempotently (no double credit).
  * **Web** (`GameSocketProvider` + `DigitsTradeScreen`): the same single socket now streams the
    instrument feed and places REAL contracts; local simulation removed. UI unchanged (Deriv layout).
- **Impact:** digits are live end-to-end, server-authoritative, provably fair (uniform), correctly
  priced, and crash-safe. Tests: **full suite 787/787**; `tsc -b` + web `tsc` clean. New coverage:
  shared feed (determinism, exact uniformity Monte-Carlo, quote↔digit invariant, edge), engine digit
  contracts, WS e2e (subscribe→stream→open→settle), and crash recovery. Multipliers are the next
  increment (tick-loop TP/SL/stop-out) and remain preview for now.

---

## #17 — Two divergent "marketer" systems + no way to delete; a "player" (stanley) was silently a demo account — FIXED (migration 0110, branch `feat/delete-and-marketer-consolidation`)
- **Report:** stanley is a player, but his withdrawals took the demo/instant rail (no bot alert). Also
  two UIs "manage a marketer" (Users → upgrade-to-marketer role; Marketer-finance → add-marketer demo),
  and there was no button to delete a marketer/user/admin.
- **Root cause (two concepts, one name):** `role='marketer'` (affiliate, real 25% commission via
  `affiliates`/`commission_payouts`) is INDEPENDENT of the DEMO cohort, which is defined by
  `fn_is_marketer_account` = a phone match in the `marketers` table (per docs/29). stanley (`role=player`)
  had a `marketers` row on his phone, so the money layer treated him as demo. `fn_is_marketer_account`
  ignores the marketers row's status, so even a `disabled` marketers row keeps a person demo — only
  DELETING the row un-demos them. Data confirmed the drift: 28 demo rows = 20 linked + 8 phantom; of
  the linked, 10 are `role=marketer` and 10 are `role=player` (demo-only, like stanley); plus 4
  affiliate-only. No delete function existed anywhere.
- **FK reality:** `marketers` FKs all CASCADE (safe hard delete). `profiles` FKs are mostly NO ACTION
  (transactions/ledger/positions/referrals/commissions/audit) → a real user/admin CANNOT be hard-deleted
  without destroying the financial audit trail.
- **Resolution:**
  * **Delete demo marketer (hard):** `POST /admin/marketers/:id/delete` → `DELETE FROM marketers`
    (cascades wallet/ledger/withdrawals/credentials), brand-scoped. Removes demo status.
  * **Delete user/admin (soft):** migration 0110 adds status `'deleted'` + `fn_admin_delete_user`
    (no-self, superadmin-protected, admin-only-by-superadmin, default-marketer-locked, idempotent);
    sets `sessions_valid_after=now()`. `POST /admin/users/:id/delete`. Login now blocks `'deleted'`
    accounts (anti-enumeration); lists hide them; money layer already rejects non-active.
  * **Consolidation:** the Marketer & affiliate finance hub is the single place to add/remove a demo
    marketer (delete in the Manage modal) and cross-links to the linked website account for the
    affiliate role; the Users page keeps the role field + deep-links to the hub.
  * **stanley fixed in production:** deleted his `marketers` row → `fn_is_marketer_account` True→False;
    profile stays player/active, real+demo balances intact. He now withdraws on the real rail.
- **Impact:** the demo/real ambiguity is resolvable from the UI; deleting is safe (cascade) or
  history-preserving (soft). Tests: full suite 728/728; `tsc -b` + web `tsc` clean; migration 0110 +
  the stanley delete verified against the real schema.

---

## #16 — Real-money vs "funny money" were entangled on the approval channel + approvals had no password — FIXED (branch `feat/telegram-approvals-issue1`, migration 0109)
- **Report (Issue 1):** improve Telegram payout alerts (thorough content, bank-grade look, no emojis),
  organise them (waiting/approved/rejected), reduce Approve/Reject to immediate actions, and require the
  superadmin password to approve — in BOTH the dashboard and the Telegram bot.
- **Bug caught (money routing):** migration 0108 had gated the **demo/"funny money"** marketer game→wallet
  transfer (`fn_marketer_game_withdraw`, `transactions` provider=`internal`) behind admin approval and
  routed it to the alert channel. Evidence: the only two `pending` withdrawals in production were
  `provider='internal'` demo transfers ("stanley", a phone-matched demo account). Real player M-Pesa
  withdrawals already alerted; real marketer **commission** payouts (`commission_payouts`) did **not**
  alert at all. So the channel carried the wrong money: fake money was gated/notified, one real-money
  flow was silent.
- **Bug caught (no approval proof):** all four approve surfaces (dashboard, Telegram inline button,
  email magic-link, web-push) executed on role/allowlist alone — **no password**. Approving real M-Pesa
  payouts required no second factor.
- **Resolution:**
  * **Migration 0109** restores the pre-0108 **instant** `fn_marketer_game_withdraw` (demo money credits
    the marketer wallet immediately, `success`, never on the channel), leaves the shared
    `fn_approve_withdrawal`/`fn_reject_withdrawal` intact for the real M-Pesa rail, and **backfills** the
    internal rows 0108 left `pending`. Validated on the real schema inside a rolled-back transaction.
  * **Superadmin password gate** on Approve across **every** surface (`requireApprovalPassword` +
    `verifyApprovalPassword`, scrypt against an active `platform_superadmin`). Reject stays immediate.
    Telegram uses a stateless force-reply flow that deletes the password message after use.
  * **Marketer commission** payouts now alert (Telegram + email); bot Approve = approve **+ mark-paid**.
  * **Content**: enriched, emoji-free, bank-grade Telegram + email templates (amount, client, user type,
    destination, time, reference); status topics optional.
- **Impact:** real money (player withdrawals + marketer commission) is what needs approval and now
  carries a password; demo money is instant and off the channel. No double-spend risk (demo hold/credit
  is atomic). Full suite green (724/724); `tsc -b` + web `tsc` clean. See docs/33.
- **Deploy note:** apply migration 0109 **before** deploying the API (the code assumes instant demo).

---

## #14 — Marketer expenses/advances never reached the dashboard; didn't affect withdrawable — FIXED (migration 0105)
- **Report:** expenses/advances logged in admin ("Marketer expenses") weren't reflected on the
  marketer's dashboard, and the net (withdrawable) math looked wrong.
- **Root cause (two identity systems):** a marketer exists as BOTH a website affiliate (`profiles`,
  role='marketer' — where commissions, `/dashboard` and its Expenses/Net section live) AND a
  marketer-APP identity (`marketer_profiles`/`marketers` — the simulated M-Pesa wallet). Same
  phone/brand, **different ids**. Migration 0068 defines `marketer_expenses.marketer_user_id` as a
  `profiles.id`, and the only marketer-facing reader (`GET /affiliate/expenses`, `fn_commission_balance`)
  keys on `profiles.id`. But the marketer-finance **Expenses** tab listed `marketer_profiles` and logged
  with `marketer_profiles.id`, so every logged expense was stored under an id **no dashboard reads**.
- **Evidence (production):** all logged expense rows were keyed to `marketer_profiles.id` (e.g. KES 450
  "Commission Tests" under *Mohan Abdul* `7965afa2…`, whose website account is *Mohane* `0cb63be4…`).
  Coverage: 9 marketer-app accounts map to a website marketer, 17 don't (no ambiguous matches).
- **Operator decision:** ALL logged expenses reduce withdrawable (`Available = earned − held − paid −
  expenses`, floored at 0).
- **Resolution (branch `feat/marketer-expenses-affiliate-key`, migration 0105 + API + web):**
  * **0105:** (a) `fn_commission_balance` now subtracts total logged expenses from `available_cents`
    (floored at 0); since the payout RPC reads `available_cents`, payouts are auto-capped at the net —
    timing-safe, never double-counts. (b) Re-keys existing mis-keyed expense rows from
    `marketer_profiles.id` → the matching affiliate `profiles.id` (`fn_phone_sig9` + same site +
    role='marketer', oldest); app-only accounts with no website marketer are left untouched. Idempotent.
  * **API:** the marketers list (`marketers.pg.ts`) now resolves each marketer-app row's linked affiliate
    `profiles.id` (`affiliate_user_id`) so expenses can be keyed correctly.
  * **Web:** the marketer-finance **Expenses** tab logs/reads by `affiliate_user_id`; app accounts with no
    website marketer are disabled ("no website account"). The `/dashboard` needed **no** change — it now
    populates automatically and `Available to withdraw` is net of expenses.
- **Verification:** rolled-back live e2e (re-key correctness + netted balances: *Mohane* KES 50 earned −
  KES 450 expenses → available 0; a +KES 50 expense on *moha* drops available by exactly that; app-only
  advance left untouched); 0105 applied to production and re-checked live; ledger reconciled (105/105);
  backend+web typecheck clean; full suite 673/673.

## #13 — Banned marketer stayed a brand's earning default; no admin-panel way to reassign — FIXED (migration 0104)
- **Report (operator):** *Mohane* (the only ACTIVE marketer on **madolar**) was still not the brand
  default; the "Make brand default" control couldn't be found where marketers are actually managed.
- **Evidence (read-only, production):** madolar had `sites.owner_user_id = moha`, but **moha and Mohan
  were both `banned`** and *Mohane* was the lone `active` marketer — yet a **banned** marketer remained
  the brand default and kept accruing 25% of every deposit. The only assignment UI lived in the
  **Platform Console** (`/platform`, platform_superadmin), not the **Admin panel** (`/admin/users`)
  operators use; and nothing prevented a default marketer from being banned or stopped a banned user
  from being (or staying) the default.
- **Root causes:** (1) surface mismatch — the control was platform-only; (2) `fn_platform_set_site_owner`
  validated role + site but **not status**, so a banned/suspended marketer could be set/left as default;
  (3) `fn_admin_set_user_status` had **no guard** against banning/suspending the current default.
- **Immediate data fix:** reassigned madolar's default from banned *moha* → active *Mohane*
  (`fn_platform_set_site_owner`, audited). Future deposits now credit Mohane 25%. (Historical
  commissions already paid to *moha* were left as-is.)
- **Resolution (branch `feat/admin-default-marketer-guards`, migration 0104 + API + web):**
  * **0104:** (a) `fn_platform_set_site_owner` now rejects a non-active marketer (`OWNER_NOT_ACTIVE`);
    (b) new **site-scoped** `fn_admin_set_site_owner(actor, role, marketer, make_default)` lets a brand
    `admin`/`superadmin` set/clear THEIR OWN brand's default (site derived from the marketer;
    `SITE_SCOPE_FORBIDDEN` off-brand; active-marketer enforced); (c) `fn_admin_set_user_status` blocks
    banning/suspending the current default (`DEFAULT_MARKETER_LOCKED`) — reassign first (per operator
    choice: **block**). Reactivating is always allowed.
  * **API:** `POST /admin/marketers/:id/make-default` and `/clear-default` (admin-gated, brand-scope
    enforced), routed via `PlatformRepository.setDefaultMarketer`. `AdminUserDetail` gains
    `isBrandDefaultMarketer`.
  * **Web:** `/admin/users/:id` shows a **"Make brand default" / "Remove as default"** control for
    marketers with a ★ current-default badge — where operators already manage users.
- **Verification:** rolled-back live e2e (13 scenarios: every guard + valid set/clear) against the real
  schema; 0104 applied to production and re-checked live (ban-of-default → `DEFAULT_MARKETER_LOCKED`).
  Typecheck clean (backend + web); full suite 673/673 (added an admin route-wiring/gating test).

## #12 — "Mohane's earnings not populating" — NOT A BUG (by design); default-marketer assignment made a first-class button + docs corrected
- **Report:** marketer *Mohane*'s dashboard showed no earnings; suspected a regression of #11.
- **Investigation (read-only, production):** *Mohane* (`0cb63be4…`, role `marketer`, brand **madolar**
  `776fd02b…`) has **0** `deposit_commissions`, **0** balance (`fn_commission_balance`), **0** direct
  referrals (`profiles.referred_by = Mohane` is empty), **0** clicks on her code `HYJJJQW2`. The
  dashboard (`GET /me/referral` → `sum(deposit_commissions.commission_amount)`) is therefore faithfully
  reporting zero.
- **Why zero is correct:** madolar's **default marketer** is *moha* (`sites.owner_user_id = a765af32…`).
  Verified the live model works: **78/78** successful M-Pesa deposits (KES 25,286.00) each generated a
  commission to *moha* at rate `0.25`, totalling KES 6,321.50 = **exactly 25%** — even though **all 118
  madolar players have `referred_by = NULL`**. So "default marketer earns 25% of every deposit,
  regardless of referral link" is already implemented and correct (`fn_pay_referral_commissions`,
  0103, invoked by `fn_complete_deposit`). *Mohane* is a **non-default** sub-marketer with no attributed
  deposits, so she correctly earns nothing.
- **Operator decision:** keep the differential-split model (every deposit still totals 25%, default
  marketer always at the root — **Model B**, no commission-math change), AND make assigning a brand's
  default marketer a first-class action.
- **Root cause of the confusion:** stale docs — `README.md` still described a legacy "20% of GGR / net
  losses" affiliate model, contradicting the live 25%-of-deposits model.
- **Resolution (branch `feat/set-default-marketer`, UI + docs only — no schema/money-path change):**
  * `apps/web/.../platform/ClientDetail.tsx`: added a **"Make brand default"** button (and
    **"Remove as default"**) in the per-user management panel, plus a **★ default** badge in the user
    table. Gated on `role = 'marketer'` client-side (backend `fn_platform_set_site_owner` already
    enforces marketer-on-same-brand + `platform_superadmin`, audited). This fixes a real gap: the
    pre-existing top-of-list selector only listed marketers from the first 50 loaded rows, so a marketer
    deeper in the list could not be selected; the search-then-select button reaches **any** marketer.
  * Docs: `README.md` (both 20% references corrected to the 25%-of-deposits hierarchical model), `docs/09`
    §3 (added "a brand always credits its default marketer" clarification + how to assign the default
    marketer), and this entry.
- **Verification:** rolled-back live e2e of `fn_platform_set_site_owner` — NOT_AUTHORIZED /
  SITE_NOT_FOUND / OWNER_NOT_FOUND / OWNER_NOT_MARKETER / OWNER_WRONG_SITE all fire; valid set
  (Mohane→madolar default) and clear-to-NULL both succeed; transaction rolled back (production
  untouched). Web typecheck clean; platform+referral+affiliate suites green (16/16).

## #1 — Bonus subsystem was dormant in the live money RPCs — FIXED (issue 1 / migration 0094)
- **What:** `bonus_balance` was frozen platform-wide — it could never be staked, wagered, or converted.
- **Evidence:** Live `fn_open_position` (10-arg) and `fn_settle_position` only moved `real`/`demo`
  balances; the `bonuses` table was empty across all 9 brands.
- **Root cause:** the original 0037 bonus mechanics were dropped when the RPCs were rewritten for
  site-scoping (0047) and demo isolation (0084). Deposit-bonus *granting* was also removed at 0077/0078.
- **Impact:** any credit to `bonus_balance` would have been permanently unusable and non-withdrawable.
- **Resolution:** migration 0094 restores bonus-first staking, wagering accrual, and FIFO conversion in
  the site-scoped/demo-aware RPCs (additive; verified no-op for existing zero-bonus accounts). See docs/31.

## #2 — DepositForm advertised a deposit bonus the backend never grants — FIXED (issue 1)
- **What:** the deposit screen showed a live "+KES X bonus (50%/25%/15%)… credited instantly as bonus
  balance" preview, but `fn_complete_deposit` (0078) grants no deposit bonus.
- **Resolution (per direction "remove any deposit-bonus apart from the one we just implemented"):**
  removed the DepositForm preview + `bonusPctForDeposit` import; deleted the shared deposit-tier module
  (`packages/shared/src/bonus.ts`, its `./bonus` package export, the engagement re-export, and its
  tests); and dropped the orphaned `fn_deposit_bonus_pct` in migration 0094. The **only** bonus in the
  system is now the sign-up welcome bonus. (Legacy `bonus_config.tiers/wagering_x` columns are left
  inert.)

## #3 — Admin "day" finance report is timezone-fragile (fails 00:00–03:00 EAT) — FIXED (issue 1 / global-config)
- **What:** `app.admin.isolation.e2e.test.ts` → "finance reports (daily/day/users) are brand-scoped"
  fails: `day report: brand A only` expects 40000, gets 0.
- **Evidence:** Reproduced on a clean `main` (pre-existing; independent of issue 1). The test derives
  `today` via `Africa/Nairobi` (`toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })`) while the
  deposit rows are grouped by their stored (UTC) date. When the run happens in the window where the
  Nairobi calendar date is already ahead of UTC (00:00–03:00 EAT), the requested day and the stored day
  disagree and the report returns 0.
- **Impact:** the `/admin/reports/day` aggregation and/or the test are not timezone-consistent; the
  report can under-count near the UTC/EAT day boundary. Test is flaky by wall-clock (green during Nairobi
  daytime).
- **Refined root cause (this fix):** the *production* report (`PgAdminRepo.reportDay`, apps/engine/src/admin.ts)
  was already correct — it groups by `(created_at at time zone 'Africa/Nairobi')::date`. The defect was in
  the **in-memory test harness** helper `dayOfMs` (apps/engine/src/admin.ts:521), which used
  `toISOString().slice(0,10)` (UTC). The harness therefore bucketed cash facts under the UTC day while the
  test (and production) use the EAT day — diverging only in the 00:00–03:00 EAT window.
- **Resolution:** `dayOfMs` now returns the EAT calendar date
  (`toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })`), matching production SQL and the callers'
  EAT `today`. **No production financial-reporting behaviour changed** (only the harness), so the prior
  concern about touching a live report does not apply. Baseline test suite is now fully green (610/610),
  and the finance-isolation e2e is deterministic regardless of wall-clock.
- **Follow-on:** two `app.admin.test.ts` report tests computed their expected day in UTC
  (`toISOString().slice(0,10)`) and were the mirror of the isolation test (they only passed during
  Nairobi daytime). Aligned both to the EAT calendar date so ALL day-report tests now agree with the
  production EAT boundary and each other.

## #4 — Phone-only password reset is account takeover for admins/superadmins — FIXED (issue 2 / migration 0097)
- **What:** `POST /api/v1/auth/password/reset` sets a new password from phone + new password alone
  (no possession proof), gated only by `ALLOW_UNVERIFIED_PASSWORD_RESET`. For a privileged account
  (admin / superadmin / platform_superadmin) anyone who knows the phone number could seize the back
  office.
- **Evidence:** `AuthService.resetPassword` had no second factor for privileged roles; the only reset
  path is that public endpoint (no admin-panel reset exists). Production roles are player/marketer/
  admin/platform_superadmin — note there is NO literal `superadmin`, so the real top account is
  `platform_superadmin` and had to be included in the privileged set.
- **Impact:** full account takeover of any admin whose phone number is known. `ALLOW_UNVERIFIED_PASSWORD_RESET`
  IS set as a Fly secret on `invest254-api` (confirmed via `fly secrets list`; value hidden but presence
  implies enabled), so this was very likely LIVE-exploitable before the fix. (An earlier partial GraphQL
  secret listing wrongly suggested the flag was absent.)
- **Resolution (migration 0097 + code):** privileged resets now REQUIRE all three security-question
  answers to verify, independent of the flag, and fail CLOSED when answers are unset. Added
  `user_security_answers` (scrypt-hashed, RLS/service-role only) + `profiles.sessions_valid_after`
  force-logout epoch (privileged tokens issued before it are rejected). `/auth/me` exposes
  `securitySetupRequired`; the web shows a mandatory non-dismissible setup gate. See docs/32.
  ROLLOUT COMPLETED 2026-08-21: migration 0097 applied; API deployed to Fly invest254-api; web deployed
  via Cloudflare Pages (commit 26b630a); force-logout stamped for all 3 privileged accounts. Verified in
  prod: reset on a real admin phone returns 403 SECURITY_QUESTIONS_NOT_SET (fail-closed, no change).
  Full suite 610 pass / 0 fail.

## #5 — Demo/marketer classifier was NOT site-scoped → players bypassed the withdrawal pool — FIXED (migration 0100)
- **What:** `fn_is_marketer_account` (0084) matched a profile to the `marketers` cohort on **phone
  (significant-9) alone, across ALL brands** — no `site_id` filter. But 0076 made `marketers` per-site
  and docs/20 §7 defines marketer identity as per-site. So a real **player on brand B** whose phone
  collided with a marketer on brand A was classified demo/marketer on brand B.
- **Symptoms (reported):** "global pool fund not applying to some clients (e.g. 33traders)" and "players
  using game config meant for marketers instead of the pool fund."
- **Mechanism (confirmed end-to-end):** engine `loadIsMarketer` → `fn_is_marketer_account` → wrongly
  true → `poolPath = poolActive && !isMarketer` = false → the player **skips the withdrawal pool and
  settles on the statistical ("marketer") path**, and the money layer (0086) routes them to the demo
  bucket. Not a mirror/template or deployment issue — the defect is in applied SQL affecting every brand;
  33traders is a normal row in the primary DB and pools correctly once classification is right.
- **Evidence (live):** 13 `role=player` accounts flagged as marketer; 5 were pure cross-site
  contamination (no marketer on their own site): 33traders/boyz, 66investors/Mercy, tamutraders/boyz,
  madolar/jake, invest254/grace254_waithera. The predicate also drives finance/RTP exclusion + money
  routing, so it mis-bucketed money too.
- **Fix (0100):** a user is demo/marketer IFF a `marketers` row exists **on the user's own site**
  (significant-9 match) **OR** the profile is `role='marketer'` (safety: never un-demo an enrolled
  marketer — 0084 warns that would turn funny-money into withdrawable cash). Rolled-back validation:
  player-flagged 13→8 (the 5 cross-site players become real pool players; all had 0 balance / 0 trades),
  marketer-flagged 10→12 (ALL enrolled marketers stay demo; moha KES 3,152 and jake KES 3,005 demo
  balances preserved). Additive, idempotent, reversible, money-neutral.
- **Follow-up (data hygiene) — DONE:** `madolar/moha` and `safitraders/jake` were `role=marketer` with
  live demo balances but had **no `marketers` row on their own brand** — an artifact of 0076 backfilling
  every pre-existing marketer to the default site (invest254). Enrolled them properly on their own brand
  via `fn_marketer_create` (active row + `marketer_wallets`), leaving the invest254 rows untouched;
  audited as `marketer.enroll.backfill` in `admin_actions`. Their classification now resolves via the
  site-scoped same-site match (not just the `role='marketer'` safety clause). NOTE: no marketer-dashboard
  PIN was set for the new brand identities — set one via the marketer admin if they need to log in there.
## #6 — Pool RTP tracked pool-size, not house_edge (Bug 1) — FIXED (pool RTP redesign, docs/25 §14)
- **What:** the pool controller paced payouts against `pool_amount × elapsed_day_fraction`, so realized
  player RTP tracked how big the daily pool was relative to turnover — not the operator's `house_edge`.
- **Evidence:** `sessionWinProbability` pace term was `(amount·dayFraction − paid)/amount`. With a pool
  large relative to turnover, `paid` sits far behind pace every trade, pinning win-prob at `pCap`. With
  the pre-redesign defaults (`pCap 0.6`, `meanMultiplier 1.8`) that yields `E[RTP] = 0.6·1.8 = 108%`.
  Simulation of the real decision fn confirmed RTP saturating well above the intended `1 − house_edge`.
- **Impact:** RTP was effectively set by pool sizing, not the configured edge; on generously-sized pools
  the house could pay ~100%+ RTP.
- **Resolution:** pace realized RTP toward `targetRtp × cumulative_turnover` (player-only, per site-day);
  the pool `available()` becomes only the hard cash fuse. Net: `realized RTP = min(targetRtp,
  pool/turnover)`. Turnover is tracked in-memory + DB-seeded (no migration).

## #7 — No structural positive-edge guarantee; low-volume days ran underwater (Bug 2) — FIXED (docs/25 §14)
- **What:** nothing guaranteed cumulative payout stayed below turnover. A fixed probability cap bounds
  only the *expected* per-trade edge, not realized aggregate RTP.
- **Evidence:** driving the real engine over 400 simulated days at 8 trades/day (strict `pCap = base`,
  no ceiling) ended **above 100% RTP on 116/400 days** (house net loss), max day 177%; even high-volume
  days spiked intraday RTP to 124–135%.
- **Impact:** on thin/low-volume brand-days, the house could and did (in simulation) lose money.
- **Resolution:** a HARD RTP-budget ceiling in `decidePoolOutcome` — `paid + reserved ≤ ⌊targetRtp ×
  turnover⌋` at all times (subtracting reserved makes it concurrency-safe across in-flight positions).
  Guarantees realized RTP ≤ target at **every** volume; simulation: 0/400 days over target, `maxIntraday
  = target` exactly. The pool `available()` remains the absolute cash fuse.

## #8 — Pool and statistical engines disagreed on win frequency (Bug 3) — FIXED (docs/25 §14)
- **What:** the pool used hardcoded knobs (`targetSessionRtp 0.6`, `meanMultiplier 1.8`) disconnected from
  each brand's `site_game_config`, so pool win frequency (base `0.6/1.8 = 0.33`) did not match the
  statistical engine's `targetWinRate` (default `0.125`). A player's win cadence changed with pool mode.
- **Resolution:** derive the pool's `meanMultiplier = targetRtp / targetWinRate` (the same `rtp/winRate`
  the `SettlementEngine` calibrates to), so pool base win-prob = `targetWinRate`. Both engines now share
  `targetWinRate` and both deliver RTP = `1 − house_edge`. `game.ts` threads `cfg.targetWinRate` into the
  controller; an infeasible config falls back to the default multiplier (defence-in-depth).

## #9 — Marketer/demo funny-money polluted real analytics (raw-table queries) — FIXED (migration 0101)
- **What:** money-bearing rows (positions/ledger/transactions/wallets) for the marketer/demo cohort
  live in the same tables as real players. Reports that used the cohort exclusion were correct, but any
  query that omitted it mixed demo funny-money into real figures — e.g. a raw `sum(positions.stake)`
  read ~KES 9.75M of demo turnover as real, producing a wildly wrong demand/RTP interpretation.
- **Evidence:** `positions` held 8,391 rows but the dashboard (which excludes `marketer_account_ids`)
  counted 2,128 real bets; the excess 6,263 were marketer demo bets (incl. a KES 4.7M single-day burst).
- **Root cause:** no enforced "real data" surface — cohort exclusion was applied per-query, so it could
  be forgotten.
- **Resolution (0101):** canonical `v_real_*` / `v_demo_*` views over the live classifier
  (`marketer_account_ids`), correct-by-construction and drift-free; `fn_demo_isolation_report()` proves
  0 leakage; `fn_platform_overview` rewired onto the views (identical output). Data hygiene: the
  6,263 marketer demo positions + 12,087 demo ledger rows + 426 demo transactions were removed and the
  demo wallets reset (real player data provably untouched); a bug-inflated madolar test account was
  deleted; and seeded pool caps were zeroed. See docs/27.

## #10 — Marketer app login rejected valid phone formats (false NOT_MARKETER) — FIXED (issue: marketer app login)
- **What:** the generic marketer app (mpesa/truecaller builds) showed "This account isn't registered
  as a marketer" (403 NOT_MARKETER) and the transaction feed/notifications never loaded, for a
  marketer whose website password and ledger were valid — whenever she typed her phone in any format
  other than the exact stored string (e.g. `+254706597235`, `254706597235`, `706597235`,
  `0706 597 235` vs stored `0706597235`).
- **Evidence:** read-only production comparison on the affected number (sig9 `706597235`, default
  brand): the old exact-match query found the row only for the stored format (1/6 formats); the
  sig9-match query finds it for all 6. Both marketer apps send the phone exactly as typed
  (no client-side normalization).
- **Root cause:** `profileByPhone` in `apps/api/src/marketers.pg.ts` matched `phone = $1` on the raw,
  un-normalized request string, while `auth.login` normalizes via `normalizeMsisdn` — so the password
  check succeeded but the marketer-wallet lookup missed. It was the one marketer lookup never migrated
  to the canonical significant-9-digits rule (`fn_phone_sig9`, migrations 0084/0086/0100, docs/29).
  The route tests passed because the in-memory double in `testutil.ts` replicated the same exact-match
  flaw and the fixtures never varied the phone format.
- **Impact:** any marketer typing their number in a non-stored format was locked out of the app with a
  misleading "not a marketer" error; downstream, the app's poll worker no-ops without a session, so
  M-Pesa-style transaction notifications silently stopped.
- **Resolution:** `profileByPhone` now matches on
  `fn_phone_sig9(phone) = fn_phone_sig9($1)` (with the `length(...) = 9` guard, site-scoped,
  deterministic `ORDER BY created_at ASC LIMIT 1`) — the same predicate as every other marketer
  lookup. The in-memory double keys phones by sig9 to stay faithful. New regression test
  ("login-web accepts the phone in any valid format") covers 6 format variants end to end.
  Full suite green (672/672); typecheck clean. No schema or write-path changes.

## #11 — Non–site-owner marketers earned no commission; some brands had no default marketer — FIXED (migration 0103)
- **What:** marketer dashboards showed no commissions for many marketers (e.g. *joy*, *Mohane*).
- **Evidence (read-only, production):** of 807 profiles only 4 had `referred_by` set; commissions
  flowed **only** to site owners via the `sites.owner_user_id` fallback. 4 brands had **no** default
  marketer (`owner_user_id IS NULL`): invest254, muchwins, tamutraders, 66investors — so every
  deposit on those brands paid **0%**. Verified *moha* (madolar owner) already earned exactly 25%.
- **Root cause:** (1) 4 brands were never assigned a default marketer, so their deposits paid no
  commission; (2) `fn_pay_referral_commissions` (0081) only rooted at the default marketer for
  **unreferred** deposits — a sub-marketer referral could take the whole 25% and leave the default
  marketer with nothing, so the hierarchy wasn't guaranteed.
- **Model (confirmed with operator):** each brand has ONE **default marketer**; **every deposit pays
  25%** into the brand's **hierarchical** marketer tree, always rooted at the default marketer.
- **Resolution (0103):**
  * `fn_pay_referral_commissions` now **always roots the 25% differential chain at the brand's
    default marketer** — full 25% when unreferred; differential split (recruiter bulk + upline
    overrides, default marketer at root) when a sub-marketer referred the depositor. Totals always
    sum to exactly 25%. Self-pay blocked; idempotent via `(deposit_tx_id, beneficiary_user)`.
  * Default marketers assigned: **invest254 → joy**, **muchwins → sheila** (single-marketer brands
    auto-assigned generically). **tamutraders** — the lone marketer (a duplicate *joy*) was demoted
    to player per operator instruction; brand left with no default. **66investors** — no marketer
    exists; skipped.
  * Docs 09 §3 and 19 updated to the 25%-of-deposits hierarchical model.
- **Verification:** rolled-back e2e against the live schema — unreferred→owner 25%; sub-marketer
  referral→recruiter 20% + default 5%; owner self-deposit→no pay; sub-marketer self-deposit→default
  25%; idempotent re-run→0 new rows; all marketer totals == 25%. Referral + affiliate TS suites green.


## #12 — Post-outage pool starvation: every brand paid 100% losses — FIXED (anti-starvation floor, docs/25 §15.6)
- **What:** starting the day trading resumed after the Aug 26–Sep 10 paybill outage, **every** pool-mode
  brand paid **0 wins** — players lost 100% of trades. invest254's daily withdrawal pool had fallen to
  **KES 47.49** (4,749 cents), far below a single 250-KES minimum stake.
- **Evidence (read-only, production):**
  * `position_decision ⨝ positions` by EAT day: invest254 win rates were healthy before the outage
    (Aug 24–27: 66–77%, large payouts) then **0 wins** on Sep 10–11 (10 decisions). Same 0-win pattern
    on madolar (32 dec), muchwins (45 dec, all `digit`), 33traders, safitraders.
  * `withdrawal_pool` for invest254 collapsed 8.25M (Aug 25) → 3.2M (Sep 1–9) → **34,173 (Sep 10) →
    4,749 (Sep 11)** cents. `sites.default_daily_pool_cents` history mirrored it.
  * Reproduced the demand allocator exactly (muchwins/safitraders/33traders matched to the cent):
    invest254's EMA forecast had decayed to ~85k cents (from millions), and the per-brand cap
    `2.5 × required` meant **even a KES 10M envelope would fund invest254 only ~KES 2,023**.
  * Player **@bill** (invest254): on the funded day Aug 27 he had 45 trades, **35 wins (77.8%)** yet
    RTP **0.870** — confirming the edge invariant works when the pool is funded (players win, house
    still edges out); the failure was funding, not the edge.
- **Root cause:** the demand-based pool allocator (docs/25 §15) forecasts demand with a **reactive EMA**
  over recent daily pool turnover. The ~2-week payment outage drove turnover to ~0, decaying the EMA →
  `required = targetRtp × forecast → 0`, which (via the `capMult × required` cap and the cap-clamped
  §15.2 floor) starved each brand's `default_daily_pool_cents` to ~zero. In the controller, **every
  payout gate scales with the pool `amount`** — the cash fuse `available = amount − paid − reserved`
  and the per-player no-scoop share `playerShare × amount` — so a starved amount forces every decided
  win to clamp to a loss (`reserved ≤ stake → loss`, and for fixed-odds `digit` contracts `payout >
  playerShare × amount → loss`). A self-reinforcing death spiral: starved pool → 100% loss → players
  leave → turnover stays 0 → forecast stays 0.
- **Resolution:**
  * **Immediate (production, audited RPCs, never-reduce `max(current, floor)`):** re-funded today's
    `withdrawal_pool.amount` and `default_daily_pool_cents` for all 7 active-with-demand brands to
    `round(targetRtp × robust expected daily turnover)` — invest254 → **KES 70,130**, muchwins → KES
    44,752 (default kept at its higher 61,144), madolar → 19,755, 33traders → 12,307, safitraders →
    950, tamutraders → 1,306, cpfmarket → 238. Verified the structural clamp is gone (avail ≫ any win,
    `playerShare×amount` ≫ payouts).
  * **Code (branch `fix/pool-allocation-floor`):** added a guaranteed anti-starvation floor decoupled
    from the reactive forecast — `floor_i = max(configuredFloorCents, targetRtp × expectedTurnover_i)`,
    `expectedTurnover = max(EMA, robustExpectedTurnover(baseline))`, where `robustExpectedTurnover =
    max(p75(non-zero days), mean(last 7 non-zero days))`. Allocated before the water-fill, rationed only
    if `Σ floors > envelope` (`Σ alloc ≤ G` preserved). Floors gate on demonstrated demand, so
    never-active brands stay 0. Safe by construction: pool `amount` is only a ceiling — the controller's
    `paid + reserved ≤ ⌊targetRtp × turnover⌋` cap still bounds payout to `targetRtp × turnover`, so the
    edge invariant (RTP ≤ 1 − house_edge) is unchanged. `PlatformService.poolDemand` feeds the robust
    baseline over `baselineDays` (default 45) + `POOL_MIN_FLOOR_CENTS`; daily script surfaces the floor.
- **Verification:** shared pool suites green (40/40, incl. 7 new incident-scenario tests: outage-collapse,
  huge-envelope-no-longer-clamps, Σfloor>G rationing, floor-is-a-minimum, configured-floor gating,
  back-compat byte-for-byte no-op); engine pool/controller/game suites green (35/35); engine typecheck
  clean. **Live read-only dry-run** of the new allocator over production history: invest254 forecast
  still KES 851.8 but floor lifts suggested to **KES 70,130** (was KES 835 under the old allocator);
  muchwins floored at 44,752 then demand-topped to 61,144; dead brands 0; Σ ≤ envelope.
- **Operational follow-ups:** (1) redeploy engine/api so the console `distribute-dynamic` uses the floor
  (the scheduled §15.5 workflow picks it up on merge to main); (2) until deployed, do NOT run a manual
  dynamic distribution on the old deployed code — it would re-starve. Revisit #43 next.

## #12b — Defense-in-depth so pool starvation can never silently re-occur (docs/25 §15.7)
Follow-up to #12. The §15.6 allocation floor removes the *cause*; these three independent layers
guarantee a silent recurrence (from that cause or any other) is effectively impossible:
- **(A) Absolute allocation floor** — `POOL_MIN_FLOOR_CENTS` (repo var) → `configuredFloorCents`, wired
  into `pool-distribute.yml`. A hard global minimum for cases the robust baseline can't cover (outage
  longer than `baselineDays`, brand-new brands). Operator dial; default off.
- **(B) DB safety valve — ALWAYS ON (migration 0119, applied to prod).** `fn_pool_ensure_day` now seeds
  a pool-mode brand's day at `greatest(default_daily_pool_cents, ⌈min_stake × max_multiplier ÷ 0.15⌉)`,
  so a zero/mis-set/starved default can never again force 100% losses — independent of any allocator
  run. Money-safe (amount is only a ceiling; controller still caps payout at ⌊targetRtp × turnover⌋).
  Verified live (rolled-back tx): safitraders default 95k → seed 833,334; invest254 default 7.01M wins.
- **(C) Active monitor — closes the detection gap.** `scripts/pool_health_monitor.py` +
  `.github/workflows/pool-health.yml` (every 30 min). Unlike `winrate_monitor.py` (needs ≥50 samples —
  and starvation suppresses volume, so it stayed silent during #12), this watches the STRUCTURAL signal
  over a rolling 2h window (`POOL_STARVED`: available < one min stake with live trades; `ALL_LOSS`: ≥8
  live trades, 0 wins; `BELOW_VIABLE` warning) and pages Telegram. Verified against live prod: after the
  #12 re-fund it reports ✅ healthy and shows invest254 already paying wins again (1 win / 2 recent
  trades; avail 7,012,995 → 6,987,681).
- **APIs redeployed** (fly.io `invest254-engine-pm` + `invest254-api`, remote build from merged main) so
  the console `distribute-dynamic` path also uses the §15.6 floor; API health 200, engine WS up.

## #15 — Deriv/digits ~80% player losses: near-miss fired even for above-line players — FIXED (docs/25 §16)
- **What:** the deriv (digits) game paid ~7–20% wins (≈80–93% losses) — far below the ~50% an even/odd
  contract should pay (RTP 0.95 ⇒ ~50/50). Reported as "deriv bot making 80% losses".
- **Evidence (read-only prod + deterministic replay):** muchwins digits last 24h = 5 wins / 67 (7.5%).
  Replaying the 29 most-recent decisions from their stored `seed+nonce`: mean propensity roll 0.529
  (RNG **fair**), propensity losses 15/29 (52% ≈ fair 50/50), and **14/29 were would-be WINS** (roll < p)
  — of which the near-miss voided 12, cutting the win rate from ~48% to ~7%. Not RNG, not the pool
  (funded), not propensity: the near-miss lever.
- **Root cause:** the min-withdrawal near-miss (docs/25 goal-gradient) fired whenever
  `bal + payout ≥ W`, **regardless of whether the player was already at/above the withdrawal line**. So
  any player/bot trading with a funded balance ≥ W had ~85% of wins voided (fixed-odds digits) or held
  (rise/fall) — a blanket win-suppression instead of the intended "hold a player JUST BELOW the line as
  they approach it". Worsened by the pre-§16 line being the low legacy KES value (KES 2,000 ≈ $15), which
  nearly every funded player exceeded.
- **Fix:** the near-miss now engages ONLY on the crossing trade — `bal < W && bal + payout ≥ W` — in BOTH
  engines (`decidePoolOutcome` variable / curve+candlestick, and `decidePoolOutcomeFixed` fixed / deriv).
  A player already at/above the line wins normally and can withdraw (real withdrawals = social proof, as
  intended). Combined with §16's currency-native line ($200 for USD), the lever now engages only in the
  genuine goal-gradient band. The house edge is untouched (the RTP-budget cap `paid+reserved ≤ ⌊target×
  turnover⌋` still bounds payout).
- **Verification:** `pool.test.ts` — "near-miss fires ONLY on the crossing trade; above-line players win
  normally" (asserts above-line near-miss count == 0 and ~base win rate for BOTH engines; crossing still
  triggers; far-below unaffected). Existing crossing/far-below near-miss tests still pass. 17/17 pool,
  30/30 engine pool/game, engine+api typecheck clean.
