'use client';

import { useCallback, useMemo, useRef } from 'react';
import { useGameSocket, useGameSocketApi } from '@/lib/game/GameSocketProvider';
import dynamic from 'next/dynamic';
import { CurveCanvas, type MarketerBeat } from '@/components/game/CurveCanvas';
import { ChartPlaceholder } from '@/components/ui/ChartPlaceholder';
import { lotsOfStake } from '@invest254/shared/account';
import { PENDING_LABELS } from '@invest254/shared/pending';
import { useVolumeDigits } from '@/lib/game/volumeDigits';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { InterfaceModeToggle } from '@/components/game/InterfaceModeToggle';
import { useOutcomeFx } from '@/lib/game/outcomeFx';
import type { ActivePosition } from '@/lib/game/betting';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { cn } from '@/lib/cn';
import { useChartSymbolStore, chartOverride, CHART_SYMBOL_DND } from '@/lib/game/chartSymbol';
import { useChartOrders } from '@/lib/game/chartOrders';
import type { Timeframe } from '@invest254/shared/candles';
import type { Tick } from '@/lib/game/types';

/**
 * MetaTrader's chart, loaded only by the brands that draw one.
 *
 * It is the single largest component in the product — the period strip, the object rail, the trade
 * levels, the Tools menu and the indicator catalogue behind it — and the branch below renders it
 * ONLY when `tradingViewTypeOf` returns a type. A line brand therefore downloaded the whole
 * terminal chart to draw a wave with it, on the same critical path as its own chart.
 */
const CandleChart = dynamic(
  () => import('@/components/game/CandleChart').then((m) => m.CandleChart),
  { loading: () => <div className="relative h-full w-full"><ChartPlaceholder phase="connecting" /></div> },
);

const WINDOW_MS = 60_000;

/**
 * MARKETER anticipation beat: expose the live contract's elapsed fraction (0→1) and the latest real
 * settlement to the neutral wave, so it can show a "round is about to resolve" charge meter + payoff.
 * Progress is read from the authoritative `expiresAtMs`/`durationS` on each animation frame (smooth,
 * not tied to React renders). Null while nothing is live, so the beat only ever reflects a REAL round.
 */
function useMarketerBeat(active: ActivePosition | null): MarketerBeat {
  const activeRef = useRef(active);
  activeRef.current = active;
  const getProgress = useCallback((): number | null => {
    const a = activeRef.current;
    if (!a || a.phase === 'settling' || !a.expiresAtMs || a.durationS <= 0) return null;
    const totalMs = a.durationS * 1000;
    const elapsed = 1 - Math.max(0, a.expiresAtMs - Date.now()) / totalMs;
    return Math.min(1, Math.max(0, elapsed));
  }, []);
  const outcome = useOutcomeFx((s) => s.current);
  const resolve = useMemo(
    () => (outcome ? { id: outcome.id, won: outcome.result === 'win' } : null),
    [outcome],
  );
  return useMemo(() => ({ getProgress, resolve }), [getProgress, resolve]);
}

/**
 * Live price view. Per-brand (`sites.chart_style`, 0111/0147) it renders the classic line curve (`CurveCanvas`,
 * the free default) or, for every paid chart system (area, candlestick, bars, baseline), the TradingView view
 * (`CandleChart`) opening on THAT series type. ADDON-1: area/bars/baseline used to fall back to the line curve,
 * so brands paid for a chart their players never saw. Both views share the authoritative tick stream.
 */
