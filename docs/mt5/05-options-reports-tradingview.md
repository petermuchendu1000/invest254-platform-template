# Factual research report: MT5 auxiliary screens (Part A) + TradingView UI conventions (Part B)

**Method note.** Everything below was taken from live pages fetched on 2026-10-05. Where a label is in quotes it is copied verbatim from the cited page. Where I could not verify something I say so explicitly rather than guessing. MT4 is excluded throughout.

**Primary sources used repeatedly (full URLs):**
- `https://www.metatrader5.com/en/terminal/help/startworking/settings`
- `https://www.metatrader5.com/en/terminal/help/startworking/acc_open`
- `https://www.metatrader5.com/en/terminal/help/startworking/authorization`
- `https://www.metatrader5.com/en/terminal/help/startworking/interface`
- `https://www.metatrader5.com/en/terminal/help/trading/performing_deals`
- `https://www.metatrader5.com/en/terminal/help/trading/report`
- `https://www.metatrader5.com/en/terminal/help/trading_advanced/history_report`
- `https://www.metatrader5.com/en/terminal/help/trading/depth_of_market`
- `https://www.metatrader5.com/en/terminal/help/trading/market_watch`
- `https://www.metatrader5.com/en/terminal/help/algotrading/testing_report`
- `https://www.mql5.com/en/docs/constants/environment_state/accountinformation`

---

# PART A — MetaTrader 5

## A1. The Options dialog (Tools → Options, Ctrl+O)

Source for everything in this section: `https://www.metatrader5.com/en/terminal/help/startworking/settings`

**Important correction to the brief.** The current help page lists **twelve** tabs, not eight. Verbatim from the page ("All settings are grouped in several tabs based on what they do"), in page order:

`Server` · `Charts` · `Trade` · `Expert Advisors` · `GPU` · `Events` · `Notifications` · `Email` · `AI Assistant` · `MCP` · `Community` · `Signals`

(The tab is labelled **Trade** in the list; its section heading on the page reads "Trading".)

### Server tab — exact field labels
- `Server` — "the name of the trade server the platform connects to… specify here the domain name (or IP address) of the server and connection port number separated by a colon. For example: 192.168.0.1:443."
- `Certificate` — "click here to view the details of the certificate… The button only appears if the extended authentication mode is used on the server"
- `Login`
- `Password`
- `Change` — opens the password-change dialog
- `Enable proxy server` (checkbox) — "If you enable this option, button "Proxy ..." becomes active"
- `Proxy` (button)
- `Keep personal settings and data at startup` (checkbox)
- `Enable news` (checkbox)
- `News languages` — with an `Edit` button; the language dialog has `Auto Select`, `Add`, `Remove`, `Reset`

**Password Change sub-dialog** (same page): `Login` (read-only), `Current password`, `Change master password`, `Change investor password`, `New password`, `Confirm`, `OK`.
Password rules verbatim: "no shorter than the length requirement displayed in the password change dialog"; "must contain four character types: lowercase letters, uppercase letters, numbers, and special characters (#, @, ! etc.). For example, 1Ar#pqkj"; "must not match the previous password."

**Proxy sub-dialog:** `Server` (IP:port, plus a type selector offering `HTTP`, `SOCKS4`, `SOCKS5`; "In HTTP mode, NTLM authentication is also supported"), `Login`, `Password`, `Test`.

### Charts tab — exact field labels
`Color print` · `Show trade history` · `Show trade levels` · `Disable dragging of trade levels` · `Enable dragging of trade levels` · `Enable dragging of trade levels with "Alt" key` · `Preload chart data for open positions and orders` · `Show object properties after creation` · `Select objects by single mouse click` · `Precise time scale` · `Select objects after creation` · `Magnet sensitivity` (pixels; 0 disables) · `Max. bars in chart` (minimum value 5000; "For the changes of this parameter to take effect, restart the platform")

### Trade tab — exact field labels
- `Symbol` — options `Automatic`, `Last used`, `Default`
- `Volume` — options `Last Used`, `Default`
- `Deviation` — options `Default`, `Last Used` (page also calls the feature "Use Deviation" / "Use deviation")
- `Stop levels` — options `in points`, `in prices`
- `One click trading` (checkbox) — first use shows a T&C dialog with `I Accept these Terms and Conditions`, `OK`, `Cancel`
- `Show realtime history of deals on chart`

One-click trading is stated to apply to: "the Trading tab in Market Watch", "the quick trading panel on the chart", "the Trade tab in the Toolbox window", "Depth of Market".

### Expert Advisors tab — exact field labels
`Allow Auto Trading` · `Disable automated trading when switching accounts` · `Disable automated trading when switching profiles` · `Disable automated trading when switching chart symbols or period` · `Disable automatic trading through the external Python API` · `Allow DLL imports (potentially dangerous, enable only for trusted applications)` · `Allow WebRequest for listed URL` (with a URL list; "To delete an address from the trusted list, select it and press "Delete"")

### GPU tab
No labelled form fields documented. Per-device information shown: "Supported OpenCL version", "Available memory", "Support for the double type in calculations", "Performance rating".

### Events tab
One checkbox: `Allow`. Then a table of event names with sound files. Event names verbatim:
`Connect` · `Disconnect` · `Email Notify` · `Timeout` · `Ok` · `News` · `Expert Advisor` · `Alert` · `Requote` · `Trailing Stop` · `Testing Finished`
"To change a file played when the event occurs, double-click on its name or select it and press "Enter". Then select "Choose other" from the drop-down list."

### Notifications tab
- `Enable Push Notifications` (checkbox) + MetaQuotes ID field — "You can specify up to 4 MetaQuotes IDs separated by commas."
- `Notifications from the local terminal`
- `Notifications from the trade server`
- `Test` button

### Email tab
`Enable` · `SMTP server` (format `"[server web address] : [port number]"`, e.g. "smtp.mail.ru:25", "smtp.gmail.com:465") · `SMTP login` · `SMTP password` · `From` · `To` · `Test` button. "Only one email address may be specified for either of fields "From" and "To"."

