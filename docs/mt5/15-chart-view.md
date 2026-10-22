# The chart view: following, zoom and the vertical scale

## The reported bug

> "the graph autoresizes itself after i zoom (which I want to in order to analyze a specific candle
> movement). It should not autoresize itself."

It was a three-second timer, and it was worse than it sounds.

```ts
const RESUME_MS = 3000;
const detach = () => {
  setFollow(false);
  resumeRef.current = setTimeout(() => { setFollow(true); snapToLive(); }, RESUME_MS);
};
host.addEventListener('wheel', detach, { passive: true });
host.addEventListener('pointerdown', detach);
host.addEventListener('touchstart', detach, { passive: true });
```

Three things were wrong with it:

1. **It fired on any gesture anywhere on the chart**, the price axis included, because the axes are
   rendered inside the same host element.
2. **`snapToLive` did not restore the trader's view.** It wrote a **hard-coded 120-bar window** at
   the live edge:
   ```ts
   chart.timeScale().setVisibleLogicalRange({ from: n - 1 - visibleBarsRef.current, to: n - 1 + RIGHT_OFFSET_BARS });
   ```
   and `visibleBarsRef` was initialised to 120 and written **only** by the toolbar's own `+`/`−`
   buttons. A pinch, a wheel or an axis drag never updated it. So three seconds after zooming in on
   a candle, the chart came back at a zoom level nobody had chosen.
3. **While following, that same snap ran on every animation frame** (`if (followingRef.current)
   snapToLive()` inside the rAF loop), which made the chart literally un-zoomable: any manual range
   change was overwritten within 16ms. The only reason zooming appeared to work at all for three
   seconds is that the gesture handler had just switched following off.

## What MetaTrader actually does

One setting, **Chart auto scroll**, and one rule:

> a NEW BAR scrolls the chart to the latest bar, if the chart was already showing the latest bar.

Nothing on a clock, nothing driven by a gesture, and the zoom is never changed by it: the window
keeps its width and shifts by the one bar that appeared. Scroll back into history and the chart stays
there, because it is no longer showing the latest bar; scroll forward and following resumes on its
own, because it is.

That makes following **a fact about the current view**, not a mode a gesture toggles, which is why it
is now derived rather than stored. `lib/chart/follow.ts` is that arithmetic, unit-tested:

| | |
|---|---|
| `atLiveEdge(range, barCount)` | is this view showing the latest bar, within two bars of slack |
| `widthOf(range, fallback)` | the view's width in bars, floored at one |
| `liveWindow(barCount, width)` | the window showing the latest bar **at the caller's width** |
| `zoomedWindow(range, bars, n)` | a zoom that holds the **right** edge still |
| `clampBars(bars)` | 8 to 600 |

The one assertion that is the whole bug:

```ts
const width = 23;                       // zoomed right in on a handful of candles
const before = liveWindow(500, width);
const after  = liveWindow(501, width);  // one new bar
assert.equal(after.to - after.from, before.to - before.from);  // the width survives
assert.equal(after.to - before.to, 1);                          // and it moved by one bar
```

## What changed, line by line

| before | after |
|---|---|
| `wheel`/`pointerdown`/`touchstart` armed a 3s timer | **no listeners**; following is read off the visible range |
| `snapToLive` wrote a hard-coded 120 bars | writes `liveWindow(n, widthOf(currentRange))` |
| the snap ran every animation frame | runs on a **new bar** only (`closedOne`), and only when `Chart auto scroll` is on |
| `visibleBarsRef` was written only by the toolbar | written from every range change, so a pinch and a wheel count |
| zoom buttons re-fitted from a stale width | zoom reads the live width and holds the right edge |
| a reconnect or the midnight reseed forced the live edge | the visible **time** range is held across the refetch and restored, unless the trader was already at the edge |
| `priceScale.applyOptions({ autoScale: !props.scaleFix })` ran on every properties change | written only when `scaleFix` itself changes, so a manual stretch survives |

The price-axis case is its own bug: that effect depends on the whole properties object, so it re-ran
on **any** chart setting and on every symbol change, and each run wrote `autoScale: true` over the
`autoScale: false` that dragging the axis had just set. Stretch the scale by hand, touch any other
setting, and the stretch was gone.

## MetaTrader's three scale commands, which did not exist

Its chart menu carries them and this chart had none, so a trader who had stretched the price axis
could only get back by reloading the page:

- **Auto scale** — the bars set the vertical scale, MetaTrader's default.
- **Free chart movement** — the trader's stretch stands.
- **Reset vertical scale** — undo the stretch.

They are in the desktop Tools menu under a `Scale` section, alongside `Chart auto scroll` itself,
which is the one setting that decides whether the view moves on its own. A drag on the right 56px of
the plot (where the library draws the price axis) switches to free movement by itself, because that
is what the drag means.

## The test seam

The plot carries `data-chart-bars` and `data-chart-following`, written from the range subscription.
There is no way to ask the renderer its visible range from outside, and asserting on a React ref
asserts on nothing a trader can see. They are written to the DOM rather than to React state so a pan
does not re-render on every frame.

## Verified

| | |
|---|---|
| `apps/web/src/lib/chart/follow.test.ts` | 11 tests, including the width surviving a new bar and following resuming by itself on a scroll back to the edge |
| `scratchpad/zoom.mjs` | **16/16**, desktop 1440x900 and phone 360x800: the wheel zooms in, the zoom is still there five seconds later (past the old timer), it does not snap back to 120 bars, and still holds four seconds after that |

### Known, not this change

`scratchpad/handles.mjs` has one failing assertion ("they extend beyond the plot, so the SVG clips
them") and it fails identically on `main` without these changes. Not widened into this PR.
