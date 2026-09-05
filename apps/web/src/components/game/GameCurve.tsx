'use client';

import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { CurveCanvas } from '@/components/game/CurveCanvas';
import { CandleChart } from '@/components/game/CandleChart';
import { useBrand } from '@/lib/brand/BrandProvider';

const WINDOW_MS = 60_000;

/**
 * Live price view. Per-brand (`sites.chart_style`, migration 0111) it renders either the classic
 * line/area curve (`CurveCanvas`, the default) or TradingView candlesticks (`CandleChart`). Both are
 * fed by the SAME authoritative tick stream, so switching is purely presentational.
 */
export function GameCurve() {
  const { getTicks, getLastTick } = useGameSocket();
  const brand = useBrand();
  const candles = brand.chartStyle === 'candlestick';

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-border bg-surface">
      {candles ? (
        <CandleChart getTicks={getTicks} getLastTick={getLastTick} windowMs={WINDOW_MS} symbol={`BTC/${brand.currency || 'KES'}`} />
      ) : (
        <CurveCanvas getTicks={getTicks} getLastTick={getLastTick} windowMs={WINDOW_MS} />
      )}
    </div>
  );
}