### AI Assistant tab / MCP tab
The page lists these tabs ("AI Assistant — settings for the built-in AI Assistant", "MCP — settings for MetaTrader MCP servers") but gives **no field list**. **I could not verify the field labels on the AI Assistant or MCP tabs.**

### Community tab
`Login` · `Password`, plus a `register` link that opens a quick-registration window taking a username and e-mail with a `Register` button. The tab also hosts checkboxes to disable unused MQL5 services ("uncheck the relevant options in the settings to hide these sections") — **the individual service-checkbox labels are not spelled out on the page, so I could not verify them.**

### Signals tab
Name of the current subscription is shown at the top; "If there is no subscription, the settings below are uneditable."
`Agree to the terms of use of the Signals service` · `Enable realtime signal subscription` · `Copy Stop Loss and Take Profit levels` · `Synchronize positions without confirmations` · `Use no more than [A] %` · `Stop if equity is less than [B]` · `Deviation/Slippage [C] spreads`

---

## A2. Account login / "Open an Account" and "Login to Trade Account"

### "Open an Account" wizard
Source: `https://www.metatrader5.com/en/terminal/help/startworking/acc_open`

Opened from: "Click " Open an Account" in the File menu or in the context menu of the Navigator window."

**Step 1 — "Select a Server".** "A broker is selected during the first step. If the desired company is not shown in the list, please type its name and click "Find your broker". Alternatively, you can type the address of the server instead of the company name. Once you find the desired company, select it and click "Next"." Companies can be removed with the Delete key.

**Step 2 — "Account Type".** Three radio choices. The help describes them but gives the prose, not the literal radio captions, for the first two; the third is quoted literally as `Open a real account for live trading`:
1. connect to an existing trading account — "You will need to specify the account number, the password and the server name."
2. open a demo account — "All trading operations only involve virtual money."
3. request opening of a real account — the page later says: "Choose the option "Open a real account for live trading""
**I could not verify the literal radio-button captions for options 1 and 2.**

**Step 3 — "Personal Details" + "Account Parameters"** (verbatim labels):
- `First name` — "consisting of at least two characters"
- `Second name` — "the second name (surname)… at least two characters"
- `Email` — "e.g. "smith@company.net""
- `Phone` — "contact phone number in international format. Example: +74951234567"
- `Use hedge in trading` — "Otherwise an account with the netting system will be opened. The option affects account types available for selection."
- `Account Type` — dropdown
- `Deposit` — "the initial deposit in the basic currency. Selected from a drop down list."
- `Currency` — "this field cannot be edited"
- `Leverage` — "Select one of the available variants from the drop down list."
- A consent checkbox for the broker's agreements + data-protection policy, then `Next`.

**Step 4 — "Account Registration" (what MT5 shows after creating/connecting):**
- `Login` — "the number of the opened account"
- `Password` — "This is a master password, which allows trading from this account"
- `Investor` — "The password allows connecting to the account to view its state and analyze price dynamics, but it does not allow trading"
- A QR code: "Open the mobile application, go to the "New account" section and click "Sign In with QR code"."
- `Finish` → "the newly created account is automatically connected to the trade server. It also appears in the Accounts section of the Navigator window." `Cancel` → account is created but not connected or added to Navigator.

**Navigator account icons:** "— a demo account, — a preliminary account, — a live account." Contest accounts "are marked with a blue icon"; "When you are connected to such an account, the "Contest account" title is displayed in the platform window header."

For live accounts the broker may additionally request "information on employment, income and trading experience… such account opening requirements apply to MiFID regulated brokers".

### "Login to Trade Account" dialog
Source: `https://www.metatrader5.com/en/terminal/help/startworking/authorization`

Opened from: "Click " Login to Trade Account" in the File menu or in the Navigator."

Fields, verbatim:
- `Login` — "the number of the account used for connection"
- `Password` — "the master or investor password for the account"
- `Server` — "server to connect to. Also you can indicate a server manually. Enter its IP address and port number as [server number]:[port number], for example, 192.168.0.1:443."
- `Save password` (checkbox) — "the next time you start the platform, the last used account will be automatically connected to the server"
- `OK`

Access modes: "Two types of account access are available in the trading platform: master and investor. Logging in using the master password gives full rights… Investor authorization allows you to see the account status, analyze prices, and work with your own Expert Advisors, but not trade."

**Forced password change** on authorization is supported ("Forced password change can be enabled by the trade server administrator"), with the same four-character-type rules; "If the master password is changed forcedly, the investor password of the account is also reset."

**After connecting**, per `.../startworking/interface`: "The platform header contains information about the current account number, application name, as well as the active chart name and its timeframe," and "The status bar contains additional details: server connection indication, the name of an active template and profile, as well as command prompts and price data."

---

## A3. Account-information surfaces, labels and formatting

### Where it is shown
Source: `https://www.metatrader5.com/en/terminal/help/trading/performing_deals`

The account state is shown as a summary line in the **Toolbox → Trade tab**, under the heading "Trading account state:". Verbatim labels and definitions:

| Label | Official definition |
|---|---|
| `Balance` | "money on the account, results of currently open positions not included (deposit)" |
| `Credit` | "amount of credit money that the broker has given to a trader" |
| `Assets` | "the current value of purchased financial instruments (of long positions) defined in a trader's deposit currency" |
| `Liabilities` | "obligations on current short positions calculated as the value of these positions at the current market price" |
| `Commission` | "commission by orders and positions accumulated during a day/month" |
| `Blocked` | "profit taken during a day [that] cannot be used to perform trade operations (is not included in the free margin)" |
| `Equity` | "**Balance + Credit - Commission +/- Floating profit/loss - Blocked**" |
| `Margin` | "money required to cover open positions and pending orders" |
| `Free Margin` | "the free amount of money that can be used to open positions. It is calculated as **Equity - Margin**" |
| `Margin Level` | "percentage of the account equity to the margin volume (**Equity / Margin * 100**)" |
| `Total of deals` | "total financial result of all open positions" |

"The account state line is highlighted with the red color, if the account is in the Margin Call or Stop Out state."

A second surface is the **alert/email template** the same page documents, which uses the shorter labels: `Login`, `Balance` ("current account balance"), `Equity` ("current account equity"), `Profit` ("current profit value"), `Margin` ("current margin value"), `Free margin` ("current free margin value"), `Positions`, `Orders`.

