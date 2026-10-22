'use client';

import { useEffect, useRef, useState } from 'react';
import type { Direction } from '@invest254/shared';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { fillLine, refusalReason, type LocalRefusal, type OrderResult } from '@/lib/game/orderResult';
import { claimOrderWindow } from '@/lib/game/orderWindow';

/**
 * What the order window shows after the trade buttons are tapped.
 *
 * MetaQuotes, both platforms: *"Once an order is sent, its execution results will appear in the
 * window: either confirmation of a successful trade or a rejection with the reason specified."*
 * This is the state machine behind that sentence, shared by the two surfaces that place an order on
 * a phone, so neither invents its own wording.
 *
 * ── The three ways an order ends ─────────────────────────────────────────────────────────────────
 *
 * 1. Refused here, before anything is sent: the single-open rule, no session, no socket, or the
 *    chart on an unsettled symbol. Those are known instantly and `place()` returns the reason.
 * 2. Sent and accepted: `position_opened` arrives, `activePosition` gains its id, and the window
 *    reads out the fill the way MetaTrader does, `sell 0.03 XAUUSD at 3082.07`.
 * 3. Sent and refused by the engine: an `error` frame rolls the optimistic position back and
 *    `lastTradeError` carries the reason. Watched by its timestamp, so two identical refusals in a
 *    row are two events.
 */
export function useOrderResult({ symbol, digits, lots, volDigits, priceOf }: {
  symbol: string;
  digits: number;
  lots: number;
  volDigits: number;
  /**
   * The position's entry RATE as a price on the instrument's own axis.
   *
   * `useOrderEntry.priceOfRate`, and not optional, because a position carries a rate and a trader
   * reads prices: printed raw, a gold fill at 3082.07 confirmed itself "at 0.30". A confirmation
   * showing a number the trader never saw on the chart is worse than no confirmation.
   */
  priceOf: (rate: number | null | undefined) => number | null;
}): {
  result: OrderResult | null;
  /** Hand it what `place()` returned, and it takes over from there. */
  report: (dir: Direction, outcome: 'sent' | 'deposit' | LocalRefusal) => void;
  /** MetaTrader's result is dismissed by acknowledging it, or by starting another order. */
  clear: () => void;
} {
  const { activePosition, lastTradeError } = useGameSocket();
  const [result, setResult] = useState<OrderResult | null>(null);
  /**
   * The error stamp that was already on the socket when this order went out.
   *
   * Without it the window shows the PREVIOUS order's rejection the moment a new one is sent, which
   * is worse than showing nothing: it says the trade failed when it is still in flight.
   */
  const sinceRef = useRef(0);
  /**
   * The claim that says "this window will print the rejection itself", so the socket does not also
   * raise a popup about it. Released the moment the order resolves or the result is dismissed, and
   * on unmount, or a window closed mid-order would silence refusals for good.
   */
  const releaseRef = useRef<null | (() => void)>(null);
  const release = () => { releaseRef.current?.(); releaseRef.current = null; };
  useEffect(() => release, []);

  const report = (dir: Direction, outcome: 'sent' | 'deposit' | LocalRefusal) => {
    if (outcome === 'deposit') {
      // The deposit sheet IS the surface for this one. A rejection in the window behind it would
      // be a second answer to one tap.
      setResult(null);
      return;
    }
    if (outcome === 'sent') {
      sinceRef.current = lastTradeError?.at ?? 0;
      release();
      releaseRef.current = claimOrderWindow();
      setResult({ kind: 'sending', direction: dir });
      return;
    }
    const { title, detail } = refusalReason(outcome);
    setResult({ kind: 'rejected', title, detail });
  };

  const clear = () => { release(); setResult(null); };

  // Accepted: the position has an id, so the engine has filled it.
  useEffect(() => {
    if (result?.kind !== 'sending') return;
    if (activePosition === null || activePosition.positionId === null) return;
    setResult({
      kind: 'done',
      line: fillLine({
        direction: activePosition.direction,
        lots,
        symbol,
        price: priceOf(activePosition.entryRate),
        digits,
        volDigits,
      }),
      ticket: activePosition.positionId,
    });
    release();
    // `lots` and the formatting inputs are read at the moment of the fill, deliberately: the figure
    // shown is the one that was traded, not whatever the stepper is on when the window is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePosition?.positionId, result?.kind]);

  // Refused by the engine: a fresh error, after this order went out.
  useEffect(() => {
    if (result?.kind !== 'sending') return;
    if (lastTradeError === null || lastTradeError.at <= sinceRef.current) return;
    setResult({ kind: 'rejected', title: lastTradeError.title, detail: lastTradeError.detail });
    release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTradeError?.at, result?.kind]);

  return { result, report, clear };
}
