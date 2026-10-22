# Free, licence-clean market data and symbol reference data — verified specification

Researched 2026-10-05 from each provider's own terms of service, licence files and API
documentation, with several endpoints called live from this machine to confirm limits and
payloads. Every claim carries a source. Where a term could not be read at its primary source
this document says so rather than guessing, and those gaps are listed in "Could not verify" at
the end.

**This is a licensing document, not a shopping list.** The technical question ("can I get the
bytes?") and the legal question ("may I show them to my users?") have different answers for
almost every source below, and the gap between them is where the risk lives.

---

## The headline answers

1. **TradingView has no free public market-data API, and its terms forbid exactly what we want
   to do.** Its own support page says so; its Terms of Use Section 3 licenses data for
   "exclusive display-only use" and bars redistribution for compensation. What *is* free from
   TradingView is **charting software you feed your own data into** — Lightweight Charts
   (Apache 2.0) and Advanced Charts (proprietary, free with branding). Neither is a data feed.
2. **There is no free, licence-clean source of redistributable intraday FX or metals prices.**
   None. Every free FX source we verified is either end-of-day only (ECB), key-limited and
   non-redistributable (open.er-api.com, exchangerate.host), or personal-use-only (Alpha
   Vantage, Finnhub, Twelve Data, Marketstack, Massive/Polygon). XAUUSD and the other metals
   benchmarks require a paid ICE Benchmark Administration licence. **If the product shows live
   FX or gold to end users, that line item costs money.** This is the single most important
   finding in this document.
3. **Crypto is the one asset class with a genuinely free, commercially usable, redistributable
   feed: CoinGecko's Demo API** — 10,000 calls/month, attribution required, and its API terms
   expressly say *"You are entitled to charge for your services and products that incorporate
   or integrates our CoinGecko API."* Binance's public endpoints are technically open but its
   ToS prohibits "data feeding or streaming services" without written consent.
4. **ECB euro reference rates are the only FX prices we found that are unambiguously free to
   redistribute commercially** — ECB copyright permits free use if reproduced accurately with
   the ECB cited as source. But they are **one print per working day, ~30 currencies, EUR base,
   no OHLC, and no KES** (verified live — see §4.1).
5. **Symbol/reference metadata is the easy half.** FIGI identifiers are dedicated to the public
   domain, GLEIF LEI data is CC0, ISO 4217 is free from SIX, ISO 10383 MICs are free to
   download, `exchange_calendars` is Apache-2.0 and CCXT is MIT. A symbol catalogue can be
   assembled with near-zero licensing risk.
6. **Polygon.io has rebranded to Massive.** `polygon.io/terms` and `polygon.io/pricing` both
   301-redirect to `massive.com`, and the pricing page identifies the company as
   **Massive.com, Inc.** Any existing note in our docs referring to "Polygon.io" should be
   updated.

---

## 1. TradingView — the definitive answer

### 1.1 Is there a free, public, documented market-data API a third party may use?

**No.** TradingView says so itself, in a support article titled *"I need access to your API in
order to get data or indicator values"*:

> *"We don't have an API that gives access to data as of now, but we are planning to add it in
> the future."*

The same article states that the REST API TradingView does publish is **for brokers** who want
to be supported on the TradingView platform — it is an order-routing and account integration
spec, not a quote source.
([support article](https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/))

TradingView's three developer-facing APIs are the **Charting Library API**, the **Datafeed
API** and the **Broker REST API**. All three are interfaces *you* implement or call against
*your own* backend. None of them hands you prices.

### 1.2 What the Terms of Service actually say

All of the following is from **Section 3, "Ownership of information; license to use
TradingView; redistribution of data; non-display usage"** of the Terms of Use at
[`tradingview.com/policies`](https://www.tradingview.com/policies/), verbatim:

> *"The content and market data provided on the TradingView platform, including but not limited
> to charts, alerts, webhooks, and any other forms of information, are licensed for exclusive
> display-only use."*

> *"Our agreements with Data Providers strictly forbid the sublicensing, assigning,
> transferring, selling, loaning, or any distribution of TradingView content, including market
> data, for any form of compensation."*

> *"Except as otherwise expressly permitted by separate agreement, we do not permit commercial
> usage of any of our services or APIs."*

On non-display use — which is what a server-side price cache, an alert engine or a risk
calculation is:

> *"Such prohibited uses include, but are not limited to, any form of automated trading,
> automated order generation, price referencing, order verification, algorithmic
> decision-making, algorithmic trading, smart order routing…"*

And explicitly aimed at third-party tooling of the kind an integrator might build:

> *"We expressly forbid direct non-display usage by our users, as well as the development,
> offering, or utilization of any third-party products, tools, or services designed to
> facilitate or enable such non-display usage…"*

> *"…it is hereby explicitly prohibited for any third party to create, offer, or operate any
> product or service"* that enables those prohibited activities.

Note **"price referencing"** in the non-display list. Reading a TradingView price in order to
drive anything in our own system is itself called out, before redistribution even enters the
picture.

### 1.3 What IS free from TradingView

| Product | Licence | Cost | Supplies data? |
|---|---|---|---|
| **Lightweight Charts™** | **Apache License 2.0** — `Copyright 2023 TradingView, Inc.` | Free | **No** |
| **Advanced Charts** (formerly Charting Library) | **Proprietary** | Free *with* TradingView branding; removing branding is paid | **No** |
| **Trading Platform** | Proprietary | Paid | **No** |
| `charting-library-examples` repo | **MIT** | Free | No |

Sources: the [LICENSE file](https://raw.githubusercontent.com/tradingview/lightweight-charts/master/LICENSE)
in the lightweight-charts repo (Apache 2.0, verbatim header *"Apache License / Version 2.0,
January 2004"*); the
[free charting libraries page](https://www.tradingview.com/free-charting-libraries/), which
lists Lightweight Charts as `Apache 2.0 / Open source / Free` and Advanced Charts as
`Proprietary`, "Free with TradingView logo", with "Ability to disable branding" gated behind
paid access; the
[charting-library-examples LICENSE](https://github.com/tradingview/charting-library-examples/blob/master/LICENSE) (MIT).

**Lightweight Charts carries an attribution obligation on top of Apache 2.0**, stated in the
repo README verbatim:

> *"This license requires specifying TradingView as the product creator. You shall add the
> 'attribution notice' from the NOTICE file and a link to https://www.tradingview.com/ to the
> page of your website or mobile application that is available to your users."*

> *"You can use the `attributionLogo` chart option for displaying an appropriate link to
> https://www.tradingview.com/ on the chart itself, which will satisfy the link requirement."*
> ([repo](https://github.com/tradingview/lightweight-charts))

**These are charting tools you supply your own data to — this is TradingView's own framing**,
from the Advanced Charts FAQ, verbatim:

> *"Advanced Charts is a chart with your data. This is a standalone solution that you download,
> host on your servers, and connect your data to."*

> *"The library is intended to display data from a server, not a file."*

> *"You can use it in your site/app for free."* — against the Trading Platform, which *"has its
> own licensing fees associated with it."*
> ([FAQ](https://www.tradingview.com/charting-library-docs/latest/getting_started/Frequently-Asked-Questions/))

**UDF = Universal Data Feed.** It is a REST contract the Advanced Charts library will call
(`/config`, `/symbols`, `/history`, …) against **a server you write**. The docs' own words:
*"you can provide data in another format or use a WebSocket to transfer it, but in this case
you need a custom Datafeed API implementation."* UDF is a shape for *our* data, not a source
of TradingView's.

The Advanced Charts licence is the **"Free Advanced Charts Agreement"**
([PDF](https://s3.amazonaws.com/tradingview/charting_library_license_agreement.pdf)). Its terms
are summarised elsewhere as granting a "worldwide, non-exclusive, non-transferable,
non-sublicensable right" for public implementations with attribution retained — **but the PDF
is a scanned image and we could not extract its text to quote. Treat the agreement's exact
wording as unverified** (see "Could not verify" #1) and read it before shipping Advanced
Charts.

### 1.4 Conclusion, in one sentence a non-lawyer can act on

> **Use TradingView's chart *code* (Lightweight Charts, Apache 2.0, with the attribution link)
> and plug our own licensed data into it — never take prices, quotes or indicator values from
> TradingView itself, because their terms license data for display-only use, forbid
> redistribution for compensation, and forbid commercial use of their services or APIs
> outright.**

---

## 2. Crypto exchange APIs

### 2.1 Binance public REST / WebSocket

**Technically the most open feed we tested; legally the most awkward.**

| | |
|---|---|
| Covers | Crypto spot (and futures on separate hosts) |
| API key | **Not needed.** Verbatim: *"These URLs do not require any authentication (i.e. The API key is not necessary) and serve only public market data."* |
| Market-data-only hosts | REST `https://data-api.binance.vision`, WebSocket `wss://data-stream.binance.vision` |
| Rate limits | **`REQUEST_WEIGHT` 6 000 per 1 minute; `RAW_REQUESTS` 300 000 per 5 minutes** |
| Historical OHLC | **Yes** — `/api/v3/klines`, `/api/v3/uiKlines`; plus bulk dumps at `data.binance.vision` |
| Symbol metadata | **Yes** — `/api/v3/exchangeInfo` gives `tickSize`, `stepSize`, precisions |
| **Redistribution** | **Prohibited without written consent** |

Rate limits and metadata are **live-verified from this machine on 2026-10-05**, by calling
`https://data-api.binance.vision/api/v3/exchangeInfo?symbol=BTCUSDT`. The response's
`rateLimits` array returned exactly `REQUEST_WEIGHT / MINUTE / 1 / 6000` and
`RAW_REQUESTS / MINUTE / 5 / 300000`, and the `BTCUSDT` symbol object returned
`PRICE_FILTER tickSize 0.01000000`, `LOT_SIZE stepSize 0.00001000`, `baseAssetPrecision 8`.
Endpoint list and the no-key statement:
[Market Data Only](https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only).

The blocking clause is **Binance Terms of Use section III.1.b**:

> *"Without written consent from Binance, the following commercial uses of Binance data are
> prohibited:
> 1. Trading services that make use of Binance quotes or market bulletin board information.
> 2. Data feeding or streaming services that make use of any market data of Binance.
> 3. Any other websites/apps/services that charge for or otherwise profit from (including
>    through advertising or referral fees) market data obtained from Binance."*

A trading terminal that streams Binance prices to its users is item 2, and if it monetises at
all it is also item 3. **⚠ Caveat on provenance:**
[`binance.com/en/terms`](https://www.binance.com/en/terms) renders its body in JavaScript and
returns only chrome to every fetch tool and `curl` invocation we tried, and the official
`bnbstatic` consolidated PDF is CID-encoded and would not extract. The wording above is quoted
**identically** by two independent citations of that URL —
[Superalgos issue #1019](https://github.com/Superalgos/Superalgos/issues/1019), which cites it
as §III.1.b.iv, and a search index which cites it as §III.1.b.4. **Read it at source before
relying on it** (see "Could not verify" #2).

### 2.2 Coinbase

**Prohibited. The hardest "no" of any crypto venue.**

Coinbase publishes a dedicated **[Market Data Terms of Use](https://www.coinbase.com/legal/market_data)**
(which returned HTTP 403 to our fetch — see "Could not verify" #3). Its substance, as indexed:

- Use of the Market Data is **exclusively for personal or research purposes** and may not be
  used to build an application intended for use by end users other than the user or their
  officers/employees.
- Absent prior express written consent, users **may not redistribute, display, or disseminate
  the Market Data** — or any data, charts, analytics, research or other works based on,
  referring to, or derived from it — to any third party outside their organization.
- All rights in the Market Data (copyrights, database rights) are **exclusively the property of
  Coinbase and its partners**.

The Coinbase Developer Platform ToS adds that users may not *collect, cache, aggregate or
store* data accessed via CDP Tools other than as permitted, nor share it with third parties
without prior written authorization
([CDP ToS](https://www.coinbase.com/legal/developer-platform/terms-of-service)).

Public market data endpoints *are* unauthenticated — the CDP docs say *"Market Data APIs
provide market data and are public"* — but technical openness is not a licence.

### 2.3 Kraken

**Ask first; it is a real, answerable question with a named mailbox.**

| | |
|---|---|
| API key | Not needed for public endpoints — *"Public endpoints — no API key needed"* |
| Historical OHLC | Yes, but shallow: *"Returns up to 720 of the most recent entries (older data cannot be retrieved, regardless of the value of `since`)"* ([OHLC endpoint](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data)) |
| Redistribution | **Requires prior permission** |

Verbatim, from Kraken's own API guide: you must seek prior permission for *"any non-personal
commercial use of data from publicly accessible endpoints, such as market data, exchange
status, and any other data"*, and *"You may seek such permission by contacting
marketdata@kraken.com."*
([docs-legacy global intro](https://docs-legacy.kraken.com/api/docs/guides/global-intro/);
the [current docs page](https://docs.kraken.com/api/docs/guides/global-intro/) no longer
carries this paragraph — see "Could not verify" #4.)

### 2.4 Bitstamp

**The only crypto venue that says out loud that commercial redistribution is available.**

From [bitstamp.net/api](https://www.bitstamp.net/api/), under the heading *"Commercial Use of
Bitstamp's Exchange Data"*, verbatim:

> *"Companies seeking to utilize Bitstamp's exchange data for their own commercial purposes are
> directed to contact partners@bitstamp.net to receive and sign a commercial use Data License
> Agreement.*
>
> *Bitstamp allows the incorporation and redistribution of our exchange data for commercial
> purposes. This includes the right to create ratios, calculations, new original works,
> statistics, and similar, based on the exchange data."*

Rate limits, verbatim: *"As standard, all clients can make 400 requests per second. There is a
default limit threshold of 10,000 requests per 10 minutes in place."* Public functions
(tickers, order books, transactions, OHLC, trading pairs) need no authentication; only private
functions need a key.

**The agreement is required, and the page does not say whether it costs anything.** Treat
Bitstamp as "yes, after a signature" — not "yes".

### 2.5 CoinGecko — the best free crypto answer

| | |
|---|---|
| Covers | Crypto prices, market caps, volumes, OHLC, across exchanges |
| API key | Yes — free **Demo** key |
| Free limit | **100 calls/min, 10 000 calls/month** |
| Historical OHLC | Yes |
| **Redistribution to end users** | **Permitted, with attribution; reselling API access is not** |

From the [API Terms of Service](https://www.coingecko.com/en/api_terms), verbatim:

> *"you are not permitted to sell, rent, lease, sub-license, re-distribute or syndicate access
> to the CoinGecko API"*

> *"You are entitled to charge for your services and products that incorporate or integrates
> our CoinGecko API."*

> *"you shall duly attribute ownership of the CoinGecko API to CoinGecko by displaying
> prominently the message 'Powered by CoinGecko' in a legible font (an example of a legible
> font type being 'Arial') no smaller than font size 10."*

> *"You should refresh the cache at least every 24 hours"*

The distinction is the one that matters for us: **you may not resell *access to the API*; you
may charge for *a product that uses it*.** That is exactly a trading terminal. Limits and the
attribution requirement are from the
[API pricing page](https://www.coingecko.com/en/api/pricing), which also links an
[attribution guide](https://brand.coingecko.com/resources/attribution-guide) requiring the
message *"Data provided by CoinGecko"* with a hyperlink.

---

## 3. Vendor free tiers — all five are personal-use-only

Every one of these was checked against its own terms, not its marketing page. Every one of
them fails for a product that shows prices to its own users.

### 3.1 Alpha Vantage — **no**

| | |
|---|---|
| Covers | Equities, FX, crypto, some commodities, indicators |
| Free limit | **25 API requests per day** ([premium page](https://www.alphavantage.co/premium/)) |
| Historical OHLC | Yes |
| Redistribution | **Prohibited — personal, non-commercial only** |

The [Terms of Service](https://www.alphavantage.co/terms_of_service/) (a PDF; text extracted
locally), verbatim:

> *"Alpha Vantage grants the right to install, use, access, display and run the software on any
> computer or mobile device, where applicable, that you own or control, **for personal,
> non-commercial use**, unless you and Alpha Vantage have agreed otherwise in writing…"*

The commercial-use trigger list includes, verbatim, criterion (iii):

> *"You plan to use or provide information accessed through the Alpha Vantage Platform as part
> of any type of commercial activity that allows individuals or entities other than User to
> access information directly or indirectly even if the scope of such activity falls outside of
> the securities industry."*

That sentence describes our product precisely. Also: criterion (ii) catches *"using the Alpha
Vantage Platform as or on behalf of a corporation, firm, partnership, trust or any other
association and not as an individual"*, the EULA grant is *"non-exclusive,
non-sublicensable, non-transferable, non-assignable, revocable"*, and the escape hatch is
*"If you are interested in using the Alpha Vantage Platform for commercial purposes, please
contact us at: premium@alphavantage.co"*.

### 3.2 Twelve Data — **no on free; a paid add-on exists**

| | |
|---|---|
| Covers | US equities & ETFs, FX, crypto; "Global trial symbols" only on free |
| Free limit | **8 API credits/min, 800/day**, plus 8 trial WebSocket symbols |
| Historical OHLC | Yes |
| Redistribution | **Only via a paid Redistribution Rights Add-On** |

From the [Terms](https://twelvedata.com/terms), verbatim:

> *"Redistribute or provide external display of Data only if and as expressly authorized by a
> Redistribution Rights Add-On or separate written agreement with Twelve Data."*

> *"Non-Display Use means any use of Data that does not involve displaying the Data to natural
> persons."*

> *"Internal Use means use solely for Customer's internal business purposes and not for
> redistribution or external commercial purposes."*

and, listed among the prohibitions: *"Use Free Tier data for commercial purposes"* and
*"Store or cache Data beyond permitted timeframes specified in the Documentation"*. On
termination, *"all Data must be deleted within 30 days."*

The [pricing page](https://twelvedata.com/pricing) labels the free Basic plan **"Internal
non-display usage"** — which, read with the ToS definition above, means the free tier may not
be shown to a human outside the company at all.

### 3.3 Finnhub — **no**

| | |
|---|---|
| Covers | US equities, FX, crypto; fundamentals and alternative data |
| Free limit | **60 API calls/minute** (secondary source — see "Could not verify" #5) |
| Historical OHLC | Limited depth on free |
| Redistribution | **Prohibited without written approval** |

From the [Terms of Service](https://finnhub.io/terms-of-service), verbatim:

> *"You hereby agree to not redistribute or share access to data or derived results from the
> data obtained from Finnhub with anyone or any 3rd party without written approval from
> Finnhub."*

> *"All plan listed on Finnhub website is strictly for personal use unless explicitly stated
> otherwise. Personal plan can't be used by any business even internally without a written
> approval."*

> *"All data must be deleted should your subscription to that data ends."*

Note the second quote reaches further than most: **even internal business use** of a personal
plan needs written approval.

### 3.4 Polygon.io → **Massive** — **no on free; paid redistribution plans exist**

**⚠ Polygon.io has rebranded.** `https://polygon.io/terms` returns `301 Moved Permanently` to
`https://massive.com/terms`, and `https://polygon.io/pricing` 301s to
`https://massive.com/pricing`, which identifies the company as **Massive.com, Inc.**

| | |
|---|---|
| Covers | US equities, options, FX, crypto, indices |
| Free "Basic" | **5 API calls/minute, 2 years historical data, "Individual use", "Non-pros only"** ([pricing](https://massive.com/pricing)) |
| Historical OHLC | Yes |
| Redistribution | **Prohibited on individual plans; requires a commercial licence** |

The [Market Data Terms of Service](https://massive.com/terms/market_data_terms.pdf) grant, as
indexed (the PDF would not extract — "Could not verify" #6):

> *"Polygon grants you a nonexclusive, nontransferable, non-sublicensable, revocable, limited
> license to use Market Data exclusively for your personal, non-business, and non-commercial
> purposes."*

> *"The Market Data may not be copied, reproduced, republished, uploaded, posted, publicly
> displayed, encoded, translated, transmitted, or distributed in any way (including
> 'mirroring') to any other computer, server, website, or other medium for publication or
> distribution or for any business or commercial enterprise, without Polygon's express prior
> consent."*

Their own knowledge-base article on redistribution is admirably blunt and is the clearest
statement of the general principle we found anywhere:

> *"Redistribution needs a commercial license, not an individual subscription."*

> *"An individual subscription covers your own use, so the moment data reaches someone else,
> whether that is a customer of your product, a reader of a published chart, or another
> business, it is redistribution and the individual plan does not cover it."*

It lists "showing prices to users of your app or website", "publishing charts or tables" and
"passing data to a client, supplier or partner" as redistribution, and points at
`massive.com/business` for self-serve commercial plans (Stocks, Options, Currencies) or
`sales@massive.com`.
([article](https://massive.com/knowledge-base/article/how-can-i-redistribute-polygons-market-data))

**Read that quote twice. It is the mental model to apply to every source in this document.**

### 3.5 Marketstack — **no**

| | |
|---|---|
| Covers | 2 700+ exchanges, 30 000+ tickers, EOD |
| Free limit | **100 requests/month, EOD only, 1 year history, "Non-Commercial Use"** |
| Historical OHLC | Yes (EOD) |
| Redistribution | **Prohibited — free plan is labelled non-commercial** |

The free plan's own feature list on [marketstack.com/product](https://marketstack.com/product)
carries the line **"Non-Commercial Use"**. `marketstack.com/terms` 301s to
[`ideracorp.com/legal/APILayer`](https://www.ideracorp.com/legal/APILayer) (apilayer is an
Idera company); the operative documents there are a Master SaaS Agreement and Terms of Use
whose text we could not extract — "Could not verify" #7.

---

## 4. Official and open data

### 4.1 ECB euro foreign-exchange reference rates — **yes, redistributable**

**The cleanest FX licence we found, and the most limited data.**

| | |
|---|---|
| Covers | ~30 currencies against EUR. **No KES.** |
| API key | **None** |
| Rate limit | None published |
| Historical | **Yes** — 90-day and full-history XML/CSV, plus SDMX-ML |
| OHLC bars | **No.** One reference print per working day. |
| Redistribution | **Permitted, with conditions** |

Live-verified 2026-10-05: `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`
returned `<Cube time='2026-10-02'>` with `USD 1.1225`, `JPY 176.99`, `CZK 24.470`,
`DKK 7.4736` …

Publication timing, verbatim from the
[reference rates page](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html):
rates are *"usually updated at around 16:00 CET every working day, except on TARGET closing
days"*, derived from *"the daily concertation procedure between central banks across Europe,
which normally takes place around 14:10 CET."*

**The warning on that page matters for a trading product**, verbatim:

> *"The reference rates are published for information purposes only. Using the rates for
> transaction purposes is strongly discouraged."*

The licence, from the ECB's
[disclaimer & copyright page](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html):
copyright in the entire site content is the ECB's, but users may **freely use information
obtained directly from it**, provided that when distributed or reproduced it **appears
accurately and the ECB is cited as the source**; where it is incorporated into documents that
are **sold**, the publisher must inform buyers **before payment and on each access** that the
information is available **free of charge** from the ECB website; and any modification (such
as statistical adjustment) must be clearly identified.

**That "must tell paying buyers it's free from the ECB" clause is a real product obligation**,
not boilerplate. If a paid tier shows ECB rates, it needs that notice.

### 4.2 Frankfurter — **MIT code, pass-through data terms**

| | |
|---|---|
| Covers | *"223 currencies from 104 central banks and official sources"* |
| API key | **None** — *"You don't need an API key."* |
| Rate limit | *"There are no quotas. Requests are rate-limited to prevent abuse, but there are no monthly or daily caps."* |
| Historical | **Yes** — *"rates … update daily and go back to 1948"*; `from`/`to` time series |
| OHLC bars | No |
| Redistribution | **Inherits each upstream provider's terms** |

Live-verified 2026-10-05: `https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD,GBP,KES`
returned `{"amount":1.0,"base":"EUR","date":"2026-10-02","rates":{"GBP":0.85033,"USD":1.1225}}`
— **KES was silently omitted**, matching the ECB's own currency list.

The licence, from [frankfurter.dev/license](https://frankfurter.dev/license/), verbatim:

> *"Frankfurter's code, docs, and Docker images are open source under the MIT License."*

> *"Frankfurter doesn't own the rates, so it can't give you rights the provider doesn't."*

Of its 104 listed sources, roughly 55 have published terms (individually linked) and roughly 49
show **"None published."** Frankfurter also warns that blended calculations are its own work,
not official institutional rates, and that *"Rates can be late, missing, or revised."*

**Practical reading: use Frankfurter for convenience, but attribute and comply with the
upstream source — and if the source is the ECB, §4.1 governs.** Self-hosting is available and
removes the third-party-uptime risk entirely.

### 4.3 exchangerate.host — **no longer the free open API it used to be**

| | |
|---|---|
| Covers | ~168 FX currencies, plus crypto and precious metals |
| API key | **Yes, required** |
| Free limit | **100 requests per month** |
| Historical | Yes — 19 years, EOD, *"available at 00:05 am GMT for the previous day"* |
| Redistribution | Governed by apilayer terms — not established |

From [exchangerate.host](https://exchangerate.host/). Paid plans start *"From $14.99/monthly"*
for *"From 10,000 requests a month"*, with overage fees past 100% of allowance. **If any of
our notes describe exchangerate.host as a keyless unlimited free API, they are out of date.**

### 4.4 open.er-api.com (ExchangeRate-API Open Access) — **explicitly not redistributable**

| | |
|---|---|
| Covers | FX, USD/other bases |
| API key | **None** — *"No API Key"* |
| Update frequency | *"Updates Once Per Day"* |
| Rate limit | Rate-limited; 429 responses block the IP for 20 minutes |
| Redistribution | **Prohibited** |

Live-verified 2026-10-05: `https://open.er-api.com/v6/latest/USD` returned
`"result":"success"`, `"time_last_update_utc":"Mon, 05 Oct 2026 00:02:31 +0000"`, and a
`"terms_of_use"` field pointing at `https://www.exchangerate-api.com/terms`.

From the [free-tier docs](https://www.exchangerate-api.com/docs/free), verbatim:

> *"You're welcome to cache the data we respond with and to use it for either personal or
> commercial currency conversion purposes. You are, however, not allowed to re-distribute
> it."*

Attribution is mandatory, with a specified anchor:
`<a href="https://www.exchangerate-api.com">Rates By Exchange Rate API</a>`.

**The safe reading for a trading terminal is NO.** "Commercial currency conversion" plausibly
covers converting a figure for a user; publishing a live FX rate table to end users is
re-distribution on any natural reading of the word.

### 4.5 Stooq — **could not verify; treat as unusable until read**

`stooq.com` and `stooq.pl` are **unreachable from this environment**. `curl` to
`stooq.com/q/d/l/?s=eurusd&i=d` returned `curl: (35) Recv failure: Connection reset by peer`;
the agent proxy logged `ws_closed_mid_exchange … host stooq.com:443` twice; `stooq.pl/db/h/`
returned HTTP 503. We therefore **cannot quote Stooq's terms at all**, and secondary sources
claiming "any commercial use is prohibited" and "personal use only" are not good enough to
build on. See "Could not verify" #8.

**A source whose terms you cannot read is not a licence-clean source.** Do not ship Stooq data
without reading its terms directly.

### 4.6 Yahoo Finance unofficial endpoints — **plainly a terms breach**

Yahoo retired its public finance API in 2017 and never replaced it. The endpoints that
`yfinance` and similar libraries call are **undocumented internal endpoints of the Yahoo
Finance web app**, reverse-engineered from its own network traffic.

From the [Yahoo Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html),
verbatim:

- **§2(a)(ix)** — *"access or collect data, or attempt to access or collect data, from our
  Services using any automated means, devices, programs, algorithms or methodologies, including
  but not limited to robots, spiders, scrapers, data mining tools, or data gathering or
  extraction tools, for any purpose without our express, prior permission."*
- **§2(a)(x)** — may not use materials to *"create any database, archive, mobile application,
  data feed, widget or any other aggregated data source that competes with or constitutes a
  material substitute for the Services"*
- **§2(e)** — *"Unless otherwise expressly stated, you may not access or reuse the Services, or
  any portion thereof, for any commercial purpose."*
- **§2(h)** — may not *"reproduce, modify, rent, lease, sell, trade, distribute, transmit,
  broadcast, publicly perform, create derivative works based on, or exploit for any commercial
  purposes, any portion or use of, or access to, the Services"*

**§2(a)(ix) prohibits the fetch. §2(a)(x) prohibits the product. §2(e) and §2(h) prohibit the
commerce.** There is no reading of these clauses under which a commercial trading terminal may
pull Yahoo Finance quotes. Technical friction (rotating endpoints, cookie/crumb requirements,
IP blocks) is a symptom, not the problem.

### 4.7 Other genuinely open data

| Source | Covers | Licence position | Useful for us? |
|---|---|---|---|
| **US EIA** | Energy commodities (WTI, Henry Hub, …), free API | *"U.S. government publications are in the public domain and are not subject to copyright protection."* / *"You may use and/or distribute any of our data, files, databases, reports, graphs, charts, and other information products."* Citation requested ([copyright page](https://www.eia.gov/about/copyrights_reuse.php)) | **Yes** — but weekly/daily series, not a price feed |
| **Bank of Canada Valet** | CAD FX and rates | Reproduction incl. commercial permitted: *"You must attribute the Bank of Canada as the source of the content, and indicate if changes were made."* Plus: if provided through paid services, *"you must inform any prospective purchaser, prior to its distribution or sale, that said content was obtained from this website and that such information is available on this website free of charge."* ([terms](https://www.bankofcanada.ca/terms/)) | Niche |
| **BIS** | FX, macro statistics | **Restrictive.** Non-commercial reuse of BIS material allowed if *"the BIS is cited as the source"*; Data Portal statistics are governed by separate "About BIS statistics" terms; no CC licence; BIS retains all IP ([terms](https://www.bis.org/terms_conditions.htm)) | **No** for commercial redistribution |
| **LBMA / ICE Benchmark Administration** | Gold, silver, platinum, palladium benchmarks | **Paid.** *"A licence from IBA is required in order to obtain, use or redistribute real-time or historical benchmark data from that date, including for pricing and valuation activities and in transactions and financial products."* Historical tables moved behind the MyLBMA portal ([LBMA](https://www.lbma.org.uk/prices-and-data/precious-metal-prices)) | **No** — this is why there is no free metals answer |

---

## 5. Symbol / instrument reference datasets — the low-risk half

This is the catalogue problem: instrument names, descriptions, categories, digits, tick sizes,
contract sizes. **It is far more tractable than prices**, because identifiers and venue codes
are published as open data and because conventions (EURUSD has 5 digits and a 100 000 contract
size) are facts about the market, not somebody's copyrighted dataset.

| Dataset | What it gives | Licence | Verdict |
|---|---|---|---|
| **OpenFIGI** (Bloomberg / OMG) | FIGI instrument identifiers + mapping API + related security descriptions | *"Bloomberg Finance L.P. hereby dedicates FIGI Identifiers to the public domain and makes FIGI Identifiers available to the public at large for free"*; *"FIGI Identifiers may be freely reproduced, distributed, transmitted, used, modified, built upon, or otherwise exploited by anyone for any purpose, commercial or non-commercial"* ([ToS](https://www.openfigi.com/docs/terms-of-service)) | **Best-in-class.** ⚠ the dedication is worded around the **identifiers**; "Related Security Descriptions" are supplied AS IS and the dedication language does not obviously extend to them |
| **GLEIF LEI** | Legal-entity names, addresses, status; Golden Copy; ISIN↔LEI and BIC↔LEI relationship files | *"The data on GLEIF's website is provided under a Creative Commons (CC0) license."* ([open data](https://www.gleif.org/en/about/open-data)) | **Yes — CC0, no conditions.** For issuer metadata, not instruments |
| **ISO 10383 MIC list** | Market Identifier Codes, venue names, countries, operating/segment MICs; xlsx/csv/xml/pdf, free | *"Although the material on this site is intended to be used and reproduced freely by all interested users…"* **but** *"You are granted a non-exclusive right to access and use the information on this website excluding the right to reproduce all or substantial part of this website for the purpose of making such reproductions available to third parties."* ([list](https://www.iso20022.org/market-identifier-codes), [terms of use PDF](https://www.iso20022.org/sites/default/files/2020-02/ISO10383_Terms_of_use.pdf), version Oct 2016) | **Yes for internal lookup; do NOT republish the whole table to users.** MIC creation/maintenance is itself *"free of charge"* |
| **ISO 4217** (SIX, Maintenance Agency) | Currency codes, names, minor units; List One / Two / Three in XLS, XML, DOC | *"We maintain the code lists, update them and make them available online and free of charge."* ([SIX](https://www.six-group.com/en/products-services/financial-information/data-standards.html)) — terms of use not stated on the page | **Yes**, with the terms caveat ("Could not verify" #9) |
| **Binance `/api/v3/exchangeInfo`** | Per-symbol `tickSize`, `stepSize`, `minQty`/`maxQty`, base/quote asset, precisions, permitted order types, status | Binance ToS §III.1.b applies (§2.1) | **Technically ideal, legally the same restriction as prices.** Live-verified fields |
| **CCXT** | Unified market metadata across 100+ crypto venues (`loadMarkets`) | **MIT** ([repo](https://github.com/ccxt/ccxt)) | **Yes for the library.** The *data* it fetches still carries each venue's terms |
| **`exchange_calendars`** | Trading sessions, open/close times, breaks, holidays for 50+ exchanges, keyed by ISO-10383 MIC | **Apache-2.0** ([repo](https://github.com/gerrymanoim/exchange_calendars)) | **Yes** |
| **SEC EDGAR `company_tickers.json`** | US issuer names ↔ tickers ↔ CIK | US-Government-created content, free access and reuse; max **10 requests/second**; a declared `User-Agent` header is required (*"User-Agent: Sample Company Name AdminContact@<sample company domain>.com"*) ([webmaster FAQ](https://www.sec.gov/os/webmaster-faq)) | **Yes**, for US equities |
| **Nasdaq Trader symbol directory** | Symbol lists via public FTP `ftp://ftp.nasdaqtrader.com/symboldirectory` | Mixed. Nasdaq Fund Network data: *"The data and information made available for internal non-commercial usage only unless separately licensed from Nasdaq."* Nasdaq Events Data: *"provided as it exists in Nasdaq's records without restriction or any further licensing requirement."* ([page](https://www.nasdaqtrader.com/trader.aspx?id=symbollookup)) | **Per-file. Read each file's notice.** The NFN files are internal-non-commercial only |
| **Our own hand-authored FX/metals catalogue** | Symbol names, descriptions, categories, digits, contract sizes, typical spreads | No third-party licence at all | **The safest option of all**, and for ~60 FX pairs and 4 metals it is a day's typing |

---

## 6. Ranked recommendations

### 6.1 Need 1 — reference / metadata only (static, low risk)

| # | Source | Licence | Why this rank |
|---|---|---|---|
| **1** | **Hand-author the FX / metals / index catalogue ourselves** | none needed | Digits and contract sizes are market conventions. Zero licence, zero dependency, zero rate limit. Do this first |
| **2** | **OpenFIGI** | Public domain (identifiers) | Unrestricted commercial reuse of the identifiers, explicitly stated. The anchor for cross-referencing |
| **3** | **GLEIF** | **CC0** | Cleanest licence in this document. Issuer names, ISIN↔LEI, BIC↔LEI |
| **4** | **`exchange_calendars`** | Apache-2.0 | Sessions and holidays, MIC-keyed, no API, no terms to breach |
| **5** | **ISO 4217 (SIX)** | Free of charge; terms unstated | Currency codes and minor units — i.e. our FX digits. Low risk, small residual doubt |
| **6** | **ISO 10383 MIC list** | Free to use; **bulk republication to third parties excluded** | Perfect for internal venue lookup. Do not ship the table itself |
| **7** | **CCXT** (library) | MIT | Normalises crypto tick/step/precision across venues — but what it fetches is still the venue's data |
| **8** | **SEC `company_tickers.json`** | US Government, free reuse | Only if we list US equities |
| — | **Nasdaq Trader NFN files** | *internal non-commercial only* | **Avoid** unless separately licensed |
| — | **Binance `exchangeInfo`** | Binance ToS restriction | Technically the best crypto metadata; same legal problem as Binance prices |

**Verdict: this need is solved, free, commercially, today.**

### 6.2 Need 2 — live and historical PRICES redistributed to end users (high risk)

| # | Source | Asset class | Redistribution to end users | Cost |
|---|---|---|---|---|
| **1** | **CoinGecko Demo API** | Crypto | **Yes** — charge for the product, attribute "Powered by CoinGecko" ≥10pt, refresh cache ≤24h, don't resell API access | **Free** (10k calls/mo) |
| **2** | **ECB euro reference rates** | FX, ~30 ccy vs EUR | **Yes** — reproduce accurately, cite the ECB, and tell paying buyers it's free from the ECB | **Free** |
| **3** | **Frankfurter** (ECB-sourced subset) | FX | **Yes**, inheriting §6.2 #2's conditions. MIT code, self-hostable, no key, no quota | **Free** |
| **4** | **Bitstamp** | Crypto | **Yes, after signing** a commercial Data License Agreement (`partners@bitstamp.net`) | Unstated |
| **5** | **Kraken** | Crypto | **Only with prior permission** (`marketdata@kraken.com`) | Unstated |
| **6** | **US EIA** | Energy commodities | **Yes** — public domain | **Free** |
| **7** | **Bank of Canada Valet** | CAD FX | **Yes**, with attribution + the free-of-charge notice | **Free** |
| **8** | **Massive (ex Polygon.io) Business plans** | Equities, options, FX, crypto | **Yes** — this is the paid, purpose-built answer; self-serve at `massive.com/business` | **Paid** |
| **9** | **Twelve Data + Redistribution Rights Add-On** | Equities, FX, crypto | **Yes**, with the add-on | **Paid** |
| **✗** | **TradingView** | all | **No** — display-only; no sublicensing for compensation; no commercial use of services or APIs | — |
| **✗** | **Yahoo Finance** | all | **No** — §2(a)(ix), 2(a)(x), 2(e), 2(h). Four separate breaches | — |
| **✗** | **Binance public API** | Crypto | **No** without written consent — ToS §III.1.b bars "data feeding or streaming services" | — |
| **✗** | **Coinbase** | Crypto | **No** — personal/research only, no redistribution, no end-user applications | — |
| **✗** | **Alpha Vantage free** | all | **No** — "personal, non-commercial use" | — |
| **✗** | **Finnhub free** | all | **No** — no redistribution without written approval; personal plans barred even internally | — |
| **✗** | **Twelve Data free** | all | **No** — "Internal non-display usage"; free-tier commercial use prohibited | — |
| **✗** | **Massive/Polygon Basic** | all | **No** — "personal, non-business, and non-commercial purposes" | — |
| **✗** | **Marketstack free** | Equities | **No** — "Non-Commercial Use" | — |
| **✗** | **open.er-api.com** | FX | **No** — *"not allowed to re-distribute it"* | — |
| **✗** | **LBMA / IBA metals** | Metals | **No** — IBA licence required to obtain, use *or redistribute* | — |
| **?** | **Stooq** | Equities, FX, EOD | **Unknown — unreachable from here, terms unread.** Do not ship | — |

### 6.3 The blunt summary

**For crypto: yes, free, commercially, today — CoinGecko.**

**For end-of-day FX against EUR: yes, free, commercially, today — ECB (directly or via
Frankfurter), with attribution and the "available free from the ECB" notice on paid tiers.
Note KES is not in the ECB set.**

**For live intraday FX, for metals (XAUUSD and friends), for indices, and for equities: no.
There is no free source we could verify that may lawfully be redistributed to end users.**
Every candidate is personal-use-only, non-redistributable, or requires a signature or a
payment. A terminal that shows those asset classes to its users needs a paid market-data
licence — Massive's business plans and Twelve Data's Redistribution Rights Add-On are the two
self-serve routes we confirmed exist, and Bitstamp and Kraken are worth an email for crypto
because both have a named process and may say yes for free.

**The one-line decision rule, borrowed from Massive's own documentation:** *"the moment data
reaches someone else … it is redistribution."* Apply it to every source before shipping.

---

## Could not verify

1. **The exact text of TradingView's Free Advanced Charts Agreement.**
   [The PDF](https://s3.amazonaws.com/tradingview/charting_library_license_agreement.pdf) is a
   scanned image; `pdftotext` and `poppler-utils` are absent from this machine and raw
   stream extraction yielded nothing. The grant, the public-implementation requirement and the
   attribution obligation are reported from secondary summaries only. **Read it before
   shipping Advanced Charts.**
2. **Binance's ToS §III.1.b verbatim at source.** `binance.com/en/terms` renders its body in
   JavaScript and returned only page chrome to every tool and to `curl`; the official
   `bnbstatic` consolidated PDF is CID-encoded and would not extract; `web.archive.org` is
   blocked from this environment. The quoted wording is identical across two independent
   citations of that URL but was not read on binance.com itself.
3. **Coinbase's Market Data Terms of Use verbatim.**
   [`coinbase.com/legal/market_data`](https://www.coinbase.com/legal/market_data) returned
   **HTTP 403** to our fetch. The clauses in §2.2 are from a search index of that page, not
   from the page.
4. **Whether Kraken's current docs still carry the commercial-use permission requirement.** The
   paragraph is present on
   [docs-legacy](https://docs-legacy.kraken.com/api/docs/guides/global-intro/) but absent from
   the [current docs page](https://docs.kraken.com/api/docs/guides/global-intro/). Whether that
   is a relocation or a change of policy is unknown. Email `marketdata@kraken.com` regardless.
5. **Finnhub's published free-tier rate limit.** `finnhub.io/pricing` returned only a title
   line to our fetch. "60 calls/minute (30/second burst)" is from secondary sources.
6. **Massive's (Polygon's) Market Data Terms verbatim.**
   [market_data_terms.pdf](https://massive.com/terms/market_data_terms.pdf) uses subsetted
   fonts and would not extract. Quotes in §3.4 are from a search index; the knowledge-base
   article quotes are first-hand.
7. **apilayer / Marketstack's operative terms.** `marketstack.com/terms` 301s to Idera's legal
   index, which links a Master SaaS Agreement and Terms of Use whose text we could not reach.
   Only the free plan's own "Non-Commercial Use" label is first-hand.
8. **Stooq's terms, at all.** `stooq.com` reset the connection at TLS level (proxy logged
   `ws_closed_mid_exchange` twice); `stooq.pl` returned HTTP 503. Download limits, licence and
   any commercial-use restriction are all unread.
9. **The terms of use attached to SIX's ISO 4217 files.** The data-standards page confirms the
   lists are published "free of charge" but states no licence or reuse terms for the files.
10. **Whether OpenFIGI's public-domain dedication extends past the identifiers.** The ToS
    dedicates "FIGI Identifiers" to the public domain in those words; the accompanying
    "Related Security Descriptions" (names, security types, exchange codes) are disclaimed AS
    IS and are not named in the dedication. Treat descriptive fields as less certain than the
    identifiers.
11. **Whether Bitstamp's Data License Agreement costs anything.** The page names the process
    and the mailbox; it states no fee either way.
12. **Whether CoinGecko's Demo tier (as opposed to paid tiers) is covered by the permissive
    "entitled to charge" clause.** The API Terms do not appear to distinguish tiers on that
    point, but we did not find an explicit statement that the Demo key carries the same
    commercial grant. Worth one confirming email before launch.
13. **A free, redistributable source of intraday FX or spot metals prices.** We looked and did
    not find one. This is a negative finding, not a gap in the research — but if the business
    needs it, the answer is a paid licence, not more searching.

## Sources

TradingView:
[Terms of Service and Company Policy (§3 — the operative data clauses)](https://www.tradingview.com/policies/) ·
[Support: "I need access to your API…"](https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/) ·
[Free charting libraries (licence comparison table)](https://www.tradingview.com/free-charting-libraries/) ·
[Advanced Charts](https://www.tradingview.com/advanced-charts/) ·
[Charting Library FAQ ("a chart with your data")](https://www.tradingview.com/charting-library-docs/latest/getting_started/Frequently-Asked-Questions/) ·
[lightweight-charts LICENSE (Apache 2.0)](https://raw.githubusercontent.com/tradingview/lightweight-charts/master/LICENSE) ·
[lightweight-charts repo (attribution requirement)](https://github.com/tradingview/lightweight-charts) ·
[charting-library-examples LICENSE (MIT)](https://github.com/tradingview/charting-library-examples/blob/master/LICENSE) ·
[Free Advanced Charts Agreement PDF (unextractable)](https://s3.amazonaws.com/tradingview/charting_library_license_agreement.pdf)

Crypto venues:
[Binance Market Data Only endpoints](https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only) ·
[Binance REST general information](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-api-information) ·
[Binance Terms of Use](https://www.binance.com/en/terms) ·
[Superalgos issue #1019 (citing Binance §III.1.b)](https://github.com/Superalgos/Superalgos/issues/1019) ·
[Coinbase Market Data Terms of Use](https://www.coinbase.com/legal/market_data) ·
[Coinbase Developer Platform ToS](https://www.coinbase.com/legal/developer-platform/terms-of-service) ·
[Kraken API global intro (legacy — the permission requirement)](https://docs-legacy.kraken.com/api/docs/guides/global-intro/) ·
[Kraken OHLC endpoint (720-bar cap)](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data) ·
[Bitstamp API (rate limits + Data License Agreement)](https://www.bitstamp.net/api/) ·
[CoinGecko API Terms of Service](https://www.coingecko.com/en/api_terms) ·
[CoinGecko API pricing (Demo limits, attribution)](https://www.coingecko.com/en/api/pricing) ·
[CoinGecko attribution guide](https://brand.coingecko.com/resources/attribution-guide)

Vendor free tiers:
[Alpha Vantage Terms of Service](https://www.alphavantage.co/terms_of_service/) ·
[Alpha Vantage premium (25 req/day)](https://www.alphavantage.co/premium/) ·
[Twelve Data Terms](https://twelvedata.com/terms) ·
[Twelve Data pricing](https://twelvedata.com/pricing) ·
[Finnhub Terms of Service](https://finnhub.io/terms-of-service) ·
[Massive (ex Polygon.io) pricing](https://massive.com/pricing) ·
[Massive Market Data Terms PDF](https://massive.com/terms/market_data_terms.pdf) ·
[Massive KB: "How can I redistribute… market data"](https://massive.com/knowledge-base/article/how-can-i-redistribute-polygons-market-data) ·
[Marketstack product/free plan](https://marketstack.com/product) ·
[Idera / apilayer legal index](https://www.ideracorp.com/legal/APILayer) ·
[Yahoo Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)

Official and open data:
[ECB euro reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) ·
[ECB disclaimer & copyright](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html) ·
[Frankfurter](https://frankfurter.dev/) ·
[Frankfurter licence & provider terms](https://frankfurter.dev/license/) ·
[exchangerate.host](https://exchangerate.host/) ·
[ExchangeRate-API free/open-access docs](https://www.exchangerate-api.com/docs/free) ·
[BIS terms and conditions](https://www.bis.org/terms_conditions.htm) ·
[EIA copyright and reuse](https://www.eia.gov/about/copyrights_reuse.php) ·
[Bank of Canada terms](https://www.bankofcanada.ca/terms/) ·
[LBMA precious metal prices (IBA licence required)](https://www.lbma.org.uk/prices-and-data/precious-metal-prices)

Reference / symbology:
[OpenFIGI Terms of Service](https://www.openfigi.com/docs/terms-of-service) ·
[GLEIF open data (CC0)](https://www.gleif.org/en/about/open-data) ·
[ISO 10383 MIC list](https://www.iso20022.org/market-identifier-codes) ·
[ISO 10383 terms of use PDF (Oct 2016)](https://www.iso20022.org/sites/default/files/2020-02/ISO10383_Terms_of_use.pdf) ·
[SIX data standards (ISO 4217, free of charge)](https://www.six-group.com/en/products-services/financial-information/data-standards.html) ·
[CCXT (MIT)](https://github.com/ccxt/ccxt) ·
[exchange_calendars (Apache-2.0)](https://github.com/gerrymanoim/exchange_calendars) ·
[SEC webmaster FAQ (10 req/s, User-Agent)](https://www.sec.gov/os/webmaster-faq) ·
[Nasdaq Trader symbol directory](https://www.nasdaqtrader.com/trader.aspx?id=symbollookup)

Endpoints called live from this machine on 2026-10-05:
`https://data-api.binance.vision/api/v3/exchangeInfo?symbol=BTCUSDT` (rate limits, tickSize,
stepSize) ·
`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` (2026-10-02 print) ·
`https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD,GBP,KES` (**KES absent**) ·
`https://open.er-api.com/v6/latest/USD` (daily update, terms_of_use field) ·
`https://stooq.com/q/d/l/?s=eurusd&i=d` (**connection reset — unreachable**)