The **Exposure** tab holds "summary information about the state of assets of all open positions".

### Formatting
- **The % on margin level:** margin level is defined as a percentage (`Equity / Margin * 100`) in the help, and MQL5 defines `ACCOUNT_MARGIN_LEVEL` as "Account margin level in percents" (`https://www.mql5.com/en/docs/constants/environment_state/accountinformation`). **The literal rendering (e.g. whether MT5 prints "1 234.56 %" with a space, and to how many decimals) is not documented — I could not verify it.**
- **Decimals:** MQL5 exposes `ACCOUNT_CURRENCY_DIGITS` — "The number of decimal places in the account currency, which are required for an accurate display of trading results" (same URL). So the decimal count for money figures is a per-account server property, not a fixed 2. **The desktop terminal's exact formatting string is not documented — I could not verify it.**
- **Currency:** `ACCOUNT_CURRENCY` is "Account currency" (a string). The help consistently uses the phrase "in the deposit currency". **I could not verify from official docs whether the Trade-tab summary line appends the currency code to each figure.**

### Leverage
Leverage appears as an **input field in the "Open an Account" wizard** ("`Leverage` — ratio between borrowed and owned funds for trading"), and is available programmatically as `ACCOUNT_LEVERAGE`. **I could not verify, from MetaQuotes' official help, a terminal surface that displays the current account's leverage as a labelled read-only field** (the help's description of the platform header and status bar does not mention it).

---

## A4. Reports / Statement

There are **two distinct report artefacts** in current MT5, and the brief's metric list belongs to the second one. This distinction matters.

### A4a. "Trading Report" — View → Reports, or History context menu → `Report \ Overview`
Source: `https://www.metatrader5.com/en/terminal/help/trading/report`

This is the newer interactive report. **Tabs (section headings), verbatim:** `Summary` · `Profit/Lost` (spelled that way in the tab list; the section heading is "Profit/Loss") · `Long/Short` · `Symbols` · `Risks`.

Export: each tab's description ends with "**Save report as HTML or PDF**" — i.e. **HTML or PDF, not XLSX**, for this report.

Metrics by tab, verbatim labels:
- **Summary:** `Gross Profit`, `Gross Loss`, `Dividends`, `Swaps`, `Commissions`, `Balance`, `Equity`, `Account status diagram`, `Sharpe Ratio`, `Profit Factor`, `Recovery Factor`, `Max. Drawdown`, `Max. Deposit Load`, `Trades per Week`. Balance/Equity graphs toggle to a `Growth` mode.
  - `Profit Factor` = "The ratio of total profit to total loss. The value of 1 means that the amount of profits is equal to the amount of losses."
  - `Recovery Factor` = "the ratio of the absolute profit to the maximum drawdown"
  - `Max. Deposit Load` = "Margin/Equity*100"
- **Profit/Loss:** `Profit`, `Dividends`, `Swaps`, `Loss`, `Commissions`, `Profit to loss ratio`, `Profit/Loss`, `Gross Profit`, `Gross Loss`; plus distribution by day of week and by source ("manual trading, signal copying, robot trading").
- **Long/Short:** `Long`, `Short`, `Long to Short ratio`, `Deals graph`, `Trading Robots`, `Trading Signals`, `Netto P/L`, `Average P/L` (money), `Average P/L` (percent), `Commissions`, `Average Profit` (money), `Average Profit` (percent), `Trades`, `Win Trades` (count), `Win Trades` (percent).
- **Symbols:** `Symbols`, `Distribution of deals by symbols`, `Deal Details by Sector`, `Deal Details by Symbol`, `Trading Robots`, `Trading Signals`, `Manual Trading`, `Deal Details by Type`, `Profit Factor by Symbols`, `Netto Profit by Symbols`, `Fees by Symbols`.
- **Risks:** `Balance`, `Drawdown/Deposit Load`, `Best/Worst trade`, `Max. consecutive wins/losses` (count), `Max. consecutive wins/losses` (money), `MFE`, `Avg. Profit`, `MAE`, `Avg. Loss`, `MFE/MAE graph`.

### A4b. The account **statement** — History tab context menu → `Report`
Source: `https://www.metatrader5.com/en/terminal/help/trading_advanced/history_report`

"HTML reports are generated from a template **ReportHistory.htm**, located in the /Templates folder of the platform."

**Section/block headings, verbatim:** `Header` · `Orders` · `Deals` · `Positions` · `Working Orders` · `Summary` · `Details`

- **Header:** "The name of a brokerage company", "Account number", "The name of the account owner", "Deposit currency", "Report generation date".
- **Deals** block footer: `Recorder profit/loss (Closed P/L)` (sic — typo for "Recorded" is in the official page).
- **Positions** block footer: `Floating profit/loss (Floating P/L)`.
- **Summary:** `Credit Facility`, `Floating P/L`, `Balance`, `Equity`, `Margin`, `Free Margin`, `Margin Level` ("percentage of the account equity to the margin volume (Equity / Margin * 100)").
- **Details:** balance graph ("the number of deals is displayed along the X axis") followed by the statistics list below.

**Statistics listed in the `Details` block — exact labels, in page order:**
`Gross Profit` · `Gross Loss` · `Total Net profit` · `Profit Factor` · `Expected Payoff` · `Balance Drawdown Absolute` · `Balance Drawdown Maximal` · `Balance Drawdown Relative` · `Total trades` · `Short Trades (won %)` · `Long Trades (won %)` · `Profit Trades (% of total)` · `Loss trades (% of total)` · `Largest profit trade` · `Largest loss trade` · `Average profit trade` · `Average loss trade` · `Maximum consecutive wins ($)` · `Maximum consecutive losses ($)` · `Maximal consecutive profit (count)` · `Maximal consecutive loss (count)` · `Average consecutive wins` · `Average consecutive losses`

Note the exact casing/spelling quirks: "Total Net profit", "Total trades", "Loss trades (% of total)".

Drawdown formulas, verbatim:
- `AbsoluteDrawDown = InitialDeposit - MinimalBalance`
- `MaximumDrawDown = Max[Local High - Next Local Low]` — "The maximal drawdown value in percentage is given in brackets."
- `RelativeDrawdown = Max[(Local High - Next Local Low)/Local High * 100)]` — "The maximal drawdown value in monetary terms is given in brackets."
Worked example on the page: initial deposit 5000 → Absolute Drawdown = 5000 − 4000 = 1000; Relative Drawdown = (6000 − 4000)/6000 × 100 = 33.3%; Maximum Drawdown = 8000 − 5500 = 2500 (31.25%).

**Corrections to the brief's list:**
- **`Sharpe Ratio` and `Recovery Factor` are NOT in the account statement.** They appear in the new Trading Report (Summary tab) and in the Strategy Tester report.
- `Profit Factor` is described on the statement page as "the ratio of gross profit and gross loss **in percents**" — wording that conflicts with the Trading Report page's "ratio of total profit to total loss"; I am reporting both verbatim rather than reconciling them.

### A4c. For disambiguation — the Strategy Tester report
Source: `https://www.metatrader5.com/en/terminal/help/algotrading/testing_report`. This report adds metrics absent from both of the above: `Equity Drawdown Absolute/Maximal/Relative`, `AHPR`, `GHPR`, `Recovery Factor`, `Sharpe Ratio` ("calculated as (Return – Risk-Free Rate)/Standard Deviation of Return. In the strategy tester, the Risk-Free Rate is assumed to be zero"), `LR Correlation`. If the brief's metric list was meant to include Sharpe Ratio in one single screen, this is the screen it belongs to.

### A4d. HTML vs XLSX
**Could not verify officially.** The official pages document only (a) HTML from `ReportHistory.htm` for the statement and (b) "Save report as HTML or PDF" for the Trading Report. The `Report → Open XML (MS Office Excel 2007)` / `HTML (Internet Explorer)` submenu labels appear only in third-party guides (e.g. `https://proea.app/en/blog/how-to-export-mt5-trade-history`, `https://mytradingjournal.io/guides/export-import-mt4-mt5-history`), **not in MetaQuotes' own help**. I would not treat those exact menu strings as verified for the current build.

---

## A5. Depth of Market and Symbol Specification

### Depth of Market
Source: `https://www.metatrader5.com/en/terminal/help/trading/depth_of_market`

Opened from: "click " Depth of Market" in the context menu of the Market Watch". "The number of bids and offers displayed in the DOM is determined by the symbol parameters set by the broker."

**Field/column labels the official page actually names — this is a short list:**
- `Trade` column — holds the buy/sell click targets, and displays existing orders and stop levels as abbreviations: `BL` ("Buy Limit order"), `TP` ("Take Profit"), `SL` ("Stop Loss")
- `vol` field — order volume
- `sl` field
- `tp` field
- The volume column header shows the active Time & Sales filter value

**I could not verify a complete labelled row/column list for the DOM grid** (e.g. literal "Volume"/"Price" header captions) — the official page documents the grid only through its screenshots and describes it in prose.

Order-placement geometry, verbatim: "To place a Buy Limit order, click in the Bid price area. To place a Buy Stop order, click in the Ask price area. To place a Sell Limit order, click in the Ask price area. To place a Sell Stop order, click in the Bid price area." Deleting a level/order: "hover the mouse cursor over the button… and click Shift… Click the button to delete".

**Toolbar buttons** (icons; the page gives only their functions, not captions): show/hide tick chart; show/hide Time & Sales; "binding the Market Depth to an active chart"; "switch to the advanced mode; every step of the price will be displayed… regardless of whether there are any offers at this price"; "show the spread"; show/hide Bid and Ask price charts; show/hide transactions (circles); zoom in; zoom out.

**Time & Sales:** "blue is used for Buy trades, pink for Sell trades, green means undefined direction". CSV export via `Export Ticks to CSV`; the CSV header is verbatim `Time,Bid,Ask,Last,Volume,Type`. Tick chart: "Red circles show Sell transactions. Blue circles show Buy transactions. Green circles appear when the direction of the transaction is undefined." Context menu has a `Synchronize` command.

### Symbol Specification dialog
Source: `https://www.metatrader5.com/en/terminal/help/trading/market_watch` (section "Viewing Symbol Specification"). Opened from: "click " Specification" in the context menu of the Market Watch window."

**Complete field list, verbatim labels in page order:**
`Symbol name and description` · `ISIN` · `Spread` (in points; "floating" if floating) · `Digits` · `Stops level` · `Contract size` · `Margin currency` · `Profit currency` · `Calculation` (values: `Forex`, `Forex No Leverage`, `Futures`, `Exchange Futures`, `Exchange Stocks`, `FORTS Futures`, `Collateral`) · `Chart mode` (`Last` or `Bid`) · `Tick size` · `Tick value` · `Trade` (`full access`, `long only`, `short only`, `close only`, or prohibited) · `Execution` (`Instant`, `Request`, `Market`, `Exchange`) · `Type of orders` (`Good till today including SL/TP`, `Good till canceled`, `Good till today excluding SL/TP`) · `Filling` (`Fill or Kill`, `Immediate or Cancel`, `Book or Cancel`, `Return`) · `Expiration` (`Good till Canceled`, `Intraday`, `Specified time`, `Date`) · `Orders` (`market, limit, stop, stop-limit, Stop Loss and Take Profit`) · `Minimal volume` · `Maximal volume` · `Volume step` · `Volume limit` · `Swap type` (`In points`, `In the base currency`, `In the margin currency`, `In the deposit currency`, `As a percentage of current price`, `As a percentage of the open price`, `In points, re-open at Close price`, `In points, re-open at the Bid price`) · `Swap long` · `Swap short` · `Swap rates` · `First trade` · `Last trade` · `Face value` · `Accrued interest` · `Category` · `Exchange` · `CFI` · `Sector` · `Industry` · `Country` · `Option type` · `Underlying` · `Strike price`

Then three further blocks: `Commission`, `Sessions`, `Spreads`.
- `Commission` example rendering, verbatim from the page: `Commission | Instant, volume, entry/exit deals` / `0 - 10 | 1.2 USD per deal` / `11 - 20 | 1.1 USD per loat` (the "loat" typo is in the source).
- `Sessions`: "information about quoting and trading sessions of the symbol. Sessions are specified for every day of the week."

**Margin sub-section** (same page): `Initial margin`, `Maintenance margin`, `Hedged margin`, plus a table whose calculation-type header is `Notional value` or `Floating: ****`, with columns `Initial` and `Maintenance`. Caveat verbatim: "The margin is calculated based on the instrument price at the time the specification window opens and is not updated in real-time. Therefore, the values should be considered indicative."

### Bonus — Market Watch "Details" statistics (adjacent surface, same page)
`Bid` · `B. High` · `B. Low` · `Ask` · `A. High` · `A. Low` · `Last` · `L. High` · `L. Low` · `Volume` · `V. High` · `V. Low` · `Deals` · `Deals Volume` · `Turnover` · `Open Interest` · `Buy Orders` · `Buy volume` · `Sell Orders` · `Sell Volume` · `Open Price` · `Close Price` · `Average Weighted Price` · `Settlement Price` · `Daily Change` · `Delta` · `Theta` · `Gamma` · `Vega` · `Rho` · `Omega` · `Sensitivity`
Quote colouring in Market Watch: "Blue — the current price is higher than the previous one; Red — the current price is lower than the previous one; Gray — the price has not changed for the last 15 seconds."

---

## A6. Notifications / push behaviour

Sources: `https://www.metatrader5.com/en/terminal/help/startworking/settings`; `https://www.metatrader5.com/en/mobile-trading/android/help/push`; `https://www.metatrader5.com/en/mobile-trading/android/help/messages`; `https://www.metatrader5.com/en/releasenotes/terminal/2199`

### MetaQuotes ID
- "During installation of MetaTrader 5 for Android, a unique identifier called MetaQuotes ID is assigned to each user. This identifier is used like a phone number. Knowing it, various applications can send messages to the user." (`.../android/help/push`)
- Where to find it: "To find your MetaQuotes ID, open the "Messages" page in the mobile version of the platform." (`.../android/help/messages`)
- Desktop: "Check the "Enable Push Notifications" box and specify the MetaQuotes ID from your mobile platform. You can specify up to 4 MetaQuotes IDs separated by commas. Push notifications will be sent to all devices simultaneously."
- Mobile-side receiving setting is also named `MetaQuotes ID` — "your unique identifier for receiving messages" — plus a `Mute notifications` option.
- Also set on MQL5.community under "Settings — Security".

### The two notification sources, verbatim
- `Notifications from the local terminal` — "the platform will automatically send notifications about all successful trade operations… The platform will also send notifications about any balance operations performed on the account as well as about the Margin Call state (in this case notifications are sent periodically, as long as the account is in the Margin Call state). The platform will not send notification about unsuccessful operations (for example, if the order was rejected due to incorrect parameters)."
- `Notifications from the trade server` — "the trader does not need to keep the platform constantly running. Notifications are sent from the broker's server. For example, if a Take Profit triggers on the server while your computer is turned off, you will receive a relevant position closing notification on your mobile device." "The availability and details of notifications depend on the broker. **Three notification types are supported: orders, deals and balance operations.**" On enabling, the platform log shows verbatim: `'1222': subscribed to deals, orders, balance notifications from trade server`

Server-side notifications were introduced in build 2980 (`https://www.metatrader5.com/en/releasenotes/terminal/2199`), which also states they require a **real** account (not demo) and broker support.

### Delivery and limits
- "Push notifications are received by the device, regardless of whether the MetaTrader 5 application is running or not. All that is needed is the mobile Internet." "Push messages are displayed in the notification center of your device. The entire history of push notifications is stored in MetaTrader 5 for Android."
- Rate limit, verbatim: "no more than 1 message per 0.5 second and no more that 10 messages per minute."
- Programmatic sending: `SendNotification` in MQL5; alerts can also use push as a notification type via Toolbox → Alerts.
- `Test` button in the Notifications tab: "Click on the "Test" button to test the delivery of push notifications."

### What a closed-position push actually contains
**I could not verify this.** MetaQuotes' documentation says only that you "will receive a relevant position closing notification" and that the three supported types are orders, deals and balance operations; it never prints the message body. I checked the help pages, the build-2980 release notes, the MQL5 forum thread on closed-position push notifications (`https://www.mql5.com/en/forum/64972`) and the MQL5 article on push-notification monitoring (`https://www.mql5.com/en/articles/15346`) — none shows the native format. Strings circulating online of the form `2013.08.12 15:13:20 EURUSD Close Sell 0.10 at 1.32800, Magic: 17, (Profit: 10.00 USD), Balance: 1010.00 USD (Equity: 1010.00 USD)` come from **third-party MQL5 Market products** (e.g. NotifyMe) that call `SendNotification` with their own text, not from MT5 itself. Do not treat that as MT5's native wording. The page also explicitly says "The availability and **details** of notifications depend on the broker", so the body is not fixed platform-wide.

---

# PART B — TradingView

**Primary sources:**
- `https://www.tradingview.com/support/solutions/43000746464-getting-started-with-supercharts/`
- `https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/`
- `https://www.tradingview.com/support/solutions/43000703407-chart-types-available-on-tradingview/`
- `https://www.tradingview.com/support/solutions/43000764138-tradingview-strategy-report-how-to-start/`
- `https://www.tradingview.com/charting-library-docs/latest/ui_elements/Price-Scale/`
- Production assets: `https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js` and the CSS/JS bundles served from `https://www.tradingview-widget.com/static/bundles/embed/`

## B1. The left drawing toolbar

Source: `https://www.tradingview.com/support/solutions/43000746464-getting-started-with-supercharts/` — "Starting from the top, each icon represents a drawing tool category".

**Groups, in documented order, verbatim:**
1. `Cursors` — "Choose the cursor type that will help you better navigate your charts."
2. `Trend tools` — "Select lines, channels, or pitchforks to mark movement directions and price levels."
3. `Gann and Fibonacci tools` — "Automatically build levels based on Fibonacci formulas and Gann theory."
4. `Patterns` — "Access Elliott waves to mark highs, lows, distances between them and identify market cycles."
5. `Forecasting and measurement tools` — "Gauge chart distances, predict price movement, and evaluate trading positions."
6. `Geometric shapes` — "Use brushes, arrows, and other classic shapes like rectangles and curves."
7. `Annotation tools` — "Add text notes directly to the chart."
8. `Icons` — "Add emojis and stickers. Switch between groups using the tabs at the bottom of the menu."

**Below the categories, in documented order:**
`Measure` · `Zoom in` · `Magnets` · `Keep drawing` · `Lock all drawings` · `Hide options` · `Sync drawings options` · `Remove options`

Note: the same help page elsewhere uses "Trend line tools" in one phrasing; the enumerated list uses `Trend tools`. I am reporting the enumerated list.

## B2. The top chart toolbar

Source: same Getting-started page, section "The top toolbar", documented order:

`Symbol search` ("Click the symbol name" or "Start typing the symbol") → `Data type switcher` (gives access to "Technical indicators rating", "Seasonals", "News", "Trading ideas published by other users") → `Compare symbols` → `Chart interval` ("from one second to months") → `Chart type` ("you can choose from 20+ chart types") → `Indicators, metrics, and strategies` (sub-sections `Technicals`, `Fundamentals`, `Strategies`, `Store`; plus `indicator templates`) → `Alerts` → `Bar replay` → `Undo and Redo buttons` → `Chart layouts` ("In the layout setup menu, you can configure the number and placement of charts… rename your chart, share and copy it, export data, create a new layout, or open one of previously saved layouts") → `Quick search` → `Settings` → `Take a snapshot` → `Trade` ("connect to Paper Trading and the integrated brokers") → `Publish`

Note vs the brief: **TradingView does not document a separate "templates" button on the top toolbar.** Indicator templates live inside the Indicators menu; chart-settings templates live in the Settings dialog's `Template` tab (see B4).

### Chart type names
Source: `https://www.tradingview.com/support/solutions/43000703407-chart-types-available-on-tradingview/`. These are the names as the article lists them (it writes them as "… charts"; the UI menu labels drop the word "charts", e.g. the menu reads "Heikin Ashi", and **I could not verify the literal menu captions from an official page**):

- **Price-based:** `Renko`, `Line break`, `Kagi`, `Point and figure`, `Range`
- **Line family:** `Line`, `Line with markers`, `Step line`, `Area`, `HLC area`, `Baseline`
- **Bar family:** `Bar`, `High-low`, `Range bar`
- **Japanese/candles family:** `Candlestick`, `Hollow candlestick`, `Volume candlestick`, `Heikin Ashi`
- **Indicator-based:** `Volume footprint`, `Session volume profile (SVP)`, `Time price opportunity (TPO)`
- **Other:** `Column` ("economic indicators such as GDP, interest rates, or inflation rates are presented as a consecutive array of green and red columns")

## B3. Right panel and bottom panel

**This is where the brief is out of date.** Per the official Getting-started page, the screener, Pine Editor and strategy report are **not** a bottom tab bar any more.

### Right toolbar (documented order, verbatim)
"Here you can access watchlists, news, alerts, and other products in the Overlay sheet via the Products menu at the bottom. Starting from the top, you can access:"

`Watchlist, details, and news` · `Alerts` · `Object tree and data window` · `Screeners` ("Open and switch between TradingView screeners to browse markets without leaving your chart") · `Pine Editor` · `Calendars` · `News Flow` · `Portfolio` · `Fundamental Graphs` · `Yield Curves` · `Options` · `Macro Maps` · `Community feed` · `Notifications` · `Help Center`

So: watchlist/details/news are one stacked right-panel item (`Watchlist, details, and news`); the **Stock Screener and Pine Editor are right-toolbar items**, not bottom-panel tabs.

### Bottom panel (documented)
"Here, you can switch between intervals, set the time zone, and customize the price scale." Contents:
- preset time ranges under the time scale ("Selecting 1D, for example, adjusts the chart to display one trading day using one-minute intervals. Pressing "All" displays all available historical data using monthly intervals"), plus a `Go to` menu for a specific date or custom range
- `Time zone settings` ("To match the time to the relevant trading exchange, select "Exchange."")
- a gear button that "opens the price scale settings"

### Strategy tester
It **does** appear in the bottom panel, but as a report attached to a running strategy rather than a permanent tab. Source: `https://www.tradingview.com/support/solutions/43000764138-tradingview-strategy-report-how-to-start/` — "When selected, the Strategy Report will open at the bottom of the screen"; "Only one strategy can run on a chart at a time." Its tabs: `Metrics` and `Performance analysis` (which "includes 5 independent tabs", of which the page names `Breakdown` and `Periodical`). Metrics tab fields: `Equity chart`, `Date range`, `Total P&L`, `Max drawdown`, `Profitable trades`, `Profit factor`, `Buy&hold`, `Trades run-up&drawdown`. **I could not verify the names of the remaining three Performance-analysis tabs.**

## B4. Price scale and time scale interactions

### Documented behaviour
Source: `https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/`, section "More price scale settings":
- `Reset price scale` — "automatically adjusts the price line to the screen size, and turns on the **Auto** mode, which fits data to your screen"
- `Scale price chart only` — "will disable scaling of indicators or other chart elements"
- Inverting: "By inverting the scale, you change the relation of assets" (worked example with AAPL)
- Then "four types of price scales": `Regular` · `Percent` · `Indexed to 100` · `Logarithmic`
  - `Regular` — "A linear scale that uses absolute values in price changes… The distance between $40 and $80 on such a scale would be the same as between $400 and $440."
  - `Percent` — "A linear scale that uses percentage values in price changes… Each price change here is represented by a fixed distance from the chart's starting point."
  - `Indexed to 100` — "perfect for comparing completely different values… The first value here on the chart is set to 100. To calculate the following values, we add the percentage change of each symbol relative to the first value to 100."
  - `Logarithmic` — "an exponential scale that uses percentage changes in price… spacing between $40 and $80 would be ten times larger than between $400 and $440, because it would represent 100% and 10% increases respectively." Caveat on the page: "turning off logarithmic scale returns the chart to the regular price scale even if the previously chosen was Percent or Indexed to 100."
- Then left/right placement, and a `Labels and Lines` section.
- Autoscale: "To adjust chart data to screen, enable the **Auto** button located on the price scale." (`https://www.tradingview.com/support/solutions/43000762826-how-to-enable-autoscale/`)
- Price-to-bar ratio lock is documented as a **Scales and lines** setting, not quoted as a context-menu item: the "Price scale" section lets you "Set the currency and unit visibility, scales mode, **price to bar ratio lock**, and scales position."

### Corrections to the brief's menu list
- The documented scale-mode name is **`Percent`**, not "Percentage".
- **I could not verify the literal strings "Auto (fits data to screen)", "Lock price to bar ratio" or "Invert price scale"** as context-menu captions from any official TradingView page. The help page phrases these as `Reset price scale` / the `Auto` button / "price to bar ratio lock" / "inverting the scale". The Advanced Charts library docs (`https://www.tradingview.com/charting-library-docs/latest/ui_elements/Price-Scale/`) document the library's price-scale context menu with these captions instead: `Move scale to left/right`, `Invert scale`, `Reset price scale`, `Pin to scale`, plus a `Plus` button; "the Reset price scale option will not appear in the context menu with adjustments such as moving the scale to the left or switching to logarithmic mode."
- From TradingView's **production chart bundle** served to the public advanced-chart widget (`https://www.tradingview-widget.com/static/bundles/embed/…js`), the internal action identifiers and `statName` values confirm the action set but the visible captions are localisation IDs, so the English strings are not extractable. Verified internal names: `ChartPriceScaleToggleAutoScale`, `ChartPriceScaleToggleInvertPriceScale` (hotkey `Modifiers.Alt + 73`, i.e. **Alt+I**), `ScalePriceChartOnly`, `ChartScalesReset` (hotkey `Modifiers.Alt + 82`, i.e. **Alt+R**), `ChartTimeScaleReset` (hotkey `Mod+Alt+81`, i.e. **Ctrl/Cmd+Alt+Q**), and undo-command strings `"invert scale"`, `"toggle auto scale"`, `"toggle lock scale"`, `"toggle percentage scale"`, `"toggle regular scale"`, `"toggle indexed to 100 scale"`, `"scale price chart only"`. This independently confirms the eight behaviours the brief lists (regular / percentage / indexed-to-100 / log / auto / lock / invert / price-chart-only) exist as discrete toggles.
- **Drag to scale and double-click to reset: I could not verify either gesture from an official TradingView page.** The official docs describe scaling only via the `Auto` button, `Reset price scale`, and the Alt+R / Ctrl+Alt+Q hotkeys above. "You can open the scale settings by simply clicking on the scale with the right mouse button" is attested (`https://in.tradingview.com/support/solutions/43000480183-price-scale-settings-are-gone-from-the-bottom-toolbar/`).

### Settings dialog tabs
Source: `https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/`. Access: "find the gear button on the upper toolbar or at the bottom of the chart. You can also double-click on the price line or bars".

**Tabs, verbatim, in page order:**
`Symbol` · `Status line` · `Scales and lines` · `Canvas` · `Trading` · `Alerts` · `Events` · `Template`

Sub-sections documented:
- `Scales and lines` → `Price scale`, `Price labels and lines`, `Time scale` ("display weekdays, choose date and hours format, and also pin chart to the left when changing intervals")
- `Canvas` → `Chart basic styles` (background solid/gradient; grid "vertical only, horizontal only, vertical and horizontal together, or none"; `Pane separator`; `Crosshair`; `Watermark`), `Scales`, `Buttons` (navigation buttons, pane buttons), `Margins`
- `Trading` → `General` (buy/sell buttons, `Instant order placement`, `Play sound for executions`, `Notifications` with `Rejection only` / `All events`), `Appearance` (`Positions`, `Profit & loss`, `Reverse button on hover`, `Orders`, `Brackets profit & loss`, `Executions`, `Execution labels`, `Extended price line`, `Orders and position alignment`, "Orders, Executions, and Positions on screenshots")
- `Alerts` → `Alert lines`, `Only active alerts`, `Alert volume`, `Automatically hide toasts` ("so the pop-up alert notifications will hide automatically after 20 seconds")
- `Events` → `Ideas`, `Dividends`, stock splits, `earnings`, `Earnings break`, latest news, `News notifications`
- `Symbol` → per-chart-type appearance plus a `Data modification` section (session, futures contract changes, dividends, precision, timezone)

Note: the `Canvas` naming is current as of this page; older TradingView documentation and third-party write-ups call this tab "Appearance" or "Background". Treat `Canvas` as the current label.

## B5. TradingView dark theme palette

This is the item where I can give you *some* first-party hex values but must be explicit about what is and is not TradingView's actual dark chart theme.

### Verified from TradingView's own production assets

**Brand blue accent — `#2962FF`.** Taken directly from TradingView's own public widget loader, `https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js`, which contains verbatim:
```
const i={"color-cold-gray-300":"#B2B5BE","color-brand":"#2962FF","color-brand-hover":"#1E53E5","color-brand-active":"#1848CC"}
```
Corroborated by the design-token scale in TradingView's production CSS (`https://www.tradingview-widget.com/static/bundles/embed/…css`): `--color-tv-blue-500:#2962ff`, with `-600:#1e53e5`, `-700:#1848cc`, `-400:#3179f5`, `-300:#5b9cf6`, `-200:#90bff9`, `-100:#bbd9fb`, `-50:#e3effd`.

**Up / down candle colours — `#089981` (up) and `#f23645` (down).** From the same production CSS token set: `--color-minty-green-500:#089981` and `--color-ripe-red-500:#f23645`, used by the semantic tokens `--color-border-primary-success:var(--color-minty-green-500)` / `--color-border-primary-danger:var(--color-ripe-red-500)` and the positive/negative overlay tokens (`--color-overlay-positive-1-light:#08998126`, `--color-overlay-negative-1-light:#f2364533`). Neighbouring steps: green `#22ab94` (−400), `#42bda8` (−300), `#70ccbd` (−200), `#ace5dc` (−100); red `#f7525f` (−400), `#f77c80` (−300), `#faa1a4` (−200), `#fccbcd` (−100).

**Dark-theme UI chrome tokens**, from the `[data-theme=dark]` block of the same production CSS, resolved through the `--color-cold-gray-*` scale (also in that file):

| Semantic token | Scale ref | Hex |
|---|---|---|
| `--color-bg-primary` | cold-gray-850 | `#1f1f1f` |
| `--color-bg-primary-hover` | cold-gray-800 | `#2e2e2e` |
| `--color-bg-secondary` | cold-gray-900 | `#0f0f0f` |
| `--color-bg-highlight` | cold-gray-900 | `#0f0f0f` |
| `--color-text-primary` | cold-gray-200 | `#dbdbdb` |
| `--color-text-secondary` | cold-gray-450 | `#8c8c8c` |
| `--color-border` | cold-gray-750 | `#3d3d3d` |
| `--color-divider` | cold-gray-700 | `#4a4a4a` |
| `--color-divider-line-primary` | cold-gray-750 | `#3d3d3d` |
| `--color-divider-secondary` | cold-gray-800 | `#2e2e2e` |

Full cold-gray scale from that file: `50:#f9f9f9` · `100:#f2f2f2` · `150:#ebebeb` · `200:#dbdbdb` · `250:#c9c9c9` · `300:#b8b8b8` · `350:#a8a8a8` · `400:#9c9c9c` · `450:#8c8c8c` · `550:#707070` · `600:#636363` · `650:#575757` · `700:#4a4a4a` · `750:#3d3d3d` · `800:#2e2e2e` · `850:#1f1f1f` · `900:#0f0f0f` · `950:#000`.

Caveat: these are TradingView's **current neutral-gray UI chrome** tokens, i.e. panels, toolbars, popups and borders. They are **not** the chart canvas background, and they are **not** the older blue-tinted values (`#131722`, `#1e222d`, `#2a2e39`, `#b2b5be`) that circulate widely. I searched TradingView's production CSS and 27 of its JS bundles for `131722`, `0d0e12`, `1e222d` and `2a2e39` and found **zero occurrences**, so the widely-cited blue-grey set appears to be legacy. `#B2B5BE` does still exist as `color-cold-gray-300` in the widget loader's legacy map, which is probably why it persists in third-party palettes.

### Could not verify
- **The chart canvas background and grid-line hex values for TradingView's dark theme.** The Advanced Charts "Theme" page (`https://www.tradingview.com/charting-library-docs/latest/customization/theme/`) says only "The library supports dark and light themes… The default value is light" and publishes no hex values. The "CSS Color Themes" page (`https://www.tradingview.com/charting-library-docs/latest/customization/styles/CSS-Color-Themes/`) gives only a deliberately-pink illustrative example and is marked as legacy. The chart engine bundle that would hold `paneProperties.background` dark defaults is loaded dynamically and was not reachable from the widget page. **I could not verify these officially.**

### Documented Lightweight Charts values (adjacent, often mistaken for the TradingView palette)
From TradingView's own Lightweight Charts API reference — these are **library defaults for the light theme**, not TradingView.com's dark theme:
- `CandlestickStyleOptions` (`https://tradingview.github.io/lightweight-charts/docs/api/interfaces/CandlestickStyleOptions`): `upColor` default `'#26a69a'`; `downColor` default `'#ef5350'`; `borderColor` `'#378658'`; `borderUpColor` `'#26a69a'`; `borderDownColor` `'#ef5350'`; `wickColor` `'#737375'`; `wickUpColor` `'#26a69a'`; `wickDownColor` `'#ef5350'`
- `LayoutOptions` (`https://tradingview.github.io/lightweight-charts/docs/api/interfaces/LayoutOptions`): `background` default `{ type: ColorType.Solid, color: '#FFFFFF' }`; `textColor` default `'#191919'`; pane `separatorColor: '#2B2B43'`, `separatorHoverColor: 'rgba(178, 181, 189, 0.2)'`
- `GridLineOptions` (`https://tradingview.github.io/lightweight-charts/docs/api/interfaces/GridLineOptions`): `color` default `'#D6DCDE'`
- The library's dark-theme **tutorial** (`https://tradingview.github.io/lightweight-charts/tutorials/customization/chart-colors`) uses illustrative values `background: { color: '#222' }`, `textColor: '#DDD'`, grid `vertLines`/`horzLines` `color: '#444'`, and a series `color: '#2962FF'`. These are tutorial examples, not TradingView.com's theme.

---

## Summary of everything I could not verify
1. MT5 Options → `AI Assistant` and `MCP` tab field labels.
2. MT5 Options → `Community` tab: the individual MQL5-service hide/show checkbox labels.
3. The literal radio-button captions for the first two choices in the "Open an Account" → Account Type step.
4. Whether MT5 has a labelled read-only surface showing the connected account's **leverage** (it is an input in account opening and an MQL5 property).
5. MT5's exact numeric formatting for balance/equity/margin/margin level in the UI (decimals, currency placement, literal "%" rendering). `ACCOUNT_CURRENCY_DIGITS` means the decimal count is server-defined.
6. The `Report → Open XML (MS Office Excel 2007)` / `HTML (Internet Explorer)` submenu labels — attested only in third-party guides, not MetaQuotes docs. Officially documented export formats are HTML (via `ReportHistory.htm`) for the statement, and HTML or PDF for the new Trading Report.
7. A complete labelled column list for the MT5 Depth of Market grid.
8. The actual body text of an MT5 push notification about a closed position. The online example string with "Close Sell 0.10 at 1.32800, Magic: …" is from a third-party MQL5 Market EA, not MT5.
9. TradingView: the literal UI menu captions for chart types (I have the help-article names).
10. TradingView: literal price-scale context-menu captions "Auto (fits data to screen)", "Lock price to bar ratio", "Invert price scale"; and the drag-to-scale / double-click-to-reset gestures.
11. TradingView: the names of three of the five `Performance analysis` tabs in the Strategy Report.
12. TradingView: the chart canvas background and grid hex values for its dark theme.