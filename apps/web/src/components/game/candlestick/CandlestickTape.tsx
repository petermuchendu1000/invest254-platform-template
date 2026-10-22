'use client';

import { useEffect, useRef, useState } from 'react';
import { TIMEFRAMES, type Timeframe } from '@invest254/shared/candles';
import type { Candle } from '@invest254/shared/chart';
import type { Tick, ConnStatus } from '@/lib/game/types';
import type { CandlesReply } from '@/lib/game/GameSocketProvider';
import { ChartPlaceholder } from '@/components/ui/ChartPlaceholder';
import { dataPhaseOf, phaseIsBlocking } from '@/lib/ui/dataPhase';
import { cn } from '@/lib/cn';

/**
 * The candlestick screen's chart: bars, a price axis, a time axis, and nothing else.
 *
 * This is NOT `CandleChart`. That one is MetaTrader's chart — period strip, object rail, trade
 * levels, a Tools menu, 3400 lines of chrome — and it belongs to the broker terminal. The mock this
 * screen copies has a chart with no toolbar at all: the bars fill the pane edge to edge and the only
 * furniture is the two axes and the last price. Rendering the terminal's chart here and hiding its
 * chrome with CSS would leave all of its state, its keyboard handlers and its context menus live
 * underneath, so this is its own component, built the way `DerivChart` is built.
 *
 * Purely presentational: it draws what it is handed and owns no socket. The surface above it fetches
 * history, and the live edge is extended from the tick buffer on an animation frame rather than a
 * React render, so a price moving twice a second does not re-render the panel beside it.
 */
