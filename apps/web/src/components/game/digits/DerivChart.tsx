'use client';

import { useEffect, useRef } from 'react';
import type { InstrumentTick } from '@/lib/game/useInstrument';

function readVar(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = cs.getPropertyValue(name).trim();
  return v || fallback;
}
const secOf = (ms: number) => Math.floor(ms / 1000);

/**
 * A guaranteed-valid BCP-47 locale for the chart's time-axis tick formatter.
 *
 * lightweight-charts defaults its tick/crosshair time formatting to `navigator.language`, then calls
 * `Date.prototype.toLocaleString(locale, …)`. On some devices/webviews `navigator.language` is NOT a
 * structurally-valid language tag (e.g. '' or 'en-US@posix'), which makes that call throw
 * `RangeError: Incorrect locale information provided` on EVERY tick. Because the chart re-renders
 * constantly, the throw repeatedly aborts React's commit for the whole trade screen — so toasts never
 * appear and taps stop registering until a hard refresh. We validate the tag and fall back to en-US.
 */
function safeChartLocale(): string {
  const cand = typeof navigator !== 'undefined' ? navigator.language : '';
  try {
    if (cand && Intl.getCanonicalLocales(cand).length > 0) return cand;
  } catch {
    /* invalid tag → fall through to the safe default */
  }
  return 'en-US';
}

/** Map our semantic entry/settle markers to lightweight-charts series markers, resolving brand
 *  colours from CSS vars. Sorted ascending by time (the library requires it). */
function buildLcMarkers(markers: Array<{ time: number; kind: 'entry' | 'win' | 'loss'; text?: string }>): any[] {
  const cs = getComputedStyle(document.documentElement);
  const accent = readVar(cs, '--pp-accent', '#3B82F6');
  const up = readVar(cs, '--pp-up', '#22C55E');
  const down = readVar(cs, '--pp-down', '#EF4444');
  return [...markers]
    .sort((a, b) => a.time - b.time)
    .map((m) => {
      const color = m.kind === 'entry' ? accent : m.kind === 'win' ? up : down;
      return {
        time: m.time as unknown as import('lightweight-charts').UTCTimestamp,
        position: m.kind === 'entry' ? 'belowBar' : 'aboveBar',
        color,
        shape: m.kind === 'entry' ? 'arrowUp' : 'circle',
        text: m.text ?? '',
      };
    });
}

/**
 * Deriv-style price chart: an area/line series with a real RIGHT price axis, a bottom TIME axis
 * (HH:MM:SS), a live last-price tag + dashed price line, autoscale, crosshair, and wheel/pinch zoom
 * with a follow-live reset. Built on TradingView lightweight-charts (v5), fed by the per-instrument
 * client stream. Purely presentational.
 */
