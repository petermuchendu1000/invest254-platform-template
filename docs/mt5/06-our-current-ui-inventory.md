# Inventory of the existing player-facing UI — `/home/user/invest254/apps/web`

Read-only survey. No files modified. Everything below was read, not inferred from filenames.

**Three distinct player shells exist today.** Which one a player sees is decided per *brand* (DB `sites` row), not per user — see §5. Keep this in mind throughout: a large part of the codebase is the "classic" (wave/curve) shell and a third, entirely separate "digits" (Deriv clone) shell. Only the "terminal" shell is MT5-shaped.

---

## 1. Routes / pages a PLAYER can reach

All under `/home/user/invest254/apps/web/src/app`. Root layout is `app/layout.tsx` (edge runtime, per-host brand SSR, injects `BrandProvider → Providers → AppShell`).

| File | URL | What it shows |
|---|---|---|
| `app/page.tsx` | `/` | The trade screen. Wraps `GameSocketProvider` + `<TradeSurface/>`, which picks one of three layouts (classic curve / MT5 terminal / digits). |
| `app/wallet/page.tsx` | `/wallet` | Classic: `<h1>Wallet</h1>`, `WalletWidget`, Deposit/Withdraw buttons, `HistoryTabs`. Terminal brand: returns `<MT5Funds/>` instead. Logged out: EmptyState "Sign in to view your wallet". |
| `app/history/page.tsx` | `/history` | `<HistoryScreen/>` → `MT5History` on a terminal brand, else `<h1>History</h1>` + `HistoryTabs`. |
| `app/history/digits/page.tsx` | `/history/digits` | Digits-only page: back chevron (`aria-label="Back to trade"`), `<h1>Trade history</h1>`, `DigitHistoryPanel`. `metadata.title = 'Trade history'`. |
| `app/account/page.tsx` | `/account` | Terminal brand: returns `<MT5Settings/>` (whole page). Else: "Account" heading + "Log out" button, `MT5AccountPanel` *or* a plain `Username` card, `ReferralInviteCard`, `PlayerSecurityCard`, `SecurityCard`. Logged out: EmptyState "Account" + "Log in". |
| `app/affiliate/page.tsx` | `/affiliate` | Affiliate programme: "Affiliate programme" / "Refer players, earn 20% of the net revenue they generate." → `ApplyCard` or `MarketerView`. Not linked from any nav I found. |
| `app/dashboard/page.tsx` | `/dashboard` | Marketer dashboard. Redirects non-marketers to `/`. Terminal brand wraps it in `MT5TitleBar title="Dashboard"` + `MT5_TOKENS` + `bg-[#0f1720]`. |
| `app/legal/page.tsx` | `/legal` | "Legal & Responsible Gaming" long-form page with TOC: Responsible Gaming / Terms of Service / Privacy / About & Licence. |
| `app/offline/page.tsx` | `/offline` | Service-worker fallback: "You're offline" / "Reconnect to trade." / "Retry". |
| `app/r/[code]/page.tsx` → `app/r/[code]/view.tsx` | `/r/<CODE>` | Referral landing: brand initial tile, brand name, "Invite code" card, "Create account" / "Already have an account? Log in", "18+ only. Play responsibly, learn more". |

