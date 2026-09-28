# 51 — DEMO-3: the Real/Demo switch, and why the Demo account has no way out

**Status:** UI landed. The database (`0123`, `0169`) and API halves already existed; this closes the
two gaps that made them invisible or contradicted them on screen.

## 1. What was already true

The money model has been correct since migration `0123` and hardened by `0169`:

| Layer | Guard |
|---|---|
| DB | `fn_create_withdrawal` reads `account_mode` **under the wallet's `FOR UPDATE` lock** and raises `DEMO_ACCOUNT` — a switch to demo cannot race past it |
| DB | `fn_account_is_demo` routes every stake/payout to `wallets.demo_balance`; `positions.demo` is stamped **at open**, so settlement can never pay a demo trade into real |
| API | `POST /withdrawals` refuses with 409 `DEMO_ACCOUNT` before any money path runs |

Demo funds have never been withdrawable, and never converted to real.

## 2. The two gaps this fixes

### Gap A — the UI still offered the way out

Every withdrawal entry point rendered unconditionally while in demo mode: the account popover's
**Withdraw** button, the top bar's **Withdraw** nav item and drawer entry, the profile menu's
**Withdraw**, the `/wallet` page button, and the wallet sheet's **Withdraw** tab. Tapping the balance
opened the Withdraw tab *by design*.

Clicking any of them reached a screen showing the real balance behind a **"Switch to Real"** button —
so cashing out read as one tap away from play money. That is the impression a demo account must never
give, whatever the server does afterwards.

Worse, `/wallet` labelled the row **"Withdrawable (real cash)"** against `wallet.real`, which is the
**demo** balance in demo mode. The page told a demo player their play money was cashable.

### Gap B — 13 of 15 brands could not reach the Demo account at all

The switcher only ever shipped on the `digits` trade surface (`DigitsAccount.tsx`). Production runs
`trade_ui = 'classic'` on **13 of 15 brands** (`invest254`, `madolar`, `33traders`, … ) and `digits`
on 2 (`mpesapap`, `muchwins`). On the classic shell `TopBar` rendered a plain `BalancePill` with no
account control — so the mode existed in the database and the API, and a player simply had no way to
switch into it. Production bears this out: **1 wallet in demo out of 2,886**.

## 3. The model now — one gate, asked everywhere

`walletFigures().canWithdraw` is the single question every surface asks before rendering **any** way
out — button, tab, menu item or tap target:

```
canWithdraw = wallet is known  AND  not (demo and not marketer)
```

- **False while the wallet is unknown.** Which account is active decides whether money can leave, so
  nothing is offered before the answer is in. A Withdraw button that appears and then vanishes is
  itself the hint this removes.
- **True for a demo-locked marketer.** Marketers are demo by design and their payout *is* the
  demo→M-Pesa transfer, so their behaviour is unchanged.
- **Absent, never disabled.** A greyed-out Withdraw still says "this could work" — so in demo mode the
  control is not rendered at all, and the wallet sheet drops its whole tab strip (Deposit is the only
  action left). `WithdrawForm` returns `null` rather than a "Switch to Real" screen, and `WalletModal`
  coerces a stale `withdraw` intent to Deposit, so no deep link or in-flight mode change can land on
  a withdrawal surface.

Deposit stays available in demo — it funds the **Real** account, which is the point.

Surfaces gated: `DigitsAccount` (popover), `DigitsTopBar` (desktop nav + drawer), `ProfileMenu`,
`AccountSwitcher`, `/wallet`, `WalletModal`, `WithdrawForm`, `WalletWidget`.

## 4. The classic shell gets the switcher

`components/wallet/AccountSwitcher.tsx` replaces `BalancePill` in `TopBar`: the active account's badge
(R/D), its balance, and a popover with Real and Demo rows, their balances, "Refresh demo balance" (in
demo), and the money actions under the same `canWithdraw` gate. It keeps `id="balance-pill"` so the
payout/welcome-bonus "money flying into balance" animations still find it.

`BalancePill.tsx` is deleted — its behaviour (tap → Withdraw) is precisely what this change removes,
and leaving it in the tree invites it back.

Switching is refused by the server while a contract is open (`OPEN_POSITIONS`); the classic shell
surfaces that error rather than pre-empting it, because the open-trade stores are specific to each
trade surface.

## 5. Tests

`apps/web/src/lib/wallet/figures.test.ts` — 11 cases pinning `canWithdraw` across real, demo (at every
balance including zero and a full demo bankroll), demo-locked marketer, a pre-`0123` wallet with no
`mode` field, and an unknown wallet; plus the cross-check that `withdrawable` is 0 whenever no
withdrawal may be offered, and is never the demo balance.

The server halves stay covered by `app.demo1.test.ts` ("a player in demo mode cannot withdraw; a
demo-locked marketer still can") and the `0169` lock-held check.


## 7. Marketers are a THIRD kind of account, not a locked player (DEMO-4)

A marketer is not "a player who cannot reach Real". They are a separate account type:

- their game money is `wallets.demo_balance` — **never** real (`0084`, docs/27);
- `fn_create_withdrawal` refuses them outright (`MARKETER_NO_REAL_WITHDRAWAL`);
- they **can** withdraw — via the instant game→marketer-wallet transfer, and their earnings live in
  `marketer_wallets` / the marketer app at `/dashboard`.

So the account panel must not offer them a Real account at all — not even greyed out, which
misdescribes what they have. They get their balance and their actions, and no switcher.

### The client was the last layer trusting the JWT role claim

`requireMarketer` resolves the marketer from the **database** — "the DB is the source of truth for
access (NOT the JWT role claim)". `MarketerHUD` and `/dashboard` still gated on `user.role`, so a
marketer whose profile reads `player` was locked out of their own app. Three accounts on `madolar`
are exactly that: `role='player'`, a `marketers` row on their brand, a funded `marketer_wallets`
balance (KES 13,700 / 30,000 / 8,000) and `demo_balance = real_balance = 0`.

`useIsMarketer()` now gates the client on `wallet.modeLocked` — the server's own
`fn_is_marketer_account`, the same predicate that routes their stakes to the demo bucket. It is a
ROUTING hint only: every marketer endpoint is still gated by `requireMarketer`, so a false positive
lands on a page whose calls 403.

### Covert by design

The dashboard entry is an invisible hotspot so that "NO visible button a watching player could
notice". The panel therefore names **no account type** — not "Marketer", not "Demo". A marketer shows
their phone to players as social proof; printing what the account is would defeat the entire surface.
It shows `Balance` and the figure, nothing more.

> **Still leaking, NOT changed here:** the top-bar pill itself reads `DEMO` for a marketer, because
> `mode === 'demo'` is true for them. That predates this work and changing it alters what every
> marketer sees on the trade screen, so it is raised rather than silently altered.
