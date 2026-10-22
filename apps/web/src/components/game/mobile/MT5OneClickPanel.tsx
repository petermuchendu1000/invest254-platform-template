'use client';

import { useEffect, useRef, useState } from 'react';
import { useDisplayMoney } from '@/lib/money';
import { useOrderEntry, durationLabel } from '@/lib/game/useOrderEntry';
import { oneClickTint, ONE_CLICK_FILL, useOneClickStore } from '@/lib/game/oneClick';
import { MT5Price } from '@/components/game/MT5Price';
import { cn } from '@/lib/cn';

/**
 * MetaTrader mobile's one-click trading panel.
 *
 * `[ SELL \n price ]  [ ⌄ volume ⌃ ]  [ BUY \n price ]`, which is the layout MetaQuotes documents
 * identically on both platforms (docs/mt5/04-mobile-app.md section 3):
 *
 *   "The word SELL / BUY is small and in the block's top-left corner; the price is large beneath it
 *    with enlarged last digits. The middle is a white volume stepper with chevron-down (decrease)
 *    and chevron-up (increase) around the lot value."
 *
 * Both blocks are the same colour, tinted by the last tick's direction rather than by side — see
 * lib/game/oneClick, which records which half of that is measured and which is inferred.
 *
 * ── Placement ────────────────────────────────────────────────────────────────────────────────────
 * MetaTrader puts the panel under the chart's top bar by default, and along the BOTTOM edge when
 * "One Click panel at the bottom" (Android: "Trading Panel at the Bottom") is on. This shell takes
 * the bottom option, because the phone screen already ends in MetaTrader's five-tab bar and the
 * panel wants to be where the thumb is. Both placements are MetaTrader's; this is a choice between
 * two of its own settings, not a departure from them.
 *
 * ── The bid on SELL and the ask on BUY ───────────────────────────────────────────────────────────
 * MetaQuotes' layout is literally `[ SELL \n <bid price> ] [ stepper ] [ BUY \n <ask price> ]`
 * (04-mobile-app.md 165), and this panel now prints those two numbers.
 *
 * It used to print one, in both blocks, under a comment saying a bid and an ask would "tell the
 * player they buy at one and sell at the other, and that is false". That was true when it was
 * written and has not been true since the engine began publishing the spread it charges: `cost` in
 * the continuous payout IS the spread, a trader does buy at the ask and sell at the bid, and the
 * single number was the misleading rendering. Both sides come from `bidAsk`, which is the same
 * arithmetic over the same quote that the order ticket and the Quotes rows use, so no surface on
 * this phone can quote a different price from another.
 *
 * `bidAsk` is null on a brand that publishes no spread, and there the panel falls back to the one
 * price it always showed — because on that brand one price is the truth.
 */