**Not player-reachable:** `app/admin/**` (18 pages), `app/platform/**` (20 pages), `app/console/page.tsx`. `AppShell` suppresses all player chrome for `/admin`, `/platform`, `/console`. `src/middleware.ts` redirects `/` → `/console` on the admin host (`ADMIN_HOST`, default `triocodes.com`) — and, on any host that is NOT an operator host, rewrites those three paths to a 404 before the route matches, so a brand domain behaves as though they do not exist (BUGLOG #134; the allowed hosts are the admin host plus loopback / `.test` / `.localhost` / `*.pages.dev`, see `lib/brand/adminHost.ts`).

---

## 2. Components rendering the trading experience

### 2a. `components/mt5/` — the MT5 kit (MT5-styled)
`components/mt5/kit.tsx` — shared primitives for every off-trade MT5 screen. Palette literals `#0f1720 #202933 #3183ff #4597ff #2b3543 #8fa2b8 #41be56 #f23645`.
Exports: `MT5TitleBar` (sticky blue band under the app bar, `top-14`, optional subtitle + actions + tab children), `MT5SummaryLine` (label : dotted leader : blue value), `MT5Summary`, `MT5Section` (uppercase group heading), `MT5Row` (label / sub-label / value / checkbox / chevron; `href`, `onClick`, `control`), `MT5Check` (square blue checkbox), `MT5Entry` (two-line record: title+detail / time+result), `MT5Amount` (blue credit / red debit), `MT5Empty`.
Palette source of truth: `lib/ui/mt5.ts` (`MT5` const, sampled pixel counts in comments) and `lib/ui/mt5Tokens.ts` (`MT5_TOKENS`, `MT5_CONFIRM_TOKENS` — re-point every `--pp-*` token incl. `--pp-radius: 2px`).

### 2b. `components/game/` — trade surface
| File | Export | Renders | Style |
|---|---|---|---|
| `TradeSurface.tsx` | `TradeSurface` | Layout chooser. `digits` → `DigitsTradeScreen`. Terminal → `MarketWatch` (lg+ left) + `GameCurve` + `MT5Toolbox` + `MT5OrderTicket` (lg+ right). Classic → `PriceHeader` + `TickerStrip` + `GameCurve` + `BetPanel`. | mixed |
| `GameCurve.tsx` | `GameCurve` | Wrapper: `CandleChart` on TradingView brands, else `CurveCanvas`. On wave brands overlays `InterfaceModeToggle` top-right. | mixed |
| `CandleChart.tsx` (856 ln) | `CandleChart` | The MT5 chart: toolbar, 21 periods, ⚙ Tools menu, left `DrawRail`, TradingView Lightweight Charts v5, OHLC legend, watermark. | **MT5** (`TV` const = exact MT5 palette) |
| `ChartDrawings.tsx` | `ChartDrawings`, type `Projection` | SVG overlay that draws/edits objects (trend line, horizontal, pitchfork, fib, text, measure). Text tool uses `window.prompt('Label')`. Esc clears pending; Delete/Backspace removes selection. | MT5-ish |
| `CurveCanvas.tsx` (447 ln) | `CurveCanvas`, type `MarketerBeat` | The *classic* canvas wave: smoothed Catmull-Rom line, red above / green below (or neutral in basic skin), left-side value axis. Reads `--pp-*` tokens. | **classic** |
| `MT5Toolbox.tsx` (662 ln) | `MT5Toolbox` | MT5 Toolbox: collapsible account figure row + 6 bottom tabs + `PaneSplitter`. | **MT5** |
| `MT5OrderTicket.tsx` (261 ln) | `MT5OrderTicket` | MT5 order ticket. | **MT5** |
| `MT5LivePosition.tsx` | `MT5LivePosition` | Open position as MT5 states one: symbol / side+volume, big Profit figure, Volume/Stake/Multiplier/Expires-in rows, 1px progress rule, close button. | **MT5** |
| `MT5CloseNotice.tsx` | `MT5CloseNotice` | Non-modal corner toast for a closed position ("Position closed" / "Position closed at expiry"). Blocks no clicks. | **MT5** |
| `MT5Price.tsx` | `MT5Price` | MT5 price typography — enlarged pip digits, raised fractional pip. `aria-label` carries the plain number. | **MT5** |
| `MarketWatch.tsx` | `MarketWatch` | MT5 Market Watch, docked left ≥lg. Quote row + Details list; tabs along the bottom. | **MT5** |
| `PaneSplitter.tsx` | `PaneSplitter`, `usePanelHeight` | `role="separator"`, `aria-label="Resize panel"`, `title="Drag to resize. Double-click to reset."`, arrow-key support, height persisted at `pp-toolbox-height`. | **MT5** |
| `BetPanel.tsx` (329 ln) | `BetPanel` | **Classic** order panel: 3 stake chips + "Custom", stake field with −/+, `Segmented` Duration, BUY/SELL buttons, `LivePnl` while open. | **classic** |
| `LivePnl.tsx` | `LivePnl` | Classic open-position card: rounded-full pill "BUY · ×1.95", "Live P&L", "Stake", coloured progress bar. | **classic** |
| `PriceHeader.tsx` | `PriceHeader` | Classic quote strip: status dot, pair (`BTC/KES` or symbol), big price, ±% pill, H/L, "Online" count. Hidden on terminal + marketer. | **classic** |
| `TickerStrip.tsx` | `TickerStrip` | Decorative *fake* scrolling crypto marquee (MATIC/ATOM/UNI/BTC/ETH/SOL/XRP/DOGE/ADA, random-walked), red "LIVE" badge. Hidden on terminal + marketer. | **classic** |
| `OutcomeOverlay.tsx` (369 ln) | `OutcomeOverlay` | Full-screen win/loss celebration (confetti, count-up, money-flight, haptics). On a terminal brand it returns `MT5CloseNotice` instead. | **classic** |
| `WelcomeBonusOverlay.tsx` (261 ln) | `WelcomeBonusOverlay` | Sign-up bonus celebration. No MT5 branch — always the celebration. | **classic** |
| `InterfaceModeToggle.tsx` | `InterfaceModeToggle` | Gear menu "Interface" → Classic / Basic. | classic chrome (`border-border bg-surface/80`) |

### 2c. `components/game/digits/` — the Deriv clone (none MT5-styled)
`DigitsTradeScreen.tsx` (949 ln) `DigitsTradeScreen` · `DerivChart.tsx` `DerivChart` · `DigitHeatmap.tsx` `DigitHeatmap` · `DigitHistoryPanel.tsx` `DigitHistoryPanel` · `DigitResultModal.tsx` `DigitResultModal` + `DigitResult` · `DigitsTradeScreen` internals · `EntryScanner.tsx` `EntryScanner` + `ScanSuggestion` · `HowToTradeModal.tsx` `HowToTradeModal` · `InsufficientBalanceModal.tsx` `InsufficientBalanceModal` + `InsufficientFundsInfo` · `MarketsPicker.tsx` `MarketsPanel`, `IndexBadge` · `MultipliersPanel.tsx` `MultipliersPanel` · `PositionsPanel.tsx` `PositionsPanel` · `PositionsSheet.tsx` `PositionsSheet` · `TradeTypes.tsx` `TradeTypesSheet`, `TradeTypeIcon`, `TRADE_TYPES`, type `TradeTypeId` · `TransactionHistoryModal.tsx` `TransactionHistoryModal` · `VolatilitySelector.tsx` `VolatilitySelector` · `icons.tsx` `DIcon`, type `IconName`.

### 2d. `components/history/`
- `HistoryScreen.tsx` `HistoryScreen` — the switch: `MT5History` on terminal, else `<h1>History</h1>` + `HistoryTabs`.
- `MT5History.tsx` (496 ln) `MT5History` — **MT5**. Blue title bar "History" / "All symbols", Sort + Period icon buttons with menus, three tabs in the bar, dotted-leader summary, two-line entries <lg and wide tables ≥lg, opens `PositionDetailModal`. Supporting pure logic in `lib/history/mt5history.ts` (`PERIODS`, `SORTS`, `EXECUTION_PRICE = 'at market'`, row builders).

### 2e. `components/wallet/`
| File | Export | Renders | Style |
|---|---|---|---|
| `MT5Funds.tsx` | `MT5Funds` | **MT5** funding screen: title bar "Funds" / "Demo account"\|"Real account", dotted summary, green Deposit + bordered Withdraw, "Balance operations" section, "See the full history ›". | **MT5** |
| `WalletModal.tsx` | `WalletModal` | The unified Deposit/Withdraw sheet. MT5-aware chrome only (blue band + underlined tabs + `MT5_CONFIRM_TOKENS`); the forms inside are unchanged. | both |
| `DepositPanel.tsx` | `DepositPanel` | Method tab strip (server-driven) → `DepositForm` / `LipwaDeposit` / `PayBillDeposit`. MT5-aware tab styling. | both |
| `DepositForm.tsx` (372) | `DepositForm` | M-Pesa STK deposit body. | classic (token-repainted on MT5) |
| `WithdrawForm.tsx` (283) | `WithdrawForm` | M-Pesa withdrawal body. | classic (token-repainted) |
| `LipwaDeposit.tsx` (239) | `LipwaDeposit`, `EmbeddedCheckout` | PayHero hosted-checkout iframe deposit. | classic |
| `PayBillDeposit.tsx` (186) | `PayBillDeposit` | Manual Pay Bill + code claim, green card with 📲 emoji. | classic |
| `AccountSwitcher.tsx` | `AccountSwitcher` | Top-bar rounded-full balance pill (R/D badge) opening `AccountMenu`. Hidden entirely on a terminal brand. | **classic** |
| `AccountMenu.tsx` | `AccountMenu`, `AccountMenuProps` | 280px Real/Demo card + Deposit/Withdraw + "Top up demo balance". | **classic** |
| `WalletWidget.tsx` | `WalletWidget` | Balance card + bonus wagering progress bars. | **classic** |
| `HistoryTabs.tsx` | `HistoryTabs` | Pill tabs: **Transactions / Ledger / Bets**. | **classic** |
| `TransactionsList.tsx` | `TransactionsList` | Cards <md / table ≥md (Type, Amount, Status, Receipt, Date). | classic |
| `LedgerList.tsx` | `LedgerList` | Cards/table (Type, Wallet, Amount, Date). | classic |
| `MpesaIcon.tsx` | `MpesaIcon` | M-Pesa glyph. | n/a |

### 2f. `components/positions/`
- `PositionHistory.tsx` `PositionHistory` — classic: All/Open/Settled pill filters, cards/table, "No bets yet" / "Your placed positions will show up here.", "Couldn't load bet history."
- `PositionDetailModal.tsx` `PositionDetailModal` — classic modal, title "Position detail".

### 2g. `components/account/`
- `MT5Settings.tsx` `MT5Settings` — **MT5**. The whole `/account` page on a terminal brand.
- `MT5AccountPanel.tsx` `MT5AccountPanel` — **MT5** "Trading accounts" dialog replica (blue header, Real/Demo switcher nav, detail rows, green CTA, copy-ID footer).
- `AccountDialogs.tsx` `AccountDialogs`, `TwoFactorDialog`, `VerifyIdentityDialog` — classic dialogs with accent-gradient headers.
- `ReferralInviteCard.tsx` `ReferralInviteCard` — classic card, "Invite & earn 5%".
- `SecurityCard.tsx` `SecurityCard` — operator-only (returns null for players).

### 2h. `components/settings/`
- `PnlColorToggle.tsx` `PnlColorToggle` — "Profit / loss colours" Brand(mono)/Classic segmented. **Dead code: grepped the whole app, it is never imported anywhere.**

### 2i. `components/layout/` (shell)
`AppShell.tsx` `AppShell` (the 4-branch shell router) · `TopBar.tsx` `TopBar` (MT5-aware: blue `#3183ff` band + hamburger on terminal) · `BottomNav.tsx` `BottomNav` (**returns null on terminal brands**) · `MT5Drawer.tsx` `MT5Drawer` (**MT5** side panel) · `Footer.tsx` `Footer` (classic, hidden on terminal routes) · `Logo.tsx` `Logo`, `LogoMark` · `ThemeToggle.tsx` `ThemeToggle` · `SoundToggle.tsx` `SoundToggle`, `SoundBootstrap` · `CurrencySwitcher.tsx` `CurrencySwitcher` · `DigitsTopBar.tsx` `DigitsTopBar` · `DigitsBottomNav.tsx` `DigitsBottomNav` · `DigitsAccount.tsx` `AccountPill`, `AccountMenu`, `ChangePasswordModal`.

### 2j. Other player-facing
`components/Providers.tsx` (mounts `OutcomeOverlay`, `WelcomeBonusOverlay`, `ReferralCapture`, `SecurityQuestionsGate`, `MfaEnrolmentGate`, `SessionCacheGuard`) · `components/auth/AuthModal.tsx`, `AuthButtons.tsx`, `ProfileMenu.tsx` (all MT5-aware) · `components/chat/LiveChatPanel.tsx` (`LiveChatPanel`, `LiveChatLauncher`, `useLiveChatUnread`), `ChatParts.tsx` (`ChatMessages`, `ChatComposer`) · `components/notifications/NotificationBanners.tsx` (MT5-aware) · `components/marketer/MarketerHUD.tsx` (`MarketerHUD`, `MarketerLogoHotspot`), `MarketerDashboardView.tsx`, `ReferralCommissionsCard.tsx` · `components/support/SupportWidget.tsx` — **dead code, never imported** · `components/ui/*` (`Modal`, `Sheet`, `Button`, `Input`, `Card`, `Badge`/`StatusBadge`, `Segmented`, `Select`, `Skeleton`, `EmptyState`, `Money`, `FitText`).

---

## 3. Every dialog / modal / sheet / drawer / popup / overlay (exact strings)

### 3.1 `AuthModal` — `components/auth/AuthModal.tsx`
Trigger: `openAuth('login'|'register'|'reset')` from TopBar "Login"/"Sign Up", EmptyStates, deposit guards, drawer, chat. Via `ui/Modal` with `chrome={false}`; MT5 brands get `MT5_TOKENS` + `mt5-square`.

Header — non-MT5: `Logo` + `ThemeToggle` + close (`aria-label="Close"`). MT5: blue band with the screen title + close.
Titles (`copy`): login `Log in` / cta `Log in`; register `Create account` / cta `Create account`; reset `Reset password` / cta `Update password`.
Tabs (`role="tablist" aria-label="Authentication mode"`): **Log in** | **Sign up**. Reset mode replaces them with "← Back to log in".
Fields:
- `Phone number`, placeholder `07XX XXX XXX`
- `Username` (register), placeholder `Shown on your profile`
- `Password` label row with `Forgot password?` link; labels `Password` / `New password`; placeholders `At least 8 characters` / `••••••••`; show/hide (`aria-label="Show password"` / `"Hide password"`)
- Strength meter labels: `Too short`, `Weak`, `Fair`, `Good`, `Strong`
- `Confirm password`, placeholder `Re-enter your password`
- `Referral code` (collapsed behind `+ Add a referral code`), `optional`, placeholder `8-character code`
- Privileged reset block: `Admin account: verify your security questions`, per-question inputs placeholder `Your answer`, note `Matching is case-insensitive.`
- 2FA step: label `Authentication code` / `Recovery code`; placeholders `123456` / `XXXX-XXXX`; help `Two-factor is on for this account. Enter the 6-digit code from your authenticator app.` / `Use one of the recovery codes you saved when you turned on two-factor.`; link `Lost your phone? Use a recovery code` / `Use the app code instead`
Buttons: submit = `copy.cta`, busy state `Please wait…`.
Cross-link: `Have an account? Log in` / `New to {brand}? Create one`.
Footer: `M-Pesa · 18+`, `By continuing you agree to our Terms & Responsible Gaming policy.`
Validation strings: `Enter your password.`, `Passwords do not match.`, `Required`, `That code is wrong or expired. Try the newest code in your app.`, `That recovery code is not valid.`
Success sub-state: title `Password updated`, body `Your new password is active. Log in to continue trading.`, button `Continue to log in`.

### 3.2 `WalletModal` — `components/wallet/WalletModal.tsx`
Trigger: `useDepositUi.openDeposit()/openWithdraw()` — Deposit/Withdraw buttons on `/wallet`, `AccountMenu`, `ProfileMenu`, `MT5Funds`, `MT5AccountPanel` ("Fund your account"), BetPanel/MT5OrderTicket short-funds taps, `WelcomeBonusOverlay`, `InsufficientBalanceModal`, `DigitsTopBar`.
Header: non-MT5 `M-Pesa wallet` + ghost `✕`; MT5 `Deposit` / `Withdraw` in the blue band + close (`aria-label="Close"`).
Balance block caption: `Real balance` (deposit) / `Withdrawable` (withdraw).
Tabs (`role="tablist" aria-label="Wallet action"`): **Deposit** | **Withdraw** — the whole strip is *absent* on a demo account.

### 3.3 `DepositPanel` + bodies
Method strip: `role="tablist" aria-label="Deposit method"`; labels come from the server (`M-Pesa`, `M-Pesa (1)`…). Loading `Loading payment options…`; none available `Deposits are temporarily unavailable. Please check back shortly.`

**`DepositForm.tsx`** — field caption `Amount` (`aria-label="Amount to deposit in {currency}"`, placeholder `0`), four quick-amount chips, hint `Min {x} · Max {y} · ≈ KES … via M-Pesa`, section `M-Pesa number` (saved-number card shows masked number + `Your account number` + `Change`; manual input placeholder `0712 345 678`, hint `Sending to a different number than your account.`), error `Enter a valid Kenyan number, e.g. 0712 345 678.`
Primary button: `Continue to Pay` / `Sign up to deposit` / `Sending payment prompt…` / `Check your phone · {n}s`.
States: `Check your phone` + `We sent a prompt to {masked}. Enter your M-Pesa PIN to approve {amount}.` + `Cancel` · `Deposit received` + `{amount} has been added to your wallet.` + `Your {BUY/SELL} trade is ready.` / `Closing…` + `Done` · `Payment not completed` + `The M-Pesa prompt wasn't approved in time or was cancelled. No money was deducted.` + `Try again`.

**`WithdrawForm.tsx`** — `Amount` (`aria-label="Amount to withdraw in {currency}"`), quick chips **25% · 50% · 75% · Max**, `Min {x}`, `M-Pesa number` card with `Withdrawals are paid to your registered number only`, foreign-brand row `You'll receive {KES}`, button `Withdraw` / `Requesting…`, footer `M-Pesa · Secured`.
Errors: `Minimum withdrawal is {x}.`, `Amount exceeds your real balance.`, `Enter a valid Kenyan number, e.g. 0712 345 678.`
Success: `Sent to M-Pesa` / `Withdrawal requested`; `It reflects in your M-Pesa balance instantly.` / `Funds are held and paid out after approval.`; rows `Amount`, `To`; button `Done`.

**`LipwaDeposit.tsx`** — `Amount`, 4 chips, `Min … · Max …`, trust line `Pay by card, bank or mobile money, securely, without leaving the app.`, button `Continue to Pay` / `Opening secure checkout…` / `Sign up to deposit`. Embedded checkout: `Complete your payment`, `Paying {amount} · secured by PayHero`, badge `Secure`, back (`aria-label="Back"`), `Loading secure checkout…`, `Taking too long? Open securely →`, iframe `title="PayHero secure checkout"`, `Waiting for your payment…`, `Close`. Failure: `Payment not completed` / `The payment was cancelled or didn't go through. No money was deducted.` / `Try again`. Success: `Payment received` / `{amount} has been added to your wallet.` / `Done`.

**`PayBillDeposit.tsx`** — card `Safaricom` / `Lipa na M-PESA · Pay Bill` (📲 emoji), copy rows `Business number (Pay Bill)` and `Account number` (`aria-label="Copy {label}"`, button `Copy` → `✓ Copied`), `Recipient: {businessName}`. Steps 1–4: `Open M-PESA → Lipa na M-PESA → Pay Bill.` / `Business no. {x}, Account {y}.` / `Enter the amount and your M-PESA PIN to pay.` / `Paste the confirmation code from the M-PESA SMS below.` Field `M-PESA transaction code`, placeholder `e.g. TJ84KD9P2L`, help `Paste it exactly as it appears in the SMS. Deposits are verified against Safaricom records before your account is credited.` Button `Verify & credit` / `Verifying…` / `Verify again` / `Sign up to deposit`. Errors: `Enter the full M-PESA confirmation code from your SMS.`, `This code has already been used on another account.`, `We couldn't verify that code. Check it and try again.`, pending `We haven't received this payment from Safaricom yet. Give it a few seconds, then tap Verify again.` Disabled: `Pay Bill is not available for this account. Please use another deposit method.`

### 3.4 `TwoFactorDialog` — `components/account/AccountDialogs.tsx`
Trigger: `useAccountUi.open('twofactor')` — "Manage" on `/account` or the MT5 Settings row. **Gated off: `PLAYER_TWO_FACTOR = false` in `lib/account/accountUi.ts`, so players cannot currently reach it.**
Shell header: title `Two-Factor Auth`, sub `A code from your phone at every sign-in`, shield icon, close (`aria-label="Close"`).
On state: `Two-factor is on`, `Signing in asks for a 6-digit code from your authenticator app. {n} recovery codes left.`, label `To turn it off, enter a current code` (placeholder `123456`), button `Turn off two-factor`.
Enrol state: steps `Open an authenticator app (Google Authenticator, Microsoft Authenticator, Authy).` / `Scan this QR code, or type the key.` / `Enter the 6-digit code it shows.`; QR + secret; warn box `Save these recovery codes` / `Each works once if you lose your phone. They won't be shown again.` / checkbox `I saved my recovery codes`; input `aria-label="Code from your app"`; button `Turn on two-factor`.
Off state: `Protect your balance: even if someone learns your password, they can't sign in without the code from your phone.`, button `Set up two-factor`. Toasts `Two-factor is on` / `Two-factor turned off`.

### 3.5 `VerifyIdentityDialog` — `components/account/AccountDialogs.tsx`
Trigger: `useAccountUi.open('verify')` — "Verify"/"View" on `/account`, "Identity verification" row in MT5 Settings, `Verify Identity` in the digits drawer.
Header: title `Verify Identity`, id-card icon.
Status lines: `Your identity is verified.` / `Under review · {docType}` / `Not approved. {reviewNote}`; retry button `Send new documents`.
Form: `Document` select (`National ID`, `Passport`, `Driving licence`), `Full name, as on the document`, `Document number`, `Date of birth`; file pickers `Front of the document` / `Photo page` (hint `Photo or PDF, all corners visible`), `Back of the document` (hint `Photo or PDF`), `Selfie` (hint `Your face, clearly lit, no glasses or hat`); note `Your documents are only seen by this brand's support team to confirm your identity.`; button `Send for review` / `Sending…`; error `Could not send your documents. Try again.`; toast `Documents sent`.

### 3.6 `MT5Drawer` — `components/layout/MT5Drawer.tsx` (MT5 side panel)
Trigger: the hamburger in `TopBar` (`aria-label="Open menu"`) — terminal brands only. Backdrop button `aria-label="Close menu"`; nav `aria-label="Main menu"`. Escape closes; body scroll locked; closes on navigation.
Header (signed in, links to `/account`): username, badge `Demo` or `Real`, server line `{Brand}-Demo` / `{Brand}-Live`, balance. Signed out: brand name + `Not connected`.
Rows: **Trade** (`/`), **History** (`/history`), **Funds** (`/wallet`), **Settings** (`/account`), **Chat** (opens LiveChat, unread badge). Footer row: **Log out** (red) or **Log in**.

### 3.7 `ProfileMenu` — `components/auth/ProfileMenu.tsx`
Trigger: the avatar in `TopBar` (`aria-label="Account menu"`, `aria-haspopup="menu"`). MT5: square outlined avatar + `MT5_TOKENS`.
Items: `@{username}` header, **Deposit**, **Withdraw** (absent on demo), **History**, **Account**, **Log out**.

### 3.8 `AccountMenu` (classic) — `components/wallet/AccountMenu.tsx`
Trigger: the balance pill in `AccountSwitcher` (`aria-label="{Real|Demo} account, {amount}. Switch account"`). `role="dialog" aria-label="Switch account"`, inner `role="menu" aria-label="Accounts"`.
Rows: **Real** (`role="menuitemradio"`, `aria-label="Real account, {amount}, active"`, sub `{x} bonus`), **Demo**. Then `Top up demo balance` / `Topping up…`. Then **Deposit** / **Withdraw** buttons and, in demo, `Practice money: never withdrawable.`
Toasts (from `AccountSwitcher`): `Real account` / `Demo account`, `Could not switch`, `Demo balance topped up`, `Could not top up`.

### 3.9 `InterfaceModeToggle` popup — `components/game/InterfaceModeToggle.tsx`
Trigger: gear button, `aria-label="Interface settings"`, `aria-haspopup="menu"`. In the `CandleChart` toolbar (terminal) or the wave's top-right corner.
`role="menu" aria-label="Interface"`, heading `Interface`. Options (`role="menuitemradio"`): **Classic** / `Full chart & controls`; **Basic** / `Simplified game view`.

### 3.10 `CandleChart` ⚙ Tools menu — `components/game/CandleChart.tsx`
Trigger: toolbar button `⚙ Tools` (`title="Chart features"`, `aria-expanded`). Sections and exact labels in §4.

### 3.11 `MT5History` Period + Sort menus — `components/history/MT5History.tsx`
Triggers: two icon buttons in the blue title bar, `aria-label="Sort"` and `aria-label="Period"`; backdrop `aria-label="Close menu"`.
Period menu (from `lib/history/mt5history.ts PERIODS`): **Today**, **Last week**, **Last month**, **Last 3 months**, **Custom period**; custom block has `From` and `To` date inputs. Each non-custom entry carries a date-range sub-line; the active one gets `✓`.
Sort menu (`SORTS`): **Symbol**, **Ticket**, **Time**, **Profit**; active shows `↑`/`↓` (re-tapping flips).

### 3.12 `PositionDetailModal` — `components/positions/PositionDetailModal.tsx`
Trigger: tapping a row in `MT5History` (positions/orders tabs) or `PositionHistory`. Via `ui/Modal` `chrome={false}`, title `Position detail`.
Header: `Position detail` + `Close`. Rows: `Direction`, `Status`, `Result` (`win`/`loss` + `· ×1.95`), `Stake`, `Payout`, `P&L`, `Entry rate`, `Exit rate`, `Duration`, `Opened`, `Settled`. Button `Done`. Error `Couldn't load this position.`

### 3.13 `OutcomeOverlay` (classic celebration) — `components/game/OutcomeOverlay.tsx`
Trigger: engine settlement (`useOutcomeFx`). `role="dialog" aria-live="assertive" aria-label="{title} {amount}"`. Backdrop + blur, confetti canvas, tap-to-dismiss, auto-dismiss.
Headline strings by `OutcomeHeadline`: **BIG WIN**, **YOU WON**, **WIN**, **SO CLOSE**, **NO WIN**. Marketer skin: `NICE!` / `AGAIN?`.
Body: `×{multiplier}`, big count-up `+{amount}` / `−{amount}`, net line `Payout {x} · stake {y}` or `−{x} · stake {y}`, button **Collect** (win) / **Continue** (loss). Flying payout chip `+{payout}`.

### 3.14 `MT5CloseNotice` (the terminal's replacement) — `components/game/MT5CloseNotice.tsx`
Not a dialog — `pointer-events-none` wrapper, `aria-live="polite"`, top-right under the app bar.
Header: `Position closed` (manual) / `Position closed at expiry`; dismiss `aria-label="Dismiss"` (`×`). Body: `#{ticket8} {buy|sell} {lots}` and the signed profit.

### 3.15 `WelcomeBonusOverlay` — `components/game/WelcomeBonusOverlay.tsx`
Trigger: `useWelcomeBonusFx` after sign-up. `role="dialog" aria-live="assertive" aria-label="Welcome bonus {amount}"`.
Strings: eyebrow **Welcome bonus**, count-up `+{amount}`, `Min stake {x}`, `Bonus · withdrawable once won`, primary **`Deposit {x}+ & play`** (or `Deposit & play`), secondary **Later**. Confetti + haptics + money-flight. **No MT5 branch.**

### 3.16 `LiveChatPanel` — `components/chat/LiveChatPanel.tsx`
Trigger: `LiveChatLauncher` floating button (`aria-label="Live chat (n new)"`, md+ only), `BottomNav` CHAT item, `MT5Drawer` Chat row, `DigitsBottomNav` Live Chat.
`role="dialog" aria-label="Customer care chat"`. Header `Customer Care` + brand name; close `aria-label="Close chat"`. MT5: blue band, no round avatar.
Logged out: button `Log in`, `Or WhatsApp {number}`. Signed in: contact chips `WhatsApp {number}`, `{email}`; `Resolved` note; `ChatComposer` — input placeholder/`aria-label` `Message`, `aria-label="Attach a photo or video"`, `aria-label="Record a voice note"`, `Recording m:ss` + `Cancel` + `aria-label="Send voice note"`, `aria-label="Send"`, `aria-label="Remove attachment"`, image viewer `aria-label="Photo"` / `aria-label="Open photo"`.

### 3.17 `NotificationBanners` — `components/notifications/NotificationBanners.tsx`
Not a dialog; sticky `role="alert"` banners under the app bar. Title + body from the server; dismiss `aria-label="Dismiss notification"` (`×`). MT5: full-bleed, square, `MT5_TOKENS`.

### 3.18 Digits-shell overlays (none MT5-shaped)
- **`PositionsSheet`** (`PositionsSheet.tsx`) — bottom sheet, `aria-label="Positions"`, backdrop `aria-label="Close positions"`, grabber. Contains `PositionsPanel`: tabs **Open / Closed / History**, `aria-label="Close positions"`, `No open positions`, `No closed positions`, `No trades yet`, `Load more`, footer `aria-label="Session"` + `title="Trades · wins · losses"`, `DEMO` chip.
- **`TransactionHistoryModal`** — `aria-label="Transaction history"`. Header `Transaction History` / `Deposits, withdrawals & trade activity` + close. Row titles: `Trade Stake`, `Trade Win`, `Deposit`, `Withdrawal`, `Withdrawal refunded`, `Bonus`, `Balance adjustment` (`by support`), `Demo balance refreshed` (`play money`). Empties: `Sign in to see your transactions.`, `Loading…`, `Couldn't load your transactions.`, `No transactions yet.`, `Load more`.
- **`HowToTradeModal`** — `aria-label="How to trade"`. Header `How to Trade` / `Digit contracts in one minute`. Seven sections with full marketing-tone bodies: `How a contract works`, `Even / Odd`, `Match / Differ`, `Over / Under`, `Stake and payout`, `Manual and Auto`, `Digit statistics`. A parallel `MARKETER_SECTIONS` set re-words everything as a game (`How a round works`, `Cost and reward`, `Number stats`; header `How to Play` / `The game in one minute`).
- **`DigitResultModal`** — `aria-label="You won"` / `"Trade lost"`. Headline **YOU WON!** / **YOU LOST** (marketer `NICE!`/`AGAIN?`), block label `P/L`, tiles **Stake**, **Payout**, **Digit**, **Duration**, contract pill (e.g. `Over 5`), close `aria-label="Close"`. Pop/shake animations.
- **`InsufficientBalanceModal`** — `aria-label="Not enough balance"`. Heading **Not enough balance**; rows **Current balance**, **Required stake**, **Shortfall**; buttons **`Deposit {shortfall}`** and **Cancel**.
- **`TradeTypesSheet`** (`TradeTypes.tsx`) — `aria-label="Trade types"`. Title **Trade types** (marketer `Game modes`); filter chips `role="tablist" aria-label="Filter trade types"`: **All**, **Multipliers**, **Options** (marketer `Quick`). Groups **Multipliers** / **Digits**; items **Multipliers**, **Matches/Differs**, **Even/Odd**, **Over/Under**; locked badge `Demo account` (marketer `Practice`).
- **`MarketsPanel`** via `VolatilitySelector` — `role="dialog" aria-modal aria-label="Markets"`, backdrop `aria-label="Close markets"`. Heading **Markets**; rail categories **Favorites**, **Synthetic indices**; groups **Volatility (1s) indices**, **Volatility indices**; search placeholder `Search…` (`aria-label="Search markets"`, `aria-label="Clear search"`); star `aria-label="Add {label} to favorites"` / `"Remove {label} from favorites"`; empties `No market matches your search.`, `No favorites yet. Tap the star next to a market to keep it here.`
- **`EntryScanner`** — `Sheet` with `title="Entry Scanner"`, `label="AI Entry Scanner"`, robot icon. `Segmented label="Market"` with `Even/Odd`, `Match/Differ`, `Over/Under`. Progress rows, `Best`, instrument label, side label, share %, `title="Points above the expected share"`. Footer buttons **Scan** / **Rescan** / **`{pct}%`** / **Auto running**, and **Run**.
- **`DigitsTopBar`** mobile nav drawer — `role="dialog" aria-modal aria-label="Menu"`, backdrop `aria-label="Close menu"`, close `aria-label="Close"`. Items: **Trader's Hub** (marketer `Home`), **Deposit**, **Withdraw**, **History**, **Live Chat**, **How to Trade** (marketer `How to Play`), **Account**, **Verify Identity**, **Change Password**, **Legal**; signed-out footer **Log in** / **Sign up**.
- **`DigitsTopBar`** notifications popover — `aria-label="Notifications (n)"`, heading `Notifications`, empty `None`, `aria-label="Dismiss"`.
- **`ChangePasswordModal`** (`DigitsAccount.tsx`) — `aria-label="Change password"`, heading **Change password**, placeholders `Current password`, `New password`, `Repeat new password`, buttons **Cancel** / **Change password** (`Saving…`), errors `The new passwords do not match.`, `Could not change your password. Try again.`, toast `Password changed`.
- **`AccountMenu`/`AccountPill`** (`DigitsAccount.tsx`) — `aria-label="Account menu"`, pill `aria-label="{Real|Demo} account, {amount}. Switch account"`; toasts `Trade open`, `Could not switch`, `Demo balance topped up`, `Could not top up`.

### 3.19 Overlay primitives
- `components/ui/Modal.tsx` — `role="dialog" aria-modal aria-label={title}`; chrome mode draws a header with the title, optional description, close (`aria-label="Close"`), scrollable body, optional sticky footer. Takes `panelStyle` (for `MT5_TOKENS`) and `panelClassName` (for `mt5-square`). Escape closes; body scroll locked.
- `components/ui/Sheet.tsx` — bottom sheet with grabber (<sm) / centred card (≥sm); `aria-label` from `label` or `title`; close `aria-label="Close"` (44px); optional pinned footer.
- Dialogs **not** using these primitives (hand-rolled `fixed inset-0`): `AccountDialogs` (`Shell`), all digits modals, `MT5Drawer`, `OutcomeOverlay`, `WelcomeBonusOverlay`, `LiveChatPanel`, `DigitsTopBar` drawer, `ChangePasswordModal`.
- Operator-only gates mounted globally but inert for players: `components/auth/MfaEnrolmentGate.tsx`, `SecurityQuestionsGate.tsx`.

---

## 4. Trade-screen control inventory (terminal shell)

### 4.1 `MT5OrderTicket` — `components/game/MT5OrderTicket.tsx`
Header: `{symbol}` (default `XAUUSD`) and `Market Execution`.

| Row | Controls / exact labels |
|---|---|
| **Volume** | `−0.01` (`aria-label="Decrease volume"`), value box `{lots.toFixed(2|3)}`, `+0.01` (`aria-label="Increase volume by 0.01"`), `+0.1` (`aria-label="Increase volume by 0.1"`). `VOLUME_STEPS = [0.01, 0.1]`. Sub-line: `= {money}` and `min {x} / max {y}`. |
| **S / L** | Read-only box showing the stake, `title="Fixed at the stake: this contract settles at expiry and cannot lose more."` |
| **T / P** | `−` (`aria-label="Lower take profit"`), value `at expiry` \| `none` \| `{amount}`, `+` (`aria-label="Raise take profit"`). Step = `max(10_000, minCents/2)`. Note: `Closes on PROFIT reaching this amount, not a price, because an open contract's payout rises with time.` or `This brand settles every contract at expiry, so a profit target cannot close one early.` |
| **Expiry** | Duration buttons from `DURATION_OPTIONS = [10, 30, 60, 120]` + the brand default, rendered `10s`, `30s`, `1m`, `2m`; `aria-pressed`. *Explicitly not an MT5 control.* |
| **Quote buttons** | **Sell** on `#e8403a` left + `MT5Price`; **Buy** on `#3183ff` right + `MT5Price`. Both show the same price. |
| Footer | `Connecting…`; `Not enough free margin: tap a side to top up.` |

With a position open the ticket is replaced entirely by `MT5LivePosition`: `{symbol}` / `{buy|sell} {lots}`, `Profit` + big figure, rows **Volume**, **Stake**, **Multiplier** (`×1.95`), **Expires in** (`{n}s` / `Opening…` / `Closing…`); 1px progress rule; close button labelled `Close position` / `Closes at expiry` / `Closing…` with `title="Close this position at the current price"` or `"This contract settles at expiry"`; notes `Market execution. Left alone, it closes itself at expiry.` / `Closes automatically at expiry: market execution.` and `Max loss {x} (the stake). This contract cannot lose more.`

### 4.2 `CandleChart` toolbar — `components/game/CandleChart.tsx`
Left: `{instrument.symbol}` bold, then a vertical rule.
**Periods** — all 21 `TIMEFRAME_KEYS` from `packages/shared/src/candles.ts`, in a horizontally scrolling row, `aria-pressed` on the active one:
`M1 M2 M3 M4 M5 M6 M10 M12 M15 M20 M30 H1 H2 H3 H4 H6 H8 H12 D1 W1 MN1`. Persisted at `pp:chart:tf`. Default `M1`.
Right: `⚙ Tools` (`title="Chart features"`), `−` (`aria-label="Zoom out"`), `+` (`aria-label="Zoom in"`) — both hidden on coarse pointers — then `InterfaceModeToggle` (`aria-label="Interface settings"`).

**⚙ Tools menu sections:**
- `Chart type`: **Candles**, **Bars**, **Line**, **Area**, **Baseline**
- `Price scale`: **Linear**, **Log**, **Percent**
- `Trend` (from `lib/chart/indicatorCatalog.ts`): Moving Average `(7, 25, 99)`, Bollinger Bands `(20, 2)`, Envelopes `(14, 0.1%)`, Parabolic SAR `(0.02, 0.2)`, Ichimoku Kinko Hyo `(9, 26, 52)`, Adaptive Moving Average `(10, 2, 30)`, Double Exponential MA `(14)`, Triple Exponential MA `(14)`, Standard Deviation `(20)`, Average Directional Movement `(14)`
- `Oscillators`: Relative Strength Index `(14)`, MACD `(12, 26, 9)`, Moving Average of Oscillator `(12, 26, 9)`, Stochastic Oscillator `(5, 3, 3)`, Commodity Channel Index `(14)`, Average True Range `(14)`, Momentum `(14)`, Williams' Percent Range `(14)`, DeMarker `(14)`, Bears Power `(13)`, Bulls Power `(13)`, Relative Vigor Index `(10)`, Triple Exponential Average `(14)`
- `Bill Williams`: Awesome Oscillator `(5, 34)`, Accelerator Oscillator `(5)`, Alligator `(13, 8, 5)`, Gator Oscillator `(13, 8, 5)`, Fractals `(5)`
- `Volumes`: no toggles, only the note `Volume indicators need traded volume, which this instrument does not report.`
Each indicator is an `aria-pressed` toggle; the set persists at `pp-chart-indicators`.

**Chart body overlays:** OHLC legend top-left — `{symbol}` · `{tf}` · `O {x}` `H {x}` `L {x}` (≥sm only) · `C {x}` · `±{pct}%`; faint centred symbol watermark; chart host `role="img" aria-label="{symbol} price chart"`; `Loading {tf} history…`; `History unavailable ({error}). The live bar is still updating.`
**Gestures:** wheel/pinch zoom, drag-pan, price-axis drag to stretch, double-click either axis to auto-fit, scroll-left paging (500 bars/page), 3s idle auto-snap back to live.

### 4.3 Drawing rail (`DrawRail` in `CandleChart.tsx`, tools from `lib/chart/drawings.ts`)
A 40px left rail, `#202933`, each button `title` = `aria-label` = the label, `aria-pressed` on the active tool:
1. **Cursor** 2. **Crosshair** (switches the chart crosshair to magnet mode, not a drawing tool) 3. **Trend line** 4. **Horizontal line** 5. **Andrews pitchfork** 6. **Fibonacci retracement** 7. **Text** 8. **Measure**
Then, pinned bottom (`mt-auto`), the bin: `title`/`aria-label` = **`Delete selected object`** when something is selected, **`Clear all objects`** otherwise; disabled when `count === 0`.
Objects are stored per symbol in localStorage (`lib/chart/drawings.ts storageKey`), survive reload, and the tool auto-returns to `cursor` after a placement. Fib levels: `0, 0.236, 0.382, 0.5, 0.618, 0.786, 1` labelled `0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%`. The Text tool prompts with `window.prompt('Label')`.

### 4.4 `MT5Toolbox` — `components/game/MT5Toolbox.tsx`
**Account row (the toggle)** — `aria-expanded`, `aria-label` = `Show account details` / `Hide account details`. Figures: **Balance**, **Equity**, **Margin** (expanded only), **Free margin** (expanded only), **Margin level**. Plus `1 open` chip and a status dot (`title` `Live` / `Syncing` / `Offline`) and a `▾` chevron.
Expanded: mobile backdrop `aria-label="Close account details"`; the pane is a bottom sheet <sm and docked ≥sm; `PaneSplitter` on its top edge.

**Tabs along the bottom edge** (`TABS`, `aria-pressed`, counts as superscripts): **Trade**, **History**, **News**, **Mailbox**, **Alerts**, **Journal**.

| Tab | Content |
|---|---|
| **Trade** | <sm: `PositionRow` (`{SYMBOL}, {side} {lots}` / `{entry} → {current}` / profit + note `T/P {x}` or `Max loss {x}`). ≥sm table head: `Symbol, Ticket, Time, Type, Volume, Price, S / L, T / P, Price, Profit`. S/L cell `title="Fixed: this contract settles at expiry and cannot lose more than its stake."`; T/P cell has `−` (`aria-label="Lower take profit"`) / value / `+` (`aria-label="Raise take profit"`) or the text `at expiry`; Profit cell carries a `×` close button (`aria-label="Close position"`, `title="Close this position at the current price"` / `"This contract settles at expiry"`). Empty: `No open positions.` |
| **History** | <sm position rows; ≥sm table head `Symbol, Ticket, Time, Type, Volume, Price, Close, Profit`. Empty: `No closed trades yet.` / `Sign in to see your trade history.` |
| **News** | Live RSS list (time · source chip · title · summary), links open in a new tab. Empties: `Newswire unavailable ({error}).`, `Loading news…`, `No news.` |
| **Mailbox** | Server notifications (level dot, title, time, body). Empties: `Sign in to read your messages.`, `No messages.` |
| **Alerts** | Add form: symbol label, condition toggle **`Bid ≥`** / **`Bid ≤`** (`title="Fire when the price rises above, or falls below, the level"`), price input (placeholder = current price or `price`), **Add** button, note `Alerts fire while this terminal is open.` Table head `Symbol, Condition, Price, Status, ''`; status `armed` / `fired {time}`; actions **re-arm**, **delete** (`aria-label`s `Lower take profit`-style not used here — plain text links). Empty: `No alerts set.` |
| **Journal** | Timestamped socket events (time · tag · text). Empty: `Journal is empty.` |

### 4.5 `MarketWatch` — `components/game/MarketWatch.tsx` (≥lg only)
Header `Market Watch` + status dot (`title` `Live`/`Syncing`/`Offline`).
`symbols` tab: `{symbol}` bold, `±{pct}% today`, `MT5Price` coloured by last tick direction (blue up / red down), and `Low: {x}` `High: {x}`.
`details` tab rows: **Symbol**, **Last**, **Session open**, **Session high**, **Session low**, **Digits**, **Contract size** (`{money} / lot`), **Session** (`00:00–24:00 UTC`).
Bottom tabs (`aria-pressed`, CSS-capitalised): **symbols** | **details**.

### 4.6 Classic-shell trade controls (`BetPanel`, for contrast)
Stake chips: three ladder values from `lib/game/stakeLadder` + a **Custom** chip (`aria-expanded`). Custom field: currency chip + `aria-label="Stake amount in {currency}"` + `−` (`aria-label="Decrease stake"`) / `+` (`aria-label="Increase stake"`), step 50 KES. `Segmented label="Duration"` with `10s / 30s / 1m / 2m`. Buttons **BUY** (green, up arrow) and **SELL** (red, down arrow). Hints: `Min {x}`, `Maximum stake is {x}.`, `Connecting…`. With a position open: `LivePnl` + **Close Trade** / `Closing…` / `Closes at expiry`, or `Settles automatically when the timer ends`.

### 4.7 Digits-shell trade controls (`DigitsTradeScreen`, for contrast)
Trade-type tabs **Matches/Differs · Even/Odd · Over/Under** (+ **Multipliers** on demo) plus `aria-label="All trade types"` grid button and the desktop link `All trade types`. Chart toolbar: `aria-label="Zoom"` (`1T/2T/5T/10T`), `VolatilitySelector`, share % chip, `aria-label="Positions"`, drawing tools `Line chart`, `Area chart`, `Draw a horizontal line` / `Click the chart to draw a line`, `Download chart`, zoom `Zoom in`, `Show all`, `Zoom out`, `Back to live price (clears drawn lines)`, `Back to live price`. Console: `Trading mode` label, `Bal {x}`, **AUTO / MANUAL** segmented, `Select digit` 0–9 grid (`aria-label="Barrier digit {d}"` / `"Prediction digit {d}"`), `Segmented label="Amount"` → **Stake / Payout**, stepper (`Decrease amount` / `Increase amount`, `aria-label="Stake amount"` / `"Target payout"`), preset pills (`aria-label="Stake {q}"`), resolved readout, auto fields **Target**, **Stop loss**, **Mult**, and the two buy cards (`aria-label="Buy {side}: pays {x} ({pct}%)"`) plus **Stop** (`aria-label="Stop auto trading"`). Toasts: `Enter a stake`, `Trade in progress`, `Log in to trade`, `No payout at this barrier`, `Not connected` / `Reconnecting…`, `Target hit`, `Stop loss hit`, `Balance too low`, `Stake below minimum`, `Auto stopped`, `Demo refilled`, `Balance refilled`, `Could not refill`. In-chart flash badges `WON +x` / `LOST −x`.

---

## 5. How the terminal shell is selected

Three independent switches, all brand-data driven. None is a user setting except `InterfaceMode`.

**(a) `brand.chartStyle`** — `lib/brand/brand.ts`, from the API `GET /site/brand?host=` → the DB `sites.chart_style` column. Values: `line | area | candlestick | bars | baseline`. Default `line`.
`packages/shared/src/chart.ts`:
```ts
chartStyleOf(v)            // unknown → "line"
tradingViewTypeOf(style)   // candlestick→"candles", line→null, else the style itself
```
So **`tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null`** ⇔ the brand is a *terminal brand* ⇔ anything except `line`.

**(b) `marketerSkinOn`** — `lib/marketer/skinPolicy.ts`:
```ts
const NEUTRALISE_SHARED_UI = false;
marketerSkinOn(isMarketerRole, playerBasic) =
  (NEUTRALISE_SHARED_UI && isMarketerRole) || playerBasic
```
With the flag off, the "basic" skin is turned on **only** by the per-device player preference `useInterfaceMode() === 'basic'` (zustand + localStorage key `pp-interface-mode`, default `classic`, set by the gear menu). Marketer role no longer forces it. `useMarketerSkin()` (`lib/marketer/isMarketer.ts`) returns that value as `isMarketer`.

**(c) `isTerminalScreen`** — `lib/ui/terminalScreen.ts`:
```ts
isTerminalScreen(terminalBrand, isMarketer) = terminalBrand && !isMarketer
```
`useTerminalSkin()` (`lib/ui/useTerminalSkin.ts`) is the one-liner wrapper that every call site should use.

**(d) `brand.tradeUi`** — `'classic' | 'digits'`, default `classic`. Read in `TradeSurface` and `AppShell`. Overridable on `/` by `?ui=digits` / `?ui=classic`, persisted to localStorage `pp:tradeUi` (preview override, checked *before* the brand value in `TradeSurface`, though `AppShell` reads only `brand.tradeUi` — so a `?ui=digits` override gives the digits screen inside the *standard* shell).

**(e) `TERMINAL_ROUTES`** — `new Set(['/history', '/account', '/wallet', '/dashboard'])` + `isTerminalRoute(pathname)`.

### Resulting matrix

| Conditions | Shell on `/` | Shell on `/history`, `/account`, `/wallet`, `/dashboard` |
|---|---|---|
| `brand.tradeUi === 'digits'` | **Digits shell**: `DigitsTopBar` + `DigitsTradeScreen` + `DigitsBottomNav`; mounts `PositionsSheet`, `TransactionHistoryModal`, `HowToTradeModal`, `MarketerHUD`, `MT5Drawer` | Standard centred shell (`TopBar` + `Footer` + `BottomNav`) — unless the brand is *also* candlestick, in which case the MT5 branch wins |
| `chartStyle !== 'line'` **and** mode ≠ basic | **MT5 terminal**: `h-dvh`, no `Footer`, no `BottomNav` (returns null), blue `TopBar` with hamburger → `MT5Drawer`; `MarketWatch` + `CandleChart` + `MT5Toolbox` + `MT5OrderTicket` | **MT5 full-bleed**: `MT5History` / `MT5Settings` / `MT5Funds` / `MT5TitleBar "Dashboard"` |
| `chartStyle !== 'line'` **and** mode = basic | Locked-viewport classic trade frame (`isTrade` branch, `terminal=true` gutters) but the *screen* falls back: `PriceHeader`+`TickerStrip` hidden only when `terminal`, so basic gets them; `BetPanel` instead of the MT5 ticket; `CandleChart` still renders (GameCurve keys off `tvType` only, not the skin) | Standard centred shell with `Footer` |
| `chartStyle === 'line'` (the default) | **Classic wave shell**: `TopBar` + `PriceHeader` + `TickerStrip` + `CurveCanvas` + `BetPanel` + `BottomNav` + `LiveChatLauncher` | Standard centred shell + `Footer` |

Notes / inconsistencies worth knowing before the rebuild:
- `AppShell`'s `isTrade` branch computes `terminal` from `chartStyle` **alone** (no marketer/basic check), while `TradeSurface` and `BottomNav` apply `!isMarketer`. A basic-skin player on a candlestick brand therefore gets terminal *gutters and no bottom nav* with a classic *panel*.
- `BottomNav` calls `useLiveChatUnread()` **after** an early `return null` — a conditional hook (React rules-of-hooks violation, currently masked because `mt5` is stable per brand).
- `MT5Drawer` is mounted in all four `AppShell` branches but self-gates on `useTerminalSkin()`.
- `?preview=marketer` (`lib/marketer/isMarketer.ts`) forces the marketer *skin* for anyone, persisted in `sessionStorage` key `pp:previewMarketer`; `?preview=off|player` clears it. Presentation only.

---

## 6. Screens / components that are clearly NOT MT5-shaped

**Celebration / gambling / emoji / marketing:**
- `components/game/OutcomeOverlay.tsx` — confetti canvas, gold/green palettes, 160-particle bursts, count-up, money-chip flight into the balance pill, haptic fanfares, `pp-pop`/`pp-shake` animations, headlines **BIG WIN / YOU WON / WIN / SO CLOSE / NO WIN**, button **Collect**. (Has an MT5 escape hatch to `MT5CloseNotice`, so only the classic shell sees it.)
- `components/game/WelcomeBonusOverlay.tsx` — **no MT5 branch at all.** Confetti, `+{amount}` count-up, rounded-2xl gold-glow card, CTA `Deposit {x}+ & play`, `Later`. File header documents the intent explicitly: "endowment effect … goal-gradient … Zeigarnik".
- `components/game/digits/DigitResultModal.tsx` — trophy icon, **YOU WON!**, glow shadows, pop/shake, rounded-full contract pill.
- `components/game/LivePnl.tsx` — `rounded-full` pill `BUY · ×1.95`, "Live P&L", coloured `rounded-full` progress bar. (The MT5 ticket deliberately uses `MT5LivePosition` instead; see that file's header comment.)
- `components/game/TickerStrip.tsx` — fabricated scrolling crypto marquee with a red `LIVE` badge. Pure decoration; "NOT real market data".
- `components/wallet/PayBillDeposit.tsx` — `📲` emoji, green gradient card.
- `components/marketer/MarketerDashboardView.tsx` — emoji glyphs `🎵 📶 💵 📱 🚕 🧾` for `TikTok promo`, `Data bundles`, `Advance payment`, `Airtime`, `Transport`, `Other`.

**Gambling / betting language in player UI:**
- `components/wallet/HistoryTabs.tsx` — tab literally labelled **"Bets"**.
- `components/positions/PositionHistory.tsx` — `No bets yet`, `Couldn't load bet history.`, `Won ×1.95` / `Lost` / `Void`.
- `app/legal/page.tsx` — "real-money trade-prediction game", "Responsible Gaming", helpline 1190, BCLB licence.
- `components/layout/Footer.tsx` — `18+` pill, "Trading involves real money and risk. Only stake what you can afford to lose.", `Helpline 1190`.
- `app/affiliate/page.tsx` — "earn 20% of the net revenue", perk cards "Up to 25% commission", "no misleading or non-compliant gambling ads".
- `app/r/[code]/view.tsx` — "18+ only. Play responsibly, learn more".

**Layouts with no MetaTrader equivalent at all:**
- The entire **digits shell** — `components/game/digits/**` (16 files, 2,700+ lines) + `components/layout/DigitsTopBar.tsx`, `DigitsBottomNav.tsx`, `DigitsAccount.tsx`. A Deriv clone: last-digit heatmap circles, volatility-index picker with favourite stars, Multipliers panel with deal cancellation, Auto-trading with Target/Stop-loss/Mult martingale fields, and an **"AI Entry Scanner"** (`EntryScanner.tsx`) behind a purple-gradient floating `AI` button with a robot avatar and a scan progress bar. Nothing here maps to MT5.
- `app/affiliate/page.tsx` + `components/marketer/MarketerDashboardView.tsx` + `ReferralCommissionsCard.tsx` + `components/account/ReferralInviteCard.tsx` — affiliate funnel, payout requests, advance requests. No MT5 counterpart.
- `app/dashboard/page.tsx` — gets MT5 *chrome* (`MT5TitleBar title="Dashboard"` + tokens) wrapped around a non-MT5 body.
- `app/legal/page.tsx` — sticky TOC reading column.
- `app/r/[code]/page.tsx` / `view.tsx` — referral landing.
- `app/offline/page.tsx` — rounded-xl Retry button.
- `components/account/AccountDialogs.tsx` — accent-gradient dialog headers, `rounded-2xl`/`rounded-xl` throughout, dashed-border file-drop rows.
- `components/wallet/AccountSwitcher.tsx` + `AccountMenu.tsx` — `rounded-full` balance pill with a `rounded-full` R/D disc and a `rounded-2xl` 280px card. (Hidden on terminal brands, but it is still the live control on every `line` brand.)
- `components/game/BetPanel.tsx` — `rounded-xl` stake chips, `rounded-xl` Custom field, Segmented duration control.
- `components/wallet/WalletWidget.tsx` — `rounded-full` wagering progress bars.
- `components/layout/Footer.tsx`, `ThemeToggle.tsx`, `CurrencySwitcher.tsx` — site chrome with no terminal analogue.
- `components/support/SupportWidget.tsx` — an AI support chat with "Request a callback", `Add an email or phone so we can reach you.` **Dead code, never imported.**
- `components/settings/PnlColorToggle.tsx` — "Profit / loss colours", `Brand (mono)` / `Classic`, `green ▲ / red ▼`. **Dead code, never imported.**
- `components/ui/*` — the whole primitive set is soft-cornered by default (`--pp-radius: 12px` from `DEFAULT_BRAND.themeTokens`). `MT5_TOKENS` re-points it to `2px` plus an `mt5-square` class, which is how the money forms get squared without being rewritten.

**Borderline — MT5 chrome over non-MT5 substance:** `MT5Funds.tsx` (its own header admits "MetaTrader has no deposit screen … this is the one screen in the conversion with no original to copy"), the `Expiry` row on `MT5OrderTicket`, the `T/P` steppers (MT5 uses a price, this uses a profit amount), and the single-price Buy/Sell pair (MT5 shows bid and ask).
