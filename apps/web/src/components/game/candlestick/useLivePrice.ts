'use client';

import { useEffect, useState } from 'react';
import { valueOfRate } from '@invest254/shared/candles';
import { useGameSocketApi } from '@/lib/game/GameSocketProvider';
import type { Tick } from '@/lib/game/types';

/**
 * The live price for a display surface: the last engine tick, the instrument's digits, and the
 * rate → price map the chart and the panel both need.
 *
 * Ticks arrive on a socket and are written to a buffer; they do NOT re-render React on their own.
 * A surface that wants to PRINT the price therefore has to ask on a timer, which is what
 * `useOrderEntry` does for the terminal's ticket. 250 ms is that same cadence: fast enough that the
 * number looks live, slow enough that it is four renders a second rather than thirty.
 *
 * `priceOfRate` is returned rather than a finished number so the chart can map its own ticks with
 * the same anchor the readout uses — two different maps would draw a bar at a price the readout
 * never showed.
 */
export function useLivePrice(): {
  tick: Tick | null;
  digits: number;
  priceOfRate: (rate: number | null | undefined) => number | null;
} {
  const { getLastTick, getMarket } = useGameSocketApi();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), 250);
    return () => clearInterval(id);
  }, []);

  const market = getMarket();
  const last = getLastTick();
  /**
   * A tick the CLIENT invented is not a price.
   *
   * The buffer is seeded with a synthetic tape so the chart is never blank before the first engine
   * tick (see `GameSocketProvider`). Printing one of those next to Buy and Sell would put a figure
   * on screen that no server ever quoted, so the readout shows nothing instead.
   */
  const tick = last && last.synthetic !== true ? last : null;
  const priceOfRate = (rate: number | null | undefined): number | null =>
    market && rate !== null && rate !== undefined
      ? market.anchor.base + market.instrument.scale * (valueOfRate(rate) - market.anchor.openValue)
      : null;

  return { tick, digits: market?.instrument.digits ?? 2, priceOfRate };
}
