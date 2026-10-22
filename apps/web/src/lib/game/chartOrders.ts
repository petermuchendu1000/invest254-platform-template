'use client';

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/endpoints';
import { useGameSocket, useGameSocketApi } from '@/lib/game/GameSocketProvider';
import { DURATION_OPTIONS } from '@/lib/game/useOrderEntry';
import { useDurationStore, useRestoreDuration, effectiveDuration } from '@/lib/game/duration';
import { askNewOrder } from '@/lib/game/newOrder';
import type { PendingKind } from '@invest254/shared/pending';

/**
 * The three things MetaTrader's chart context menu can do to an order, wired to the socket.
 *
 * `CandleChart` is deliberately prop-driven: it takes a tick source and a candle source and knows
 * nothing about the socket, which is what lets it be rendered in a story, a probe or a second shell.
 * Its menu, though, carries MetaTrader's own pending-order rows (`Sell Limit 1  219.306`), its
 * `Take Profit <price>` and its `New Order F9` — all three of which need the live connection. They
 * are gathered here so the chart stays prop-driven and the wiring is written once rather than at
 * each surface that renders a chart.
 *
 * Every handler returns `undefined` so a menu row can be GREYED, with a reason, where the thing
 * genuinely cannot be done: see the three `disabled` strings in CandleChart's Trading submenu. That
 * is MetaTrader's own idiom and it is why these are nullable rather than no-ops.
 */
export interface ChartOrders {
  onPlacePending: (input: { kind: PendingKind; triggerPrice: number; stakeCents: number; symbol: string }) => void;
  /** Set the open position's Take Profit at a level, which is what the row does in MetaTrader. */
  onTakeProfit: (price: number) => void;
  onNewOrder: () => void;
}

export function useChartOrders({ brandSlug }: { brandSlug: string }): ChartOrders {
  const { placePending, setLevels } = useGameSocketApi();
  const { activePosition } = useGameSocket();
  /**
   * The contract term the ticket is set to, so an order armed from the chart runs for the term the
   * trader chose. react-query already holds this response for the ticket on the same screen, so
   * reading it here costs no second request.
   */
  const { data: config } = useQuery({
    queryKey: ['gameConfig', brandSlug],
    queryFn: () => api.gameConfig(brandSlug),
    staleTime: 5 * 60_000,
  });
  const defaultDurationS = config?.defaultDurationS ?? 10;
  const durations = useMemo(
    () => Array.from(new Set([...DURATION_OPTIONS, defaultDurationS])).sort((a, b) => a - b),
    [defaultDurationS],
  );
  useRestoreDuration();
  const storedDuration = useDurationStore((s) => s.durationS);
  const durationS = effectiveDuration(storedDuration, durations, defaultDurationS);

  const onPlacePending = useCallback((input: {
    kind: PendingKind; triggerPrice: number; stakeCents: number; symbol: string;
  }) => {
    placePending({ ...input, durationS });
  }, [placePending, durationS]);

  /**
   * `Take Profit <price>`: MetaTrader arms the OPEN position's take profit at the clicked level.
   *
   * The Stop Loss is carried through unchanged, because `set_levels` writes both: sending null for
   * it would quietly REMOVE a stop the trader had set, from a menu row that says nothing about
   * stops.
   *
   * Always returned, never withheld when nothing is open. Withholding it made the chart grey the
   * row with "this surface cannot set a level", which is the wrong reason: the surface can, there
   * is simply no position to set one on. The chart already knows that from `openPosition`, so it
   * says the right thing and this stays a handler.
   */
  const open = activePosition !== null && activePosition.phase === 'open' && activePosition.positionId !== null
    ? activePosition
    : null;
  const onTakeProfit = useCallback((price: number) => {
    if (!open?.positionId) return;
    setLevels(open.slPrice ?? null, price, open.positionId);
  }, [open, setLevels]);

  return {
    onPlacePending,
    onTakeProfit,
    // MetaTrader's F9. See lib/game/newOrder for why this is a published request rather than a
    // call: the surface that answers it differs between the desktop and the phone.
    onNewOrder: askNewOrder,
  };
}
