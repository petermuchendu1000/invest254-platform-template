# 29 — Marketer: one source of truth (unification) + funding sync

> **Status: DONE.** Every DEMO/money path now resolves "is this a demo/marketer account?" through the
> ONE canonical predicate `fn_is_marketer_account` (migration 0084), and admin funding of a marketer
> lands in the non-withdrawable demo bucket. Frontend is in sync (see §3).

## 1. The single source of truth
`fn_is_marketer_account(user_id)` (0084) — a profile whose phone matches a `marketers` row on the
**significant 9 digits** (covers +254 / 254 / 0 / bare-7 forms). Everything consumes it:
- **Pool exemption (engine):** `GameServer.loadIsMarketer` → `fn_is_marketer_account` (server.ts).
- **Money routing:** `fn_open_position` / `fn_settle_position` / `fn_create_withdrawal` (0084).
- **Finance / RTP exclusion:** the `marketer_account_ids` view is re-pointed at the predicate (0084).
- **Internal game→wallet transfer:** `fn_marketer_game_withdraw` now matches the marketers row with the
  SAME 9-digit rule (0086) — previously a `^254`-only match could strand a bare/`+254` marketer
  (game-withdraw said "not marketer", then `fn_create_withdrawal` blocked it).
- **Admin funding/cleanup:** `fn_admin_adjust_balance_kind` and `fn_admin_clear_balance` (0086) route a
  marketer's `'real'` op to the demo bucket, so funding a demo account actually lands where they play.

`role='marketer'` is intentionally NOT used as the demo/money cohort — it is a *separate* concept (an
affiliate/promoted role; 0070 states the cohort is role-independent). The admin "marketers" COUNT stats
(`role='marketer'`) are left as-is; they are not a money/finance signal.

## 2. Why this matters
Before, four different notions of "marketer" existed (JWT role, phone-match in the view, phone-match in
game-withdraw, and implicit real_balance). Divergence could: reserve real pool budget for a demo win;
strand a withdrawal; or fund a marketer into a bucket they can't play. One predicate removes all of that.

## 3. Frontend sync (decision F)
- **Player UI:** already correct with zero UI changes — the WS `balance` frame's `real` comes from
  `getBalance`, which returns the demo bucket for marketers, so a marketer sees/stakes/withdraws their
  demo balance as their one spendable balance. There is no "bucket selection" because the account type
  deterministically picks the bucket server-side.
- **Admin UI:** the user-detail API now returns `demoBalanceCents` + `isMarketer`, and the admin page
  shows the demo balance + a "demo/social-proof, non-withdrawable" banner instead of a misleading
  "Real balance: 0". Admin funding (adjust) auto-routes a marketer's real credit to demo.

## 4. Tests
- `test_marketer_unification.py` (real Postgres, isolated schema, rolled back): 13/13 — bare-form
  marketer recognised by game-withdraw; adjust routes marketer real→demo (ledger kind demo); player
  unaffected; bonus unchanged; over-debit rejected; clear zeroes the spendable bucket.
- `test_demo_isolation.py` 41/41, `test_economy_integrity.py` 13/13 (prior migrations).
- Full TS suite 557/557; `tsc -b` + web `tsc` clean.