export function GameCurve({ phone = false, levelStakeCents = 0, fullScreen, onFullScreen }: {
  phone?: boolean;
  /** Phone only: the stake behind the chart's draggable Stop Loss. */
  levelStakeCents?: number;
  /**
   * Phone, landscape only: MetaTrader's full-screen, with the app's tab bar hidden.
   *
   * Undefined in portrait, where MetaTrader has no such mode and the chart's bar must not offer a
   * control that does nothing.
   */
  fullScreen?: boolean | undefined;
  /** Called with false to give the chrome back, which is iOS's full-screen/normal toggle. */
  onFullScreen?: ((full: boolean) => void) | undefined;
} = {}) {
  const { getTicks, getLastTick, requestCandles, getSymbolQuote, getMarket, getSettledSymbol } = useGameSocketApi();
  /**
   * The symbol the chart is on. Null means the brand's own — the one it settles — so the default
   * path is byte-for-byte what it was before symbol switching existed.
   */
  const stored = useChartSymbolStore((s) => s.symbol);
  const setCharted = useChartSymbolStore((s) => s.set);
  /**
   * The symbol this brand settles, which is what a drop of it means "back to the default".
   *
   * The engine's own answer first (`getSettledSymbol`), then the market axis. The axis alone is
   * null until the first candles reply, and during that window a drop of the brand's OWN symbol
   * used to be stored as if it were another instrument.
   */
  const defaultSymbol = getSettledSymbol() ?? getMarket()?.instrument.symbol ?? null;
  /** What the chart is drawing when that is NOT the settled symbol. See `chartOverride`. */
  const charted = chartOverride(stored, defaultSymbol);
  const symbol = charted ?? undefined;
  // Volume to the SYMBOL's own volume digits, which is the figure the ticket offers and the Trade
  // grid prints (docs/mt5/09-toolbox.md 300, rows at 313-318).
  const volumeDigits = useVolumeDigits(charted ?? defaultSymbol ?? '');
  const chartCandles = useCallback(
    (tf: Timeframe, count: number, to?: number) => requestCandles(tf, count, to, symbol),
    [requestCandles, symbol],
  );
  /**
   * The live edge for whichever symbol is charted.
   *
   * The brand's own tick stream carries one instrument, so a chart on any other symbol reads that
   * symbol's quote instead. `delta` is zero because the chart does not use it: it recomputes the
   * bar from the price, and a delta against the wrong previous quote would be worse than none.
   */
  const chartTick = useCallback((): Tick | null => {
    if (symbol === undefined) return getLastTick();
    const q = getSymbolQuote(symbol);
    return q === null ? null : { t: q.t, rate: q.rate, delta: 0 };
  }, [symbol, getLastTick, getSymbolQuote]);
  const { activePosition, status, pendingOrders } = useGameSocket();
  const brand = useBrand();
  /**
   * The three order handlers the chart's context menu needs.
   *
   * Passed in rather than reached for inside `CandleChart`, because that component is deliberately
   * prop-driven: it takes a tick source and a candle source and knows nothing about the socket, so
   * the one place that holds both is here.
   */
  const chartOrders = useChartOrders({ brandSlug: brand.slug });
  /**
   * The waiting orders as levels for the chart to draw, this chart's symbol only.
   *
   * MetaTrader labels the line with the order's type and volume, which is the same text its Trade
   * grid prints in those two columns; `pendingRowLabel` would add the price a second time, and the
   * axis label already carries it.
   */
  const pendingLevels = useMemo(() => {
    const on = charted ?? defaultSymbol;
    return pendingOrders
      .filter((o) => on === null || o.symbol === on)
      .map((o) => ({
        id: o.id,
        price: o.triggerPrice,
        label: `${PENDING_LABELS[o.kind].toLowerCase()} ${lotsOfStake(o.stakeCents, volumeDigits)}`,
      }));
  }, [pendingOrders, charted, defaultSymbol, volumeDigits]);
  // The wave follows the effective "basic" skin: a real marketer OR a player who chose Basic.
  const { isMarketer } = useMarketerSkin();
  const tvType = tradingViewTypeOf(chartStyleOf(brand.chartStyle));
  // The anticipation beat rides on the neutral wave (basic skin only).
  const beat = useMarketerBeat(isMarketer ? activePosition : null);
  /**
   * The interface gear lives in the chart's own top-right corner, where every charting app keeps its
   * chart settings — and where this one has empty space, because the wave's value axis is drawn down
   * the LEFT edge. It used to sit in a row of its own above the chart: a full 60px band of a
   * viewport-locked phone screen spent on one 32px icon, which is 60px the chart was not getting.
   *
   * On a candlestick brand the same control is already in the chart toolbar (CandleChart), so this
   * is the line/wave half of one rule rather than a second placement.
   *
   * It used to be hidden from a marketer by ROLE, because a marketer was pinned to the basic skin and
   * a settings gear would have given the disguise away. Marketers now get the player interface
   * exactly (see the policy note in lib/marketer/isMarketer), so withholding the gear would be the
   * one thing left making their screen a different screen — and CandleChart never withheld it in the
   * first place, so the two halves of the rule disagreed.
   */
  const gearHere = !tvType;

  return (
    <div
      /**
       * The chart viewing area is a drop target, which is MetaTrader's own way of changing a
       * chart's symbol: "A symbol chart can be opened by dragging it to the chart viewing area
       * using a mouse (Drag'n'Drop)." Market Watch's rows are the drag source.
       */
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(CHART_SYMBOL_DND)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        const dropped = e.dataTransfer.getData(CHART_SYMBOL_DND);
        if (!dropped) return;
        e.preventDefault();
        // Null for the brand's own symbol, so a brand changing its instrument does not strand the
        // device on the old one. Same rule as Market Watch's own `openChart`.
        setCharted(dropped === defaultSymbol ? null : dropped);
      }}
      className={cn(
        'relative h-full min-h-0 w-full overflow-hidden bg-[var(--mt5-surface)]',
        // On a phone the chart IS the screen, the way MetaTrader's Charts tab is: a card border and
        // rounded corners around a full-bleed view would only take pixels off the plot.
        phone ? '' : 'rounded-sm border border-[var(--mt5-border)]',
      )}
    >
      {/* Candlestick/OHLC brands render the TradingView view; line brands render the wave. The wave's
          neutralized form (no price axis, labels or red/green) is now reached only by a player who
          chose Basic — a marketer sees the same wave a player does. */}
      {tvType ? (
        <CandleChart
          key={tvType}
          initialType={tvType}
          getLastTick={chartTick}
          requestCandles={chartCandles}
          status={status}
          symbol={symbol}
          phone={phone}
          /* What a contract at the current volume risks, which is the money MetaTrader shows
             while a Stop Loss level is dragged on the chart. */
          levelStakeCents={levelStakeCents}
          {...(fullScreen === undefined ? {} : { fullScreen })}
          {...(onFullScreen === undefined ? {} : { onFullScreen })}
          openPosition={activePosition && activePosition.entryRate !== null
            ? { entryRate: activePosition.entryRate, direction: activePosition.direction, lots: lotsOfStake(activePosition.stakeCents, volumeDigits) }
            : null}
          /* MetaTrader's chart menu places orders. See lib/game/chartOrders. */
          onPlacePending={chartOrders.onPlacePending}
          onTakeProfit={chartOrders.onTakeProfit}
          onNewOrder={chartOrders.onNewOrder}
          pendingLevels={pendingLevels}
          /* The chart's own way back when it is on another instrument. See CandleChart. */
          {...(charted === null ? {} : { onChartSettled: () => setCharted(null) })}
          settledSymbol={defaultSymbol}
        />
      ) : (
        /* `status` reached CandleChart above but never the wave, which is why the wave's empty view
           could not tell "connecting" from "dropped". */
        <CurveCanvas getTicks={getTicks} getLastTick={getLastTick} windowMs={WINDOW_MS} marketer={isMarketer} beat={beat} status={status} />
      )}
      {gearHere ? <div className="absolute right-2 top-2 z-20"><InterfaceModeToggle /></div> : null}
    </div>
  );
}
