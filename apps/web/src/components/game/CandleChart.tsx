'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IChartApi, ISeriesApi, UTCTimestamp, CandlestickData, BarData, LineData, Time, SeriesType,
} from 'lightweight-charts';
import { aggregateCandles, upsertCandle, sma, bollinger, type Candle } from '@invest254/shared/chart';
import type { Tick } from '@/lib/game/types';
import { cn } from '@/lib/cn';

/**
 * TradingView-grade candlestick view — the per-brand alternative to the line `CurveCanvas`
 * (migration 0111). Built on TradingView's own Lightweight Charts (v5), so the axes, crosshair and
 * interactions ARE TradingView's. Drop-in with `CurveCanvas` (same props/mount).
 *
 * It consumes the SAME authoritative engine tick stream (`getTicks`/`getLastTick`) and folds it into
 * OHLC via the pure, unit-tested `@invest254/shared/chart` helpers, so the chart can never desync
 * from the settled price. Feature set (a "⚙ features" menu exposes the pro tools):
 *   - chart type: Candles · Bars · Line · Area · Baseline
 *   - price scale: Normal · Logarithmic · Percent
 *   - indicators (OFF by default): MA(7) · MA(25) · MA(99) · Bollinger(20,2)
 *   - timeframe pills 1s/2s/5s/10s (re-aggregate the tape) · −/+ zoom · Live snap-back
 *   - wheel/pinch zoom · drag-to-pan · crosshair · OHLC legend (tracks the crosshair)
 *   - LOCAL-timezone time axis + crosshair · 4-dp price axis · faint symbol watermark
 *
 * Lightweight Charts is imported dynamically inside the effect so it never runs during SSR.
 */

type MainType = 'candles' | 'bars' | 'line' | 'area' | 'baseline';
type ScaleMode = 'normal' | 'log' | 'percent';

