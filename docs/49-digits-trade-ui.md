# 49 — Digits trade screen (mock parity)

The owner supplied desktop and phone mocks for the digits (Deriv-style) trade screen. This change rebuilds the web UI to those layouts, in each brand's own name and colours. The engine and the API are unchanged. Payouts and percentages are the engine's real figures (factor 0.95), not the mock's sample numbers.

## Layout

| Area | Desktop (≥1024px) | Phone |
|---|---|---|
| Top bar | Wordmark (two-tone), Trader's Hub, Deposit, Withdraw, History, AI, How to Trade; balance pill, Deposit, notifications, account menu | Menu, wordmark, balance pill ("Auto · SIDE" while Auto runs), Deposit, notifications |
| Positions | Left rail: Open / Closed / History tabs and session totals; can be closed and reopened | Sheet from the bottom nav |
| Chart | Tools (line, area, draw line, download), zoom (in, show all, out, back to live), timeframe, instrument, share badge | Same chart; tools hidden |
| Digit row | Ten circles with share %; latest digit solid; highest share has a green arc, lowest a red arc | Same, with an amber pointer under the latest |
| Console | Trading mode, balance, Auto/Manual, market pills, Select digit, Stake/Payout, stepper, presets, payout readout, Auto settings, stacked buy cards | Market tabs above the chart; side-by-side buy cards; Stake ⇄ Payout switch in the stepper caption |
| Bottom nav | — | Live Chat (with unread badge), AI, Positions |

## What each control is backed by

- **Balance pill:** the wallet. It shows the active account's balance. The chevron opens the Real/Demo switcher (docs/50).
- **History:** the wallet ledger (`GET /wallet/ledger`). Each trade line is labelled from the matching saved digit contract.
- **Account menu:** Profile, Change password (`POST /auth/password/change`), Two-Factor Auth, Verify Identity, Referrals, Live Chat, WhatsApp Care (when the brand sets a number), support email, and Sign out. See docs/50.
- **Notifications:** the player's brand notices (`GET /notifications`), which can be dismissed.
- **Session (Open / Closed, P/L, W/L):** the screen's own record of `digit_settled` events this session, shared with the shell through `useDigitSession`.

## Tests
`apps/web/e2e/digits.e2e.mjs` runs against a real local stack (API, engine and web; the brand needs `trade_ui='digits'`). It has 34 checks covering both layouts, a real trade from open to settle, the history modal, the account menu, Auto start/stop and the phone layout rules.