export function CandlestickTape({
  requestCandles, getLastTick, priceOfRate, status, timeframe = 'M1', count = 180, className,
}: {
  requestCandles: (tf: Timeframe, count: number, to?: number) => Promise<CandlesReply>;
  getLastTick: () => Tick | null;
  /** Raw engine rate → the instrument's displayed price. The bars are already in price space. */
  priceOfRate: (rate: number | null | undefined) => number | null;
  status: ConnStatus;
  timeframe?: Timeframe;
  count?: number;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /**
   * Has this chart ever drawn a bar? Drives the placeholder below: until the first seed lands the
   * area showed a bare container, which on a brand whose socket was still connecting was a
   * full-height void with no explanation. After the first bar it stays false-y forever, so a
   * reconnect keeps the last picture instead of blanking a trader's chart.
   */
  const [hasBars, setHasBars] = useState(false);
  /**
   * The history request came back REFUSED (or timed out), so no bars are coming unless we ask again.
   *
   * This used to be thrown away — the fetch below ended in `.catch(() => null)`, which turned a
   * definite "never" into the same silence as "not yet". The engine answers a brand it has no
   * candles for in about 300ms with `NO_CANDLES`; the screen went on saying "Fetching market data…"
   * for five minutes on a live brand, over an open socket that was streaming ticks the whole time.
   * Recording the failure is what lets the placeholder say so and offer the retry.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  /** Bumped by the retry button; in the effect's deps, so a click genuinely re-runs the fetch. */
  const [retryNonce, setRetryNonce] = useState(0);
  const chartRef = useRef<import('lightweight-charts').IChartApi | null>(null);
  const seriesRef = useRef<import('lightweight-charts').ISeriesApi<'Candlestick'> | null>(null);
  /** The bar currently forming, kept here so the loop can extend it without refetching history. */
  const liveRef = useRef<Candle | null>(null);
  const priceOfRateRef = useRef(priceOfRate);
  priceOfRateRef.current = priceOfRate;
  const requestRef = useRef(requestCandles);
  requestRef.current = requestCandles;
  const getTickRef = useRef(getLastTick);
  getTickRef.current = getLastTick;
  /** Stops the chart yanking itself back to the live edge while the trader is scrolled into history. */
  const followRef = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;

    const detach = () => { followRef.current = false; };
    host.addEventListener('wheel', detach, { passive: true });
    host.addEventListener('pointerdown', detach);
    host.addEventListener('touchstart', detach, { passive: true });

    /**
     * Ask for the bars NOW, before waiting on the chart library.
     *
     * These two are independent and used to run back to back: a ~180KB module fetch, and only then
     * a round trip to the engine for history. `requestCandles` does not need the socket to be open
     * — it queues into the provider's outbox and flushes on connect — so there is nothing to wait
     * for. Issuing it here overlaps the two, and the chart costs the SLOWER of them instead of
     * their sum. On a phone on mobile data that is most of a second.
     */
    const barsPromise = requestRef.current(timeframe, count).catch((): null => {
      // A refusal is DATA about the chart's state, not noise to discard. `disposed` guards the
      // usual unmount race; the provider never caches a failure, so the retry really re-asks.
      if (!disposed) setLoadFailed(true);
      return null;
    });

    (async () => {
      const lc = await import('lightweight-charts');
      const { createChart, CandlestickSeries, ColorType, CrosshairMode, LineStyle } = lc;
      if (disposed) return;

      /* The library takes colours as plain strings, so the brand's tokens are read off the document
         here rather than written as classes. This runs in the browser after the chart module lands,
         by which point globals.css has resolved every `--pp-*` for the active theme. */
      const PALETTE = chartPalette();

      const chart = createChart(host, {
        autoSize: true,
        localization: { locale: safeChartLocale() },
        layout: {
          background: { type: ColorType.Solid, color: PALETTE.bg },
          textColor: PALETTE.axis,
          fontSize: 10,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: PALETTE.grid, style: LineStyle.Solid },
          horzLines: { color: PALETTE.grid, style: LineStyle.Solid },
        },
        rightPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
        timeScale: { visible: true, borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8 },
        crosshair: { mode: CrosshairMode.Normal },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } },
      });
      chartRef.current = chart;

      const series = chart.addSeries(CandlestickSeries, {
        upColor: PALETTE.up, downColor: PALETTE.down,
        wickUpColor: PALETTE.up, wickDownColor: PALETTE.down,
        borderUpColor: PALETTE.up, borderDownColor: PALETTE.down,
        // The dashed line and the tag at the right edge ARE the mock's price readout; it has no
        // other one on the chart itself.
        priceLineVisible: true, priceLineStyle: LineStyle.Dashed, priceLineWidth: 1,
        lastValueVisible: true,
      });
      seriesRef.current = series;

      /**
       * Seed the series.
       *
       * `first` is the in-flight request started before the module was awaited; every later call
       * (there is none today, but the function is named because it reads as a step) asks again.
       */
      const seed = async (first = false) => {
        try {
          const reply = first ? await barsPromise : await requestRef.current(timeframe, count);
          if (disposed || !reply || !reply.bars.length) return;
          series.applyOptions({
            priceFormat: { type: 'price', precision: reply.instrument.digits, minMove: 1 / 10 ** reply.instrument.digits },
          });
          series.setData(reply.bars as never);
          setHasBars(true);
          setLoadFailed(false);
          liveRef.current = { ...reply.bars[reply.bars.length - 1]! };
          if (followRef.current) chart.timeScale().scrollToRealTime();
        } catch {
          /* A failed history fetch leaves the chart empty rather than throwing into the screen —
             but it is now SAID rather than silently swallowed, so the placeholder can stop
             claiming the bars are on their way. The next reconnect, or the retry, re-seeds it. */
          if (!disposed) setLoadFailed(true);
        }
      };
      await seed(true);

      const bucketS = TIMEFRAMES[timeframe];
      const loop = () => {
        if (disposed) return;
        const tick = getTickRef.current();
        const price = priceOfRateRef.current(tick?.rate);
        const cur = liveRef.current;
        if (tick && price !== null && cur && bucketS > 0) {
          const bar = Math.floor(tick.t / 1000 / bucketS) * bucketS;
          if (bar > cur.time) {
            // A new period: the bar that just closed stays as drawn, and this one opens at the
            // price that opened it rather than at the last one's close.
            liveRef.current = { time: bar, open: price, high: price, low: price, close: price };
          } else if (bar === cur.time) {
            cur.close = price;
            if (price > cur.high) cur.high = price;
            if (price < cur.low) cur.low = price;
          }
          const live = liveRef.current;
          if (live) series.update(live as never);
          if (followRef.current) chart.timeScale().scrollToRealTime();
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      host.removeEventListener('wheel', detach);
      host.removeEventListener('pointerdown', detach);
      host.removeEventListener('touchstart', detach);
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      liveRef.current = null;
    };
    // `timeframe`/`count` rebuild the chart deliberately: a different period is a different series.
  }, [timeframe, count]);

  /**
   * Re-seed after a reconnect.
   *
   * A dropped socket leaves the tape frozen at the last tick it saw; the bars that happened while it
   * was down are only in the engine. Asking again on `open` is what fills that gap, and it is a
   * separate effect so a reconnect does not tear the chart down and build it again.
   */
  useEffect(() => {
    if (status !== 'open') return;
    let cancelled = false;
    (async () => {
      try {
        const reply = await requestRef.current(timeframe, count);
        const series = seriesRef.current;
        if (cancelled || !series || !reply.bars.length) return;
        series.setData(reply.bars as never);
        // Also lifts the placeholder: if the mount-time seed() threw and only this path ever
        // succeeds, the chart draws bars while `hasBars` stays false and the placeholder sits on
        // top of a perfectly good chart forever.
        setHasBars(true);
        setLoadFailed(false);
        liveRef.current = { ...reply.bars[reply.bars.length - 1]! };
        if (followRef.current) chartRef.current?.timeScale().scrollToRealTime();
      } catch {
        /* see seed() */
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => { cancelled = true; };
    // `retryNonce` is what makes the placeholder's button do something: this effect is the cheap
    // path (it re-asks without tearing the chart down), so the retry rides it rather than the
    // mount effect.
  }, [status, timeframe, count, retryNonce]);

  const phase = dataPhaseOf(status, hasBars, loadFailed);
  return (
    <div className={cn('relative', className ?? 'h-full w-full')}>
      <div ref={hostRef} className="h-full w-full" />
      {phaseIsBlocking(phase) ? (
        <ChartPlaceholder
          phase={phase}
          onRetry={() => {
            // Clear FIRST so the placeholder goes back to "fetching" for the round trip: leaving it
            // on the failed copy while the retry is in flight makes the button look dead.
            setLoadFailed(false);
            setRetryNonce((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The chart's palette, taken from the brand's theme tokens instead of a fixed set of hexes.
 *
 * The chrome (`bg`, `grid`, `axis`) follows the brand through `--pp-bg`/`--pp-border`/`--pp-muted`,
 * while the bars read `--pp-up`/`--pp-down`, which globals.css deliberately keeps at fixed
 * green/red for every brand — a rising candle is a direction, not a logo. The literals here are the
 * token defaults, used only if a variable is missing (e.g. a test DOM with no stylesheet).
 */
/** globals.css :root defaults, reached ONLY when a variable resolves empty (e.g. a test DOM with no
 *  stylesheet). A real brand's value always wins, so these never paint on a live page. */
const FALLBACK = { bg: '#0B0E11', grid: '#2A323D', axis: '#8B97A7', up: '#16C784', down: '#EA3943' } as const; // brand-token-exempt: see above

function chartPalette() {
  const cs = getComputedStyle(document.documentElement);
  const g = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: g('--pp-bg', FALLBACK.bg),
    grid: g('--pp-border', FALLBACK.grid),
    axis: g('--pp-muted', FALLBACK.axis),
    up: g('--pp-up', FALLBACK.up),
    down: g('--pp-down', FALLBACK.down),
  } as const;
}

/**
 * A guaranteed-valid BCP-47 locale for the time-axis formatter.
 *
 * lightweight-charts formats axis times with `navigator.language`; on some webviews that is not a
 * structurally valid tag ('' or 'en-US@posix'), and `toLocaleString` then throws on EVERY tick,
 * aborting React's commit for the whole screen. `DerivChart` carries the same guard for the same
 * reason — see the note there.
 */
function safeChartLocale(): string {
  const cand = typeof navigator !== 'undefined' ? navigator.language : '';
  try {
    if (cand && Intl.getCanonicalLocales(cand).length > 0) return cand;
  } catch {
    /* invalid tag → the safe default below */
  }
  return 'en-US';
}
