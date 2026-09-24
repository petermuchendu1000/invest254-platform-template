'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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

type Marker = { time: number; kind: 'entry' | 'win' | 'loss'; text?: string };

/** Map our semantic entry/settle markers to lightweight-charts series markers, resolving brand
 *  colours from CSS vars. Sorted ascending by time (the library requires it). */
function buildLcMarkers(markers: Marker[]): any[] {
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

/** DIGITS-UI: chart controls driven by the toolbar around the chart (zoom, follow, draw, export). */
export interface DerivChartHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  /** Fit the whole buffered range (stops following live). */
  fit: () => void;
  /** Reset zoom and follow the live price again. */
  followLive: () => void;
  /** Download the chart as a PNG. */
  download: (fileName: string) => void;
  /** Remove every horizontal line the player drew. */
  clearLines: () => void;
}

interface DerivChartProps {
  getTicks: () => InstrumentTick[];
  getLastTick: () => InstrumentTick | null;
  resetKey: string;
  precision?: number;
  /** Historical View: freeze auto-follow and fit the buffered range so the user can scroll back. */
  paused?: boolean;
  /** Timeframe/zoom (1T etc.): pixels per bar on the time scale. Undefined keeps the default. */
  barSpacing?: number;
  /** Entry/settle markers for the current contract — mapped to brand colours + shapes on the series. */
  markers?: Marker[];
  /** 'line' (thin light line, the mock default) or 'area' (accent line with a soft fill). */
  variant?: 'line' | 'area';
  /** When true, a click on the chart drops a horizontal price line at that price. */
  drawMode?: boolean;
  onLineDrawn?: () => void;
}

/**
 * Deriv-style price chart on TradingView lightweight-charts (v5), fed by the per-instrument client
 * stream: a right price axis, an HH:MM:SS time axis, a dashed live-price line that starts at a dot
 * on the left edge and ends in an outlined price tag on the right (HTML overlay, positioned from the
 * series every frame), autoscale, crosshair and wheel/pinch zoom. Toolbar controls are exposed via
 * the imperative handle. Purely presentational.
 */
