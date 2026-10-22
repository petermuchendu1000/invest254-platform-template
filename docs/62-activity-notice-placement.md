# 62 — Where the activity notification is allowed to be

**BUGLOG:** #138 · **Code:** `components/game/ActivityNotice.tsx`, `TradeSurface.tsx`,
`candlestick/CandlestickTradeScreen.tsx` · **Tests:** `activityNotice.guard.test.ts`,
`e2e/activitynotice.e2e.mjs` · **Measured:** 2026-10-14, Chromium 131, local dev build

Marketers demonstrating the app reported that the "someone just won" notification **blocks the
wave**. It did. This is what was wrong, what the two shells do now, and what was rejected.

---

## 1. The complaint was real, and the component's own doc said it could not be

`ActivityNotice`'s header claimed it is shown "never to a MARKETER, whose whole skin exists to
remove the financial tells this card is made of". Both shells gate it on `useMarketerSkin()`, so on
the face of it a marketer never saw the thing they were complaining about.

That comment was stale. `lib/marketer/skinPolicy.ts` carries `NEUTRALISE_SHARED_UI = false`, and

```ts
export const marketerSkinOn = (isMarketerRole: boolean, playerBasic: boolean): boolean =>
  (NEUTRALISE_SHARED_UI && isMarketerRole) || playerBasic;
```

collapses to `playerBasic` alone. Since the marketer-unification decision (docs/29) a marketer gets
the **player** interface exactly — card included. `useMarketerSkin().isMarketer` now means "this
screen is on the Basic skin", not "this account is a marketer". **Verified** by reading the policy
module; the misleading comment is corrected in the same commit.

## 2. How much of the chart it was covering

Measured in Chromium against the wave shell with the feed served from a fixture (the method is now
`apps/web/e2e/activitynotice.e2e.mjs`). The card was 288x73 CSS px, absolutely positioned at
`top-3` **inside** the chart box and centred on phones:

| Viewport | Card box | Chart box | Share of the chart covered |
|---|---|---|---|
| 320x568 | 272x73 @ (24,143) | 158px tall | **42.7%** |
| 360x640 | 288x73 @ (36,142) | 206px tall | **30.6%** |
| 390x844 | 288x73 @ (51,156) | 395px tall | 14.6% |
| 768x1024 | 288x73 | 623px tall | 4.6% |
| 1440x900 | 288x73 | 507px tall | 3.3% |

On the two phone classes the product sells into hardest it was covering a third to nearly half of
the curve, dead centre, for three seconds at a time — over the one surface a player reads to choose
Higher or Lower.

## 3. What it is now

A **one-line ribbon**, ~28–30px, carrying the same four facts (handle, verb, amount, proof). Two
placements, one per shell; there is no third and a new shell has to pick one of these.

### Wave / classic (`placement="band"`)

The ribbon **overlays the decorative ticker row** — `absolute inset-0` inside a `relative` wrapper
that holds `TickerStrip` — for its three seconds, and the marquee carries on underneath afterwards.

- **Nothing of value is covered.** `TickerStrip` is a client-side random walk that says so in its
  own header: the only purely decorative surface on the screen. **Verified** in that file.
- **The chart gives up nothing and never resizes.** Overlay, not a row: 0px overlap with the chart
  at every viewport, and the chart box measures the same height through a full show/hide cycle.