export function DerivChart({
  getTicks,
  getLastTick,
  resetKey,
  precision = 2,
  paused = false,
  barSpacing,
  markers = [],
}: {
  getTicks: () => InstrumentTick[];
  getLastTick: () => InstrumentTick | null;
  resetKey: string;
  precision?: number;
  /** Historical View: freeze auto-follow and fit the buffered range so the user can scroll back. */
  paused?: boolean;
  /** Timeframe/zoom (1T etc.): pixels per bar on the time scale. Undefined keeps the default. */
  barSpacing?: number;
  /** Entry/settle markers for the current contract — mapped to brand colours + shapes on the series. */
  markers?: Array<{ time: number; kind: 'entry' | 'win' | 'loss'; text?: string }>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<import('lightweight-charts').IChartApi | null>(null);
  const seriesRef = useRef<import('lightweight-charts').ISeriesApi<'Area'> | null>(null);
  const markersApiRef = useRef<{ setMarkers: (m: unknown[]) => void } | null>(null);
  const markersPropRef = useRef(markers);
  markersPropRef.current = markers;
  const followRef = useRef(true);
  const lastTRef = useRef(0);
  const resetKeyRef = useRef(resetKey);

  // Re-seed the series when the instrument changes (new stream buffer).
  useEffect(() => {
    resetKeyRef.current = resetKey;
    const s = seriesRef.current;
    if (!s) return;
    const seen = new Set<number>();
    const data = getTicks()
      .map((t) => ({ time: secOf(t.t), value: t.rate }))
      .filter((d) => (seen.has(d.time) ? false : (seen.add(d.time), true)))
      .map((d) => ({ time: d.time as unknown as import('lightweight-charts').UTCTimestamp, value: d.value }));
    if (data.length) {
      s.setData(data);
      lastTRef.current = getLastTick()?.t ?? 0;
      chartRef.current?.timeScale().scrollToRealTime();
    }
  }, [resetKey, getTicks, getLastTick]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;

    const detach = () => { followRef.current = false; };
    host.addEventListener('wheel', detach, { passive: true });
    host.addEventListener('pointerdown', detach);
    host.addEventListener('touchstart', detach, { passive: true });

    (async () => {
      const lc = await import('lightweight-charts');
      const { createChart, AreaSeries, ColorType, CrosshairMode, LineStyle, createSeriesMarkers } = lc;
      if (disposed) return;
      const cs = getComputedStyle(document.documentElement);
      const accent = readVar(cs, '--pp-accent', '#3B82F6');
      const bg = readVar(cs, '--pp-surface', readVar(cs, '--pp-bg', '#0B0E11'));
      const text = readVar(cs, '--pp-muted', '#8B97A7');
      const border = readVar(cs, '--pp-border', '#2A323D');

      const chart = createChart(host, {
        autoSize: true,
        // Pin a VALIDATED locale so the time-axis tick formatter never calls Date.toLocaleString with
        // an invalid tag (navigator.language can be '' / 'en-US@posix' on some webviews). That
        // RangeError otherwise fires every tick and aborts React commits — breaking toasts + taps.
        localization: { locale: safeChartLocale() },
        layout: { background: { type: ColorType.Solid, color: bg }, textColor: text, fontSize: 10, attributionLogo: false },
        grid: { vertLines: { color: border, style: LineStyle.Dotted }, horzLines: { color: border, style: LineStyle.Dotted } },
        rightPriceScale: { borderColor: border, scaleMargins: { top: 0.12, bottom: 0.12 } },
        timeScale: { borderColor: border, timeVisible: true, secondsVisible: true, rightOffset: 4, barSpacing: barSpacing ?? 7 },
        crosshair: { mode: CrosshairMode.Normal },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } },
      });
      chartRef.current = chart;

      const series = chart.addSeries(AreaSeries, {
        lineColor: accent,
        topColor: `${accent}44`,
        bottomColor: `${accent}05`,
        lineWidth: 2,
        priceLineVisible: true,
        priceLineStyle: LineStyle.Dashed,
        lastValueVisible: true,
        priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
      });
      seriesRef.current = series;

      // Entry/settle marker layer (v5 plugin). Apply any markers already set for the current contract.
      const markersApi = createSeriesMarkers(series, []);
      markersApiRef.current = markersApi as unknown as { setMarkers: (m: unknown[]) => void };
      markersApi.setMarkers(buildLcMarkers(markersPropRef.current) as never);

      // Initial data from the current buffer.
      const seen = new Set<number>();
      const data = getTicks()
        .map((t) => ({ time: secOf(t.t), value: t.rate }))
        .filter((d) => (seen.has(d.time) ? false : (seen.add(d.time), true)))
        .map((d) => ({ time: d.time as unknown as import('lightweight-charts').UTCTimestamp, value: d.value }));
      if (data.length) series.setData(data);
      lastTRef.current = getLastTick()?.t ?? 0;
      chart.timeScale().scrollToRealTime();

      const loop = () => {
        if (disposed) return;
        const ticks = getTicks();
        let plottedAny = false;
        for (const tk of ticks) {
          if (tk.t > lastTRef.current) {
            series.update({ time: secOf(tk.t) as unknown as import('lightweight-charts').UTCTimestamp, value: tk.rate });
            lastTRef.current = tk.t;
            plottedAny = true;
          }
        }
        if (plottedAny && followRef.current) chart.timeScale().scrollToRealTime();
        raf = window.setTimeout(loop, 200) as unknown as number;
      };
      loop();
    })();

    return () => {
      disposed = true;
      window.clearTimeout(raf);
      host.removeEventListener('wheel', detach);
      host.removeEventListener('pointerdown', detach);
      host.removeEventListener('touchstart', detach);
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersApiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timeframe / zoom (1T presets): re-apply bar spacing live when it changes.
  useEffect(() => {
    const c = chartRef.current;
    if (!c || barSpacing == null) return;
    c.timeScale().applyOptions({ barSpacing });
  }, [barSpacing]);

  // Entry/settle markers: re-apply whenever the current contract's markers change.
  useEffect(() => {
    if (markersApiRef.current) markersApiRef.current.setMarkers(buildLcMarkers(markers) as never);
  }, [markers]);

  // Historical View: when paused, stop following live and fit the buffered range so the user can
  // scroll back through it; when resumed, follow the live edge again. No new data source needed.
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    if (paused) {
      followRef.current = false;
      c.timeScale().fitContent();
    } else {
      followRef.current = true;
      c.timeScale().scrollToRealTime();
    }
  }, [paused]);

  const resetZoom = () => {
    followRef.current = true;
    const c = chartRef.current;
    if (c) { c.timeScale().resetTimeScale(); c.timeScale().scrollToRealTime(); }
  };

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      <button
        type="button"
        onClick={resetZoom}
        className="absolute right-2 top-2 rounded-md border border-border bg-surface-2/80 px-2 py-1 text-[11px] font-semibold text-muted backdrop-blur hover:text-fg"
        aria-label="Reset zoom and follow live price"
      >
        Reset
      </button>
    </div>
  );
}