export const DerivChart = forwardRef<DerivChartHandle, DerivChartProps>(function DerivChart(
  { getTicks, getLastTick, resetKey, precision = 2, paused = false, barSpacing, markers = [], variant = 'line', drawMode = false, onLineDrawn },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tagRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<import('lightweight-charts').IChartApi | null>(null);
  const seriesRef = useRef<import('lightweight-charts').ISeriesApi<'Area'> | null>(null);
  const linesRef = useRef<import('lightweight-charts').IPriceLine[]>([]);
  const markersApiRef = useRef<{ setMarkers: (m: unknown[]) => void } | null>(null);
  const markersPropRef = useRef(markers);
  markersPropRef.current = markers;
  const drawRef = useRef({ drawMode, onLineDrawn });
  drawRef.current = { drawMode, onLineDrawn };
  const variantRef = useRef(variant);
  variantRef.current = variant;
  const followRef = useRef(true);
  const lastTRef = useRef(0);
  const lastRateRef = useRef<number | null>(null);

  const seriesStyle = (v: 'line' | 'area') => {
    const cs = getComputedStyle(document.documentElement);
    const accent = readVar(cs, '--pp-accent', '#3B82F6');
    const fg = readVar(cs, '--pp-fg', '#E6EDF3');
    return v === 'area'
      ? { lineColor: accent, topColor: `${accent}40`, bottomColor: `${accent}04`, lineWidth: 2 as const }
      : { lineColor: fg, topColor: 'rgba(0,0,0,0)', bottomColor: 'rgba(0,0,0,0)', lineWidth: 1 as const };
  };

  /** Place the live price tag + start dot on the series' last value (DOM writes, no React render). */
  const placeOverlay = () => {
    const s = seriesRef.current; const c = chartRef.current;
    const tag = tagRef.current; const dot = dotRef.current;
    const rate = lastRateRef.current;
    if (!s || !c || !tag || !dot || rate == null) return;
    const y = s.priceToCoordinate(rate);
    if (y == null) { tag.style.opacity = '0'; dot.style.opacity = '0'; return; }
    tag.style.opacity = '1'; dot.style.opacity = '1';
    tag.style.transform = `translateY(${Math.round(y) - 12}px)`;
    tag.textContent = rate.toFixed(precision);
    dot.style.transform = `translateY(${Math.round(y) - 4}px)`;
  };

  // Re-seed the series when the instrument changes (new stream buffer).
  useEffect(() => {
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
      lastRateRef.current = data[data.length - 1]!.value;
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
      const bg = readVar(cs, '--pp-bg', readVar(cs, '--pp-surface', '#0B0E11'));
      const text = readVar(cs, '--pp-muted', '#8B97A7');
      const border = readVar(cs, '--pp-border', '#2A323D');

      const chart = createChart(host, {
        autoSize: true,
        localization: { locale: safeChartLocale() },
        layout: { background: { type: ColorType.Solid, color: bg }, textColor: text, fontSize: 9, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', attributionLogo: false },
        grid: { vertLines: { color: `${border}88`, style: LineStyle.Solid }, horzLines: { color: `${border}88`, style: LineStyle.Solid } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: barSpacing ?? 7 },
        crosshair: { mode: CrosshairMode.Normal },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } },
      });
      chartRef.current = chart;

      const series = chart.addSeries(AreaSeries, {
        ...seriesStyle(variantRef.current),
        priceLineVisible: true,
        priceLineStyle: LineStyle.Dashed,
        priceLineWidth: 1,
        priceLineColor: text,
        lastValueVisible: false, // the outlined HTML tag replaces the solid axis label
        priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
      });
      seriesRef.current = series;

      const markersApi = createSeriesMarkers(series, []);
      markersApiRef.current = markersApi as unknown as { setMarkers: (m: unknown[]) => void };
      markersApi.setMarkers(buildLcMarkers(markersPropRef.current) as never);

      // Click-to-draw a horizontal price line (pencil tool).
      chart.subscribeClick((p) => {
        if (!drawRef.current.drawMode || !p.point) return;
        const price = series.coordinateToPrice(p.point.y);
        if (price == null) return;
        const accent = readVar(getComputedStyle(document.documentElement), '--pp-accent', '#3B82F6');
        linesRef.current.push(series.createPriceLine({ price: Number(price), color: accent, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '' }));
        drawRef.current.onLineDrawn?.();
      });

      const seen = new Set<number>();
      const data = getTicks()
        .map((t) => ({ time: secOf(t.t), value: t.rate }))
        .filter((d) => (seen.has(d.time) ? false : (seen.add(d.time), true)))
        .map((d) => ({ time: d.time as unknown as import('lightweight-charts').UTCTimestamp, value: d.value }));
      if (data.length) { series.setData(data); lastRateRef.current = data[data.length - 1]!.value; }
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
            lastRateRef.current = tk.rate;
            plottedAny = true;
          }
        }
        if (plottedAny && followRef.current) {
          // Until the buffer is wide enough to fill the chart, stretch it edge to edge (no empty
          // band on the left on big screens); after that, follow the live edge at the chosen zoom.
          const r = chart.timeScale().getVisibleLogicalRange();
          if (r && r.from < 0) chart.timeScale().fitContent();
          else chart.timeScale().scrollToRealTime();
        }
        placeOverlay();
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
      linesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = chartRef.current;
    if (!c || barSpacing == null) return;
    c.timeScale().applyOptions({ barSpacing });
  }, [barSpacing]);

  useEffect(() => { seriesRef.current?.applyOptions(seriesStyle(variant)); }, [variant]);

  useEffect(() => {
    if (markersApiRef.current) markersApiRef.current.setMarkers(buildLcMarkers(markers) as never);
  }, [markers]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    if (paused) { followRef.current = false; c.timeScale().fitContent(); }
    else { followRef.current = true; c.timeScale().scrollToRealTime(); }
  }, [paused]);

  useImperativeHandle(ref, () => {
    const zoom = (factor: number) => {
      const c = chartRef.current; if (!c) return;
      const cur = c.timeScale().options().barSpacing;
      c.timeScale().applyOptions({ barSpacing: Math.min(60, Math.max(1, cur * factor)) });
      if (followRef.current) c.timeScale().scrollToRealTime();
    };
    return {
      zoomIn: () => zoom(1.35),
      zoomOut: () => zoom(1 / 1.35),
      fit: () => { followRef.current = false; chartRef.current?.timeScale().fitContent(); },
      followLive: () => {
        followRef.current = true;
        const c = chartRef.current; if (!c) return;
        c.timeScale().applyOptions({ barSpacing: barSpacing ?? 7 });
        c.timeScale().scrollToRealTime();
      },
      download: (fileName: string) => {
        const c = chartRef.current; if (!c) return;
        const canvas = c.takeScreenshot();
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = fileName;
        a.click();
      },
      clearLines: () => {
        const s = seriesRef.current; if (!s) return;
        for (const l of linesRef.current) s.removePriceLine(l);
        linesRef.current = [];
      },
    };
  }, [barSpacing]);

  return (
    <div className={`relative h-full w-full ${drawMode ? 'cursor-crosshair' : ''}`}>
      <div ref={hostRef} className="h-full w-full" />
      {/* live price: start dot on the left edge + outlined tag over the price axis */}
      <div ref={dotRef} aria-hidden className="pointer-events-none absolute left-3 top-0 z-10 h-2 w-2 rounded-full bg-fg opacity-0" />
      <div
        ref={tagRef}
        aria-hidden
        className="pointer-events-none absolute right-1 top-0 z-10 rounded-md border border-accent bg-bg px-2 py-[3px] font-mono text-[11px] font-bold tabular-nums text-fg opacity-0 shadow-[0_0_12px_-4px_var(--pp-accent)]"
      />
    </div>
  );
});