- **Under 640px tall there is no ribbon**, because the ticker row itself is hidden there
  (BUGLOG #129) and the ribbon rides it. See the trade-off in §5.

### Candlestick (`placement="ribbon"`)

This shell has no marquee to lend, and **no dead space in the chart either** — `CandlestickTape`
right-aligns the bars and they fill the pane edge to edge. The ribbon hangs flush off the bottom of
the quote band, at the **top-left** of the pane, on three properties of that file:

- `rightPriceScale.scaleMargins = { top: 0.12, bottom: 0.12 }`, so the **top 12% of the plot holds
  no candle body or wick at any zoom** — only grid lines. The ribbon is 28px and the e2e asserts it
  stays inside that fraction of the pane (measured: 7.8% at 390x844, 3.6% at 1440x900).
- bars run **newest-at-the-right** (`rightOffset: 4`), so the left of that band is the oldest bars —
  the part of a chart nobody is reading — and the ribbon stops well short of the live edge.
- a right gutter keeps it off the price axis (e2e: ≥40px).

The **bottom-left** corner, otherwise the obvious candidate, is not available: `attributionLogo:
true` puts the TradingView mark there and the free lightweight-charts licence requires it stay
visible. **Verified** in `CandlestickTape.tsx`; the licence condition is assumed from that flag's
purpose, not re-read from TradingView's terms.

It is also **hidden (not unmounted)** on the phone's Chat / Top / Tours tabs — see BUGLOG #138b.

## 4. Why a borrowed lane rather than a better corner

- Notifications that overlap the surface the user is acting on are measurably more distracting than
  the same notification further from the point of gaze (Hueber et al., *Gaze-Attentive
  Notifications*, MobileHCI '23). The trade screen has exactly one such surface: the curve plus the
  Higher/Lower buttons. That rules out every in-chart placement, not just the centred one.
- The counter-pressure is **banner blindness** — a region learned as "where the adverts go" gets
  filtered out (Benway & Lane, 1998) — which is the argument against giving social proof a dedicated
  slot of its own. Borrowing a row the player already glances at keeps it in the upper scan path
  without ever covering the decision.
- Corner placement is the industry convention for social-proof tickers; it is **not** what we do on
  the wave, because this screen has something better: a decorative row in the right place.

These support the *direction*; none of them is an A/B result on this product. Treat the placement as
reasoned, not proven, and measure conversion before claiming a lift.

## 5. Rejected, and the trade-off accepted

| Option | Why not |
|---|---|
| **A row of its own above the marquee** (the first reading of the request) | It costs the chart ~42–66px permanently. Worse, the ribbon is transient, so a row that collapsed when idle would change the chart's height every ~6s — and `CurveCanvas` watches its canvas with a `ResizeObserver`, so the wave would rescale on every cycle. A *reserved* row avoids the shift but not the cost, and at 320x568 the chart measures 158px against BUGLOG #129's 160px floor, so there is nothing to give. |
| **Keep the three-line card, just move it** | 73px does not fit the ticker row, does not fit the candlestick shell's 12% candle-free band on a phone, and buys nothing the one-line form does not carry. |
| **A corner of the chart (top-left / bottom-left)** | Still over the bars on the candlestick shell; bottom-left is spoken for by the TradingView mark. On the wave it is still inside the decision surface. |
| **Overlay the price strip instead of the ticker** | `PriceHeader` is live data — pair, price, change, H/L, online. Covering it is strictly worse than covering a random walk. |
| **Give short phones the ribbon back as a 30px row** | Breaks #129: at 320x568 it pushes the screen past `h-dvh` inside an `overflow-hidden` shell. |

**The trade-off accepted:** viewports under 640px tall (320x568, 360x640 and similar) now show **no
win notification at all**. They are also the viewports where it was doing the most damage (42.7% and
30.6% of the chart), so the complaint is answered most strongly exactly where the feature is lost.
If social proof there turns out to matter commercially, the reversal is a second placement that puts
the 28px ribbon in the top band of the wave's own chart — the candlestick treatment — and the cost
is ~19% of a 158px chart as a thin top strip rather than 42.7% as a centred block.

## 6. What did not change

The feed, the gate, the selection and the timings are untouched: same `GET /api/v1/site/activity`
on the same query key, limit and 20s poll as `ChatPane` (so React Query still dedupes them into one
request), same `selectCards` draw, same `MAX_PER_BATCH`/`SHOW_MS`/`EXIT_MS`/`GAP_MS`, same
announcement cap. **There is still no client-side generator and there must never be one** — every
name and figure on the ribbon came off the wire.