const INTERVALS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 1000, label: '1s' }, { ms: 2000, label: '2s' }, { ms: 5000, label: '5s' }, { ms: 10_000, label: '10s' },
];
const CHART_TYPES: ReadonlyArray<{ id: MainType; label: string }> = [
  { id: 'candles', label: 'Candles' }, { id: 'bars', label: 'Bars' }, { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' }, { id: 'baseline', label: 'Baseline' },
];
const SCALES: ReadonlyArray<{ id: ScaleMode; label: string }> = [
  { id: 'normal', label: 'Linear' }, { id: 'log', label: 'Log' }, { id: 'percent', label: 'Percent' },
];
const DEFAULT_INTERVAL_MS = 2000;
const MIN_BARS = 8, MAX_BARS = 600, ZOOM_STEP = 0.7, RIGHT_OFFSET_BARS = 3;
const RESUME_MS = 3000; // auto-return to the live edge after this idle time following manual pan/zoom
const MA = { fast: 7, mid: 25, slow: 99 }, BB_PERIOD = 20, BB_MULT = 2, PRICE_PRECISION = 4;

const readVar = (cs: CSSStyleDeclaration, n: string, f: string) => cs.getPropertyValue(n).trim() || f;
const pad = (n: number) => String(n).padStart(2, '0');
const localTime = (t: number) => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const asLine = (candles: Candle[], vals: Array<number | null>): LineData[] => {
  const out: LineData[] = [];
  for (let i = 0; i < candles.length; i++) if (vals[i] != null) out.push({ time: candles[i]!.time as UTCTimestamp, value: vals[i]! });
  return out;
};

interface Ind { ma7: boolean; ma25: boolean; ma99: boolean; bb: boolean }
interface Legend { o: number; h: number; l: number; c: number; changePct: number }

export function CandleChart({
  getTicks, getLastTick, windowMs, symbol = 'BTC/KES',
}: { getTicks: () => Tick[]; getLastTick: () => Tick | null; windowMs: number; symbol?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const maFastRef = useRef<ISeriesApi<'Line'> | null>(null);
  const maMidRef = useRef<ISeriesApi<'Line'> | null>(null);
  const maSlowRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbMidRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLoRef = useRef<ISeriesApi<'Line'> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const hoverRef = useRef(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const resumeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [intervalMs, setIntervalMs] = useState(DEFAULT_INTERVAL_MS);
  const [chartType, setChartType] = useState<MainType>('candles');
  const chartTypeRef = useRef<MainType>('candles'); chartTypeRef.current = chartType;
  const [scaleMode, setScaleMode] = useState<ScaleMode>('normal');
  const [ind, setInd] = useState<Ind>({ ma7: false, ma25: false, ma99: false, bb: false });
  const indRef = useRef(ind); indRef.current = ind;
  const followingRef = useRef(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [legend, setLegend] = useState<Legend | null>(null);
  const visibleBarsRef = useRef(Math.max(MIN_BARS, Math.ceil(windowMs / DEFAULT_INTERVAL_MS)));

  const setFollow = useCallback((v: boolean) => { followingRef.current = v; }, []);
  const legendOf = (c: Candle): Legend => ({ o: c.open, h: c.high, l: c.low, c: c.close, changePct: c.open ? ((c.close - c.open) / c.open) * 100 : 0 });

  const snapToLive = useCallback(() => {
    const chart = chartRef.current, n = candlesRef.current.length;
    if (!chart || n === 0) return;
    chart.timeScale().setVisibleLogicalRange({ from: n - 1 - visibleBarsRef.current, to: n - 1 + RIGHT_OFFSET_BARS });
  }, []);
  const zoom = useCallback((dir: 'in' | 'out') => {
    const next = dir === 'in' ? visibleBarsRef.current * ZOOM_STEP : visibleBarsRef.current / ZOOM_STEP;
    visibleBarsRef.current = Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(next)));
    const chart = chartRef.current; if (!chart) return;
    if (followingRef.current) snapToLive();
    else { const r = chart.timeScale().getVisibleLogicalRange(); if (r) chart.timeScale().setVisibleLogicalRange({ from: r.to - visibleBarsRef.current, to: r.to }); }
  }, [snapToLive]);

  const refreshIndicators = useCallback(() => {
    const candles = candlesRef.current, closes = candles.map((c) => c.close), on = indRef.current;
    maFastRef.current?.setData(on.ma7 ? asLine(candles, sma(closes, MA.fast)) : []);
    maMidRef.current?.setData(on.ma25 ? asLine(candles, sma(closes, MA.mid)) : []);
    maSlowRef.current?.setData(on.ma99 ? asLine(candles, sma(closes, MA.slow)) : []);
    if (bbUpRef.current && bbMidRef.current && bbLoRef.current) {
      const bb = on.bb ? bollinger(closes, BB_PERIOD, BB_MULT) : [];
      bbUpRef.current.setData(asLine(candles, bb.map((b) => b?.upper ?? null)));
      bbMidRef.current.setData(asLine(candles, bb.map((b) => b?.mid ?? null)));
      bbLoRef.current.setData(asLine(candles, bb.map((b) => b?.lower ?? null)));
    }
  }, []);
  useEffect(() => { refreshIndicators(); }, [ind, refreshIndicators]);

  // Price-scale mode is applied live (no rebuild).
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    // lazily import the enum values via numeric map (0 normal, 1 log, 2 percent)
    const mode = scaleMode === 'log' ? 1 : scaleMode === 'percent' ? 2 : 0;
    chart.priceScale('right').applyOptions({ mode });
  }, [scaleMode]);

  // Close the features menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => { if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  // Build (rebuild on interval OR chart-type change), then track live ticks.
  useEffect(() => {
    let disposed = false, raf = 0;
    const host = hostRef.current; if (!host) return;
    const detach = () => {
      setFollow(false);
      if (resumeRef.current) clearTimeout(resumeRef.current);
      resumeRef.current = setTimeout(() => { setFollow(true); snapToLive(); }, RESUME_MS);
    };
    host.addEventListener('wheel', detach, { passive: true });
    host.addEventListener('pointerdown', detach);
    host.addEventListener('touchstart', detach, { passive: true });

    (async () => {
      const lc = await import('lightweight-charts');
      const { createChart, CandlestickSeries, BarSeries, LineSeries, AreaSeries, BaselineSeries, ColorType, CrosshairMode, LineStyle } = lc;
      if (disposed) return;
      const cs = getComputedStyle(document.documentElement);
      const up = readVar(cs, '--pp-up', '#16C784'), down = readVar(cs, '--pp-down', '#EA3943');
      const bg = readVar(cs, '--pp-surface', readVar(cs, '--pp-bg', '#0B0E11'));
      const text = readVar(cs, '--pp-muted', '#8B97A7'), border = readVar(cs, '--pp-border', '#2A323D');
      const accent = readVar(cs, '--pp-accent', '#67E997'), info = readVar(cs, '--pp-info', '#3B82F6');

      const chart = createChart(host, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: bg }, textColor: text, fontSize: 10, attributionLogo: true },
        grid: { vertLines: { color: border }, horzLines: { color: border } },
        rightPriceScale: { borderColor: border, scaleMargins: { top: 0.08, bottom: 0.08 }, mode: scaleMode === 'log' ? 1 : scaleMode === 'percent' ? 2 : 0 },
        timeScale: {
          borderColor: border, timeVisible: true, secondsVisible: true, rightOffset: RIGHT_OFFSET_BARS, barSpacing: 6,
          tickMarkFormatter: (t: Time) => localTime(t as number),
        },
        localization: { timeFormatter: (t: Time) => localTime(t as number) },
        crosshair: { mode: CrosshairMode.Normal },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } },
      });
      chartRef.current = chart;

      // Indicators under the price series (created regardless; data set only when toggled on).
      const lineOpts = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
      bbUpRef.current = chart.addSeries(LineSeries, { ...lineOpts, color: info, lineWidth: 1, lineStyle: LineStyle.Dotted });
      bbMidRef.current = chart.addSeries(LineSeries, { ...lineOpts, color: info, lineWidth: 1, lineStyle: LineStyle.Dashed });
      bbLoRef.current = chart.addSeries(LineSeries, { ...lineOpts, color: info, lineWidth: 1, lineStyle: LineStyle.Dotted });
      maFastRef.current = chart.addSeries(LineSeries, { ...lineOpts, color: accent, lineWidth: 2 });
      maMidRef.current = chart.addSeries(LineSeries, { ...lineOpts, color: '#F0B90B', lineWidth: 2 });
      maSlowRef.current = chart.addSeries(LineSeries, { ...lineOpts, color: '#A78BFA', lineWidth: 2 });

      // Main price series per selected chart type.
      const seeded = aggregateCandles(getTicks(), intervalMs);
      candlesRef.current = seeded;
      const priceFormat = { type: 'price', precision: PRICE_PRECISION, minMove: 1 / 10 ** PRICE_PRECISION } as const;
      const baseVal = seeded.length ? seeded[Math.floor(seeded.length / 2)]!.close : 0;
      const t = chartTypeRef.current;
      let main: ISeriesApi<SeriesType>;
      if (t === 'candles') main = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceFormat });
      else if (t === 'bars') main = chart.addSeries(BarSeries, { upColor: up, downColor: down, priceFormat });
      else if (t === 'line') main = chart.addSeries(LineSeries, { color: accent, lineWidth: 2, priceFormat });
      else if (t === 'area') main = chart.addSeries(AreaSeries, { lineColor: accent, topColor: `${accent}55`, bottomColor: `${accent}05`, lineWidth: 2, priceFormat });
      else main = chart.addSeries(BaselineSeries, { baseValue: { type: 'price', price: baseVal }, topLineColor: up, topFillColor1: `${up}44`, topFillColor2: `${up}08`, bottomLineColor: down, bottomFillColor1: `${down}08`, bottomFillColor2: `${down}44`, priceFormat });
      mainRef.current = main;

      const ohlc = seeded as unknown as (CandlestickData | BarData)[];
      const lineData: LineData[] = seeded.map((c) => ({ time: c.time as UTCTimestamp, value: c.close }));
      main.setData((t === 'candles' || t === 'bars') ? ohlc : lineData);

      refreshIndicators();
      if (seeded.length) setLegend(legendOf(seeded[seeded.length - 1]!));
      visibleBarsRef.current = Math.min(MAX_BARS, Math.max(MIN_BARS, Math.ceil(windowMs / intervalMs)));
      setFollow(true); snapToLive();

      chart.subscribeCrosshairMove((param) => {
        const d = param.seriesData?.get(main) as (CandlestickData | BarData | LineData) | undefined;
        if (d && 'open' in d && typeof d.open === 'number') { hoverRef.current = true; setLegend({ o: d.open, h: d.high, l: d.low, c: d.close, changePct: d.open ? ((d.close - d.open) / d.open) * 100 : 0 }); }
        else hoverRef.current = false;
      });

      let lastCount = seeded.length;
      const put = (s: ISeriesApi<'Line'> | null, tm: UTCTimestamp, v: number | null) => { if (s && v != null) s.update({ time: tm, value: v }); };
      const loop = () => {
        if (disposed) return;
        const last = getLastTick();
        if (last && mainRef.current) {
          const c = upsertCandle(candlesRef.current, last, intervalMs);
          const tm = c.time as UTCTimestamp;
          const cur = chartTypeRef.current;
          if (cur === 'candles' || cur === 'bars') mainRef.current.update({ time: tm, open: c.open, high: c.high, low: c.low, close: c.close } as CandlestickData);
          else mainRef.current.update({ time: tm, value: c.close } as LineData);

          const n = candlesRef.current.length;
          if (n !== lastCount) { refreshIndicators(); lastCount = n; }
          else {
            const closes = candlesRef.current.map((x) => x.close), on = indRef.current;
            if (on.ma7) put(maFastRef.current, tm, sma(closes, MA.fast).at(-1)!);
            if (on.ma25) put(maMidRef.current, tm, sma(closes, MA.mid).at(-1)!);
            if (on.ma99) put(maSlowRef.current, tm, sma(closes, MA.slow).at(-1)!);
            if (on.bb) { const b = bollinger(closes, BB_PERIOD, BB_MULT).at(-1); if (b) { put(bbUpRef.current, tm, b.upper); put(bbMidRef.current, tm, b.mid); put(bbLoRef.current, tm, b.lower); } }
          }
          if (!hoverRef.current) setLegend(legendOf(c));
          if (followingRef.current) snapToLive();
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (resumeRef.current) clearTimeout(resumeRef.current);
      host.removeEventListener('wheel', detach);
      host.removeEventListener('pointerdown', detach);
      host.removeEventListener('touchstart', detach);
      chartRef.current?.remove();
      chartRef.current = mainRef.current = null;
      maFastRef.current = maMidRef.current = maSlowRef.current = bbUpRef.current = bbMidRef.current = bbLoRef.current = null;
      candlesRef.current = [];
    };
  }, [getTicks, getLastTick, intervalMs, chartType, windowMs, setFollow, snapToLive, refreshIndicators, scaleMode]);

  const pill = 'h-6 min-w-[1.75rem] rounded-md border px-1.5 text-[10px] font-semibold leading-none transition backdrop-blur';
  const idle = 'border-border bg-surface/80 text-muted hover:text-fg';
  const active = 'border-accent bg-accent/15 text-accent';
  const up = (legend?.changePct ?? 0) >= 0;
  const row = 'flex items-center gap-1';

  return (
    <div className="flex h-full w-full flex-col">
      {/* Toolbar header strip — sits ABOVE the plot (TradingView-style) so it never covers candles. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-1 pb-1">
        <div className={cn('flex-wrap', row)}>
          {INTERVALS.map((iv) => (
            <button key={iv.ms} type="button" onClick={() => setIntervalMs(iv.ms)} aria-pressed={intervalMs === iv.ms} className={cn(pill, intervalMs === iv.ms ? active : idle)}>{iv.label}</button>
          ))}
        </div>
        <div className={row} ref={menuWrapRef}>
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} className={cn(pill, menuOpen ? active : idle, 'px-2')} title="Chart features">⚙ Tools</button>
            {menuOpen ? (
              <div className="absolute right-0 top-7 z-30 w-52 rounded-lg border border-border bg-surface/95 p-2 text-left shadow-xl backdrop-blur">
                <Section title="Chart type">
                  <div className="grid grid-cols-3 gap-1">
                    {CHART_TYPES.map((c) => (
                      <button key={c.id} type="button" onClick={() => setChartType(c.id)} className={cn(pill, 'w-full', chartType === c.id ? active : idle)}>{c.label}</button>
                    ))}
                  </div>
                </Section>
                <Section title="Price scale">
                  <div className="grid grid-cols-3 gap-1">
                    {SCALES.map((sm) => (
                      <button key={sm.id} type="button" onClick={() => setScaleMode(sm.id)} className={cn(pill, 'w-full', scaleMode === sm.id ? active : idle)}>{sm.label}</button>
                    ))}
                  </div>
                </Section>
                <Section title="Indicators">
                  <div className="grid grid-cols-2 gap-1">
                    <Toggle on={ind.ma7} onClick={() => setInd((s) => ({ ...s, ma7: !s.ma7 }))}>MA 7</Toggle>
                    <Toggle on={ind.ma25} onClick={() => setInd((s) => ({ ...s, ma25: !s.ma25 }))}>MA 25</Toggle>
                    <Toggle on={ind.ma99} onClick={() => setInd((s) => ({ ...s, ma99: !s.ma99 }))}>MA 99</Toggle>
                    <Toggle on={ind.bb} onClick={() => setInd((s) => ({ ...s, bb: !s.bb }))}>Boll 20</Toggle>
                  </div>
                </Section>
              </div>
            ) : null}
          </div>
          <button type="button" onClick={() => zoom('out')} aria-label="Zoom out" className={cn(pill, idle, 'text-sm')}>−</button>
          <button type="button" onClick={() => zoom('in')} aria-label="Zoom in" className={cn(pill, idle, 'text-sm')}>+</button>
        </div>
      </div>

      {/* Plot area — fills the remaining height; only the faint watermark + compact legend overlay it. */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full" aria-label="Live price chart" role="img" />
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <span className="select-none text-4xl font-black uppercase tracking-widest text-fg/[0.04]">{symbol}</span>
        </div>
        {legend ? (
          <div className="pointer-events-none absolute left-1 top-1 z-20 flex flex-wrap gap-x-2 rounded-md bg-surface/70 px-1.5 py-0.5 font-mono text-[10px] tabular-nums backdrop-blur">
            <span className="text-muted">{symbol}</span>
            <span className="text-muted">O <span className="text-fg">{legend.o.toFixed(4)}</span></span>
            <span className="text-muted">H <span className="text-fg">{legend.h.toFixed(4)}</span></span>
            <span className="text-muted">L <span className="text-fg">{legend.l.toFixed(4)}</span></span>
            <span className="text-muted">C <span className="text-fg">{legend.c.toFixed(4)}</span></span>
            <span className={cn('font-semibold', up ? 'text-up' : 'text-down')}>{up ? '+' : ''}{legend.changePct.toFixed(2)}%</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      {children}
    </div>
  );
}
function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'flex h-6 items-center justify-between rounded-md border px-2 text-[10px] font-semibold transition',
        on ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-surface/80 text-muted hover:text-fg',
      )}
    >
      <span>{children}</span>
      <span className={cn('ml-1 h-1.5 w-1.5 rounded-full', on ? 'bg-accent' : 'bg-border')} />
    </button>
  );
}