export function MT5OneClickPanel({ onOpenTicket }: { onOpenTicket: () => void }) {
  const money = useDisplayMoney();
  const {
    ready, symbol, settledSymbol, digits, price, bidAsk, tradeDisabled, connecting,
    lots, minLots, maxLots, volDigits, bump, setLots, volNote, stakeCents, durationS, place,
    chartSettled, continuous,
  } = useOrderEntry();
  /**
   * MetaTrader's one-click volume is a FIELD, not a readout: "the volume field sits between them
   * with a dropdown caret on the left and a spinner on the right"
   * (docs/mt5/01-order-and-close-dialogs.md 4.1). Ours was a `<span>`, so when the brand's
   * minimum met its maximum both chevrons disabled and the panel had no volume control left.
   */
  const [typingVol, setTypingVol] = useState<string | null>(null);
  const commitVol = () => {
    if (typingVol === null) return;
    const n = Number(typingVol);
    setTypingVol(null);
    if (Number.isFinite(n) && n > 0) setLots(n);
  };
  const atMin = `Minimum volume ${minLots.toFixed(volDigits)} lots.${volNote === null ? '' : ` ${volNote}`}`;
  const atMax = `Maximum volume ${maxLots.toFixed(volDigits)} lots.${volNote === null ? '' : ` ${volNote}`}`;
  const instant = useOneClickStore((s) => s.instant);

  /**
   * The tint's input: which way the price last MOVED, and when.
   *
   * MetaTrader's panel is coloured by the tick, so this tracks the price rather than deriving the
   * colour from the side. A repeated identical quote is not a change, which is what makes the
   * fifteen-second staleness rule in `quoteTone` mean anything.
   */
  const seen = useRef<{ price: number | null; up: boolean | null; changedAt: number | null }>({
    price: null, up: null, changedAt: null,
  });
  const [, force] = useState(0);
  if (price !== null && price !== seen.current.price) {
    const prev = seen.current.price;
    seen.current = {
      price,
      up: prev === null ? seen.current.up : price > prev,
      changedAt: prev === null ? seen.current.changedAt : Date.now(),
    };
  }
  // The staleness rule is time-based, so the panel has to re-render while nothing is arriving or it
  // would hold its colour for ever on a dead feed — the exact bug `quoteTone` was written against.
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, []);
  const tint = oneClickTint({ up: seen.current.up, changedAt: seen.current.changedAt, now: Date.now() });
  const fill = ONE_CLICK_FILL[tint];

  if (!ready) return <div className="h-[72px] shrink-0 animate-pulse border-t border-[var(--mt5-border)] bg-[var(--mt5-surface)]" />;

  /**
   * A tap fires, or opens the ticket.
   *
   * MetaTrader: "If 'One Click Trading' is off in settings, tapping BUY/SELL opens the trading
   * dialog instead of firing immediately." Off is its default and this shell's, so by default the
   * panel is a quote display with a shortcut into the New Order screen rather than a live trigger
   * under the thumb.
   */
  const tap = (dir: 'buy' | 'sell') => {
    if (tradeDisabled || connecting) return;
    if (instant) place(dir);
    else onOpenTicket();
  };

  const side = (dir: 'buy' | 'sell') => (
    <button
      type="button"
      onClick={() => tap(dir)}
      disabled={tradeDisabled || connecting}
      aria-label={`${dir === 'sell' ? 'Sell' : 'Buy'} ${lots.toFixed(volDigits)} ${symbol}${instant ? '' : ' (opens the order ticket)'}`}
      /**
       * `transition-[filter,opacity]`, not a blanket `transition`.
       *
       * The fill is this block's tick colour, and a blanket transition animates it: changing from
       * the measured red to the documented blue cross-faded through a purple that is neither, and a
       * colour sampled mid-flight was neither of MetaTrader's two states. MetaTrader's panel snaps.
       * The press dim is a filter, so that is what keeps its transition.
       */
      className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5 rounded px-2 py-1.5 text-left transition-[filter,opacity] active:brightness-90 disabled:opacity-50"
      style={{ background: fill }}
    >
      {/* "small and in the block's top-left corner" */}
      <span className="text-[10px] font-bold uppercase leading-none tracking-wider text-white/90">
        {dir}
      </span>
      {/* "the price is large beneath it with enlarged last digits" — MT5Price is that typography.
          The SELL block carries the bid and the BUY block the ask: the price each side would
          actually execute at, which is the number a trader is being asked to accept. */}
      <MT5Price
        value={bidAsk === null ? price : dir === 'sell' ? bidAsk.bid : bidAsk.ask}
        digits={digits}
        className="text-[13px] font-semibold text-white"
      />
    </button>
  );

  const chev = 'grid h-7 w-6 shrink-0 place-items-center rounded text-[#0f1720] transition active:bg-black/10 disabled:opacity-30';

  return (
    <div className="shrink-0 border-t border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-2 py-1.5">
      <div className="flex items-stretch gap-1.5">
        {side('sell')}
        {/* "a white volume stepper with chevron-down (decrease) and chevron-up (increase) around the
            lot value" — white on both platforms, against whatever colour the side blocks are. */}
        {/* `overflow-hidden` is load-bearing. The stepper is a fixed width and its three children
            are intrinsically sized, so on a 360px phone the increase chevron overflowed the white
            block, landed on top of the BUY button and stopped being clickable at all: the later
            sibling paints over it. Clipping the block and letting the number take the slack keeps
            every control inside its own box at any width. */}
        <div className="flex w-[112px] shrink-0 flex-col items-center justify-center overflow-hidden rounded border border-[var(--mt5-border)] bg-white px-0.5">
          <div className="flex w-full items-center justify-between gap-0.5">
            <button
              type="button"
              onClick={() => bump(-0.01)}
              disabled={lots <= minLots}
              title={lots <= minLots ? atMin : undefined}
              aria-label="Decrease volume"
              className={chev}
            >
              <Chevron down />
            </button>
            {typingVol === null ? (
              <button
                type="button"
                onClick={() => setTypingVol(lots.toFixed(volDigits))}
                title={`Volume in lots. Type a value between ${minLots.toFixed(volDigits)} and ${maxLots.toFixed(volDigits)}.`}
                aria-label={`Volume ${lots.toFixed(volDigits)} lots`}
                className="min-w-0 flex-1 text-center font-mono text-[13px] font-bold text-[#0f1720] tabular-nums"
              >
                {lots.toFixed(volDigits)}
              </button>
            ) : (
              <input
                autoFocus
                value={typingVol}
                inputMode="decimal"
                aria-label="Volume in lots"
                onChange={(e) => setTypingVol(e.target.value)}
                onBlur={commitVol}
                onKeyDown={(e) => { if (e.key === 'Enter') commitVol(); if (e.key === 'Escape') setTypingVol(null); }}
                className="w-0 min-w-0 flex-1 bg-transparent text-center font-mono text-[13px] font-bold text-[#0f1720] outline-none tabular-nums"
              />
            )}
            <button
              type="button"
              onClick={() => bump(0.01)}
              disabled={lots >= maxLots}
              title={lots >= maxLots ? atMax : undefined}
              aria-label="Increase volume"
              className={chev}
            >
              <Chevron />
            </button>
          </div>
          {/* NOT MetaTrader's: lots are an abstraction over a staked amount here, and the amount is
              the thing a player is actually risking. Hiding it behind a lot figure on the one
              control that can open a position would be the least honest screen in the product. */}
          {/* The amount, and a term ONLY where there still is one: a continuous brand ignores the
              client's duration entirely (see MT5MobileOrder's Expiry note), so printing one here
              would advertise a term this trade does not have. */}
          <span className="-mt-0.5 font-mono text-[9px] leading-none text-[#0f1720]/70 tabular-nums">
            {money.fmt(stakeCents)}{continuous ? '' : ` · ${durationLabel(durationS)}`}
          </span>
        </div>
        {side('buy')}
      </div>

      {tradeDisabled ? (
        /* MetaTrader's own words for a symbol a broker quotes but will not accept an order on. */
        <p data-trade-disabled="" className="pt-1 text-center text-[10px] leading-snug text-[#f0b90b]">
          Trade disabled for {symbol}.{' '}
          <button type="button" onClick={chartSettled} className="underline underline-offset-2">
            Chart {settledSymbol}
          </button>{' '}
          to place an order.
        </p>
      ) : connecting ? (
        <p className="pt-1 text-center text-[10px] text-[var(--mt5-muted)]">Connecting…</p>
      ) : (
        <p className={cn('pt-1 text-center text-[10px] leading-none text-[var(--mt5-muted)]')}>
          {instant ? 'One-click trading is on: a tap places this order.' : 'Tap a side to open the order ticket.'}
        </p>
      )}
    </div>
  );
}

/**
 * The stepper's chevrons, drawn rather than typed.
 *
 * They were `⌄` and `⌃` (U+2304/U+2303). The down one rendered and the up one came out blank, which
 * on the only control that changes the stake is not a cosmetic problem.
 */
function Chevron({ down = false }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <path d={down ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'} />
    </svg>
  );
}
