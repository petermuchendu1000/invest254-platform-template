'use client';

import { useEffect, useRef } from 'react';
import type { Direction } from '@invest254/shared';
import { chartStyleOf, curveProfileForChartStyle } from '@invest254/shared/chart';
// Relative, not aliased: `@/` does not resolve under the repo's node:test runner, and this
// module's pure half is unit-tested.
import { logJournal } from './journal.js';
import { priceOfPoints, type Levels } from './levels.js';
import { ticketLabel, type ActivePosition } from './betting.js';

/**
 * Where a Stop Loss and a Take Profit are a PRICE this engine will actually close a position at.
 *
 * ── The one flag the copy turns on ───────────────────────────────────────────────────────────────
 *
 * The engine opens a position as CONTINUOUS when the brand has a price axis, and only then. See
 * `apps/engine/src/game.ts`: `const continuous = this.priceAxis !== undefined`, with the axis handed
 * to the GameServer in `siteregistry.ts` only when the brand's curve profile is `market`, and with
 * `continuous: false` forced on every pool-controlled position. On a continuous position the engine
 * checks both levels on every tick, stop first, and closes at
 * `settlement.valueAt(...)` — what the position is worth at that price. On a non-continuous one the
 * outcome is committed at open, `set_levels` is refused outright ("LEVELS_UNSUPPORTED") and the
 * contract runs to its horizon.
 *
 * So the browser's proxy for the engine's `continuous` is exactly two facts, both of which it
 * already has:
 *
 *   1. the brand's curve profile is `market`, which is the same shared helper the engine's wiring
 *      uses (`curveProfileForChartStyle`), and
 *   2. pool mode is off, which the engine reports in its hello as `earlyCloseEnabled`.
 *
 * It is not `earlyCloseEnabled` alone: a line brand with pool mode OFF reports early close enabled
 * and still has no axis, so neither of its levels can fire. The MT5 surfaces this gates are rendered
 * for non-marketers only (`TradeSurface`: `terminal = isTerminalBrand && !isMarketer`), which is the
 * one case where pool mode and a committed contract coincide exactly.
 *
 * ── Why this module no longer watches anything ───────────────────────────────────────────────────
 *
 * `useTakeProfitLevelWatch` fired a manual sell from a React effect when the price reached the
 * level. It is no longer armed anywhere: the ENGINE holds the levels and fires them on its own tick,
 * so a target survives a closed laptop. See docs/mt5/20-real-sl-tp.md.
 */

/**
 * Does this brand's engine price a position continuously, so a stop and a target close it at their
 * price?
 *
 * Pure, so the copy that depends on it can be unit-tested. `chartStyle` is the brand's raw value;
 * `chartStyleOf` normalises it the same way every other caller does.
 */
export function isContinuousBrand(
  { chartStyle, earlyCloseEnabled }: { chartStyle: unknown; earlyCloseEnabled: boolean },
): boolean {
  return earlyCloseEnabled && curveProfileForChartStyle(chartStyleOf(chartStyle)) === 'market';
}

/** The price a level sits at, or null when it is not set. */
export function levelPrice(
  levels: Levels, ref: number | null, field: 'sl' | 'tp', digits: number,
): number | null {
  const points = field === 'sl' ? levels.slPoints : levels.tpPoints;
  if (points === null || ref === null) return null;
  return priceOfPoints(ref, points, digits);
}

/**
 * Has the price reached the target?
 *
 * MetaTrader's own rule, and the direction is the POSITION's rather than the level's shape: a buy
 * takes profit above where it opened and a sell below it, whatever side of the anchor the level was
 * dragged to. Inclusive, because a price that lands exactly on the level has reached it.
 */
export function targetReached(
  { direction, target, price }: { direction: Direction; target: number | null; price: number | null },
): boolean {
  if (target === null || price === null) return false;
  return direction === 'buy' ? price >= target : price <= target;
}

/**
 * Close the open contract when the price reaches its Take Profit level.
 *
 * NOT ARMED. The engine holds both levels and fires them on its own tick, so this would be a second,
 * weaker copy of the same rule: one that only runs while the tab is open and receiving ticks. It is
 * kept, with its tests, as the shape of a client-side trigger should one ever be wanted again.
 *
 * Fires at most once per position: `sell` is not instantaneous, and a second call against a position
 * already closing is an error the trader would see.
 */
export function useTakeProfitLevelWatch(
  { position, price, target, sell, enabled, digits }: {
    position: ActivePosition | null;
    /** The live price on the instrument's own axis, not the engine's raw rate. */
    price: number | null;
    /** The Take Profit level as a price, from `levelPrice`. */
    target: number | null;
    sell: () => void;
    /** The engine's own answer to "can a manual close succeed on this brand at all". */
    enabled: boolean;
    digits: number;
  },
): void {
  const firedRef = useRef<string | null>(null);
  const sellRef = useRef(sell);
  sellRef.current = sell;

  const positionId = position?.positionId ?? null;
  // The ticket, for the journal line only: it names the deal the way MetaTrader names one.
  const ticket = position?.ticket ?? null;
  const sellable = position?.sellable ?? false;
  const direction = position?.direction ?? 'buy';

  // A new contract re-arms the trigger. The level itself is deliberately kept, the way a ticket
  // setting persists between orders in MetaTrader.
  useEffect(() => { if (!positionId) firedRef.current = null; }, [positionId]);

  useEffect(() => {
    if (!enabled || !positionId || !sellable) return;
    if (firedRef.current === positionId) return;
    if (!targetReached({ direction, target, price })) return;
    firedRef.current = positionId;
    logJournal(
      'ok', 'Trade',
      `#${ticketLabel({ ticket, positionId })} take profit reached at ${(price ?? 0).toFixed(digits)}, closing`,
    );
    sellRef.current();
  }, [enabled, positionId, ticket, sellable, direction, target, price, digits]);
}
