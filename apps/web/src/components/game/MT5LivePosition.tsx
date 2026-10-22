'use client';

import { useEffect, useState } from 'react';
import { lotsOfStake } from '@invest254/shared/account';
import { useDisplayMoney } from '@/lib/money';
import { useVolumeDigits } from '@/lib/game/volumeDigits';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { MT5ClosePosition } from '@/components/game/MT5ClosePosition';
import { isContinuousBrand } from '@/lib/game/levelWatch';
import { useBrand } from '@/lib/brand/BrandProvider';
import { cn } from '@/lib/cn';
import type { ActivePosition } from '@/lib/game/betting';

/**
 * The open position, as MetaTrader shows one.
 *
 * The MT5 order ticket used to hand this job to `LivePnl` — the classic shell's card, with its
 * rounded pill, its "Live P&L" heading and its coloured progress bar. On a terminal that is the one
 * panel still speaking the old product's language, directly under a MetaTrader ticket.
 *
 * MetaTrader states a position as a line of identity (symbol, side, volume) over label/value rows,
 * with the profit as the one large figure, and it uses blue for a buy and red for a sell rather than
 * green/red for up/down. The expiry countdown has no MetaTrader equivalent — nothing in MT5 closes
 * itself on a timer — so it is stated plainly as a row rather than dressed as a progress bar.
 */
export function MT5LivePosition({ pos, symbol, digits, price, openPrice }: {
  pos: ActivePosition;
  symbol: string;
  digits: number;
  price: number | null;
  /** The position's entry, mapped through the day anchor into the symbol's own price. */
  openPrice: number | null;
}) {
  const money = useDisplayMoney();
  // Volume to the SYMBOL's own volume digits, so this card and the ticket that opened the position
  // state one lot size (docs/mt5/09-toolbox.md 300).
  const volumeDigits = useVolumeDigits(symbol);
  const lots = lotsOfStake(pos.stakeCents, volumeDigits);
  const { sell, earlyCloseEnabled } = useGameSocket();
  const brand = useBrand();
  /**
   * Whether the engine acts on the levels at all: a brand with a price axis, pool mode off. The same
   * test `openPosition` makes, and NOT `earlyCloseEnabled` alone, which a line brand also reports.
   */
  const continuous = isContinuousBrand({ chartStyle: brand.chartStyle, earlyCloseEnabled });
  // MetaTrader does not close a position straight off a button: it opens the Close position form.
  // See docs/mt5/01-order-and-close-dialogs.md; the one-click close without confirmation is the
  // cross in the Trade tab's Profit column, which is a different control and already correct.
  const [closing, setClosing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  const totalMs = pos.durationS * 1000;
  const remainingMs = pos.expiresAtMs ? Math.max(0, pos.expiresAtMs - now) : totalMs;
  const progress = totalMs > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / totalMs)) : 0;
  const secs = Math.ceil(remainingMs / 1000);
  const isBuy = pos.direction === 'buy';
  const side = isBuy ? '#3183ff' : '#f23645';
  const pnl = pos.livePnlCents;
  // MetaTrader paints a profit BLUE and a loss RED. Not green: green in MT5 belongs to a rising
  // candle, and using it for money made the one figure a trader reads say "casino win" rather than
  // "position in profit". The Trade tab, the Toolbox and this card now agree.
  const pnlTone = pnl > 0 ? 'text-[var(--mt5-blue)]' : pnl < 0 ? 'text-[var(--mt5-red)]' : 'text-white';

  const state =
    pos.phase === 'pending' ? 'Opening…' : pos.phase === 'settling' ? 'Closing…' : `${secs}s`;

  // MetaTrader closes a position from the position itself, so the control belongs here. It is shown
  // only where the engine will honour it (see `earlyCloseEnabled`), and it says why it cannot be
  // pressed rather than sitting there greyed and silent.
  const closable = pos.phase === 'open' && pos.sellable && !!pos.positionId;
  const closeWhy = pos.phase === 'settling'
    ? 'Closing…'
    : !pos.sellable
      ? 'Closes at expiry'
      : 'Close position';

  return (
    <div className="flex flex-col gap-2">
      {/* Identity, the way MetaTrader heads a position: symbol, then side and volume in the side's
          own colour. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] font-bold text-white">{symbol}</span>
        <span className="shrink-0 font-mono text-[12px] font-semibold uppercase" style={{ color: side }}>
          {pos.direction} {lots}
        </span>
      </div>

      {/* The profit, which is the number a trader is actually watching. */}
      <div className="flex items-end justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-[var(--mt5-muted)]">Profit</span>
        <span className={cn('font-mono text-[22px] font-semibold leading-none tabular-nums', pnlTone)}>
          {pnl > 0 ? '+' : ''}{money.mt(pnl)}
        </span>
      </div>

      {/*
        * MetaTrader's open position carries its LEVELS, not a countdown.
        *
        * Its position row is Symbol / Type / Volume / Price / S/L / T/P / Price / Swap / Profit:
        * there is no expiry on a MetaTrader position, so there is nothing to count down. This said
        * "Expires in 8s", which was honest while a contract had a term and became nonsense the
        * moment the horizon became an hour-long backstop rather than the trade's whole character.
        *
        * S/L and T/P are the ENGINE's, read off the position rather than the ticket's working copy,
        * because those are the ones that will actually fire. An unset one is BLANK: docs/mt5/09-toolbox.md
        * 336-338, "the cell is blank and no × is drawn". This card said "not set" while the Trade
        * grid said "-" and the close form said "not set" again, so one position had three answers.
        */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums">
        <Row label="Volume" value={lots} />
        {/* MetaTrader's row carries BOTH prices: the one it opened at and the one it is at now.
            Without the open price the S/L and T/P rows are numbers with nothing to read them
            against, which is the state this card was in. */}
        <Row label="Price" value={openPrice === null ? '-' : openPrice.toFixed(digits)} />
        <Row label="S / L" value={pos.slPrice === null ? '' : pos.slPrice.toFixed(digits)} />
        <Row label="T / P" value={pos.tpPrice === null ? '' : pos.tpPrice.toFixed(digits)} />
        <Row label="Price" value={price === null ? '-' : price.toFixed(digits)} />
        {/* The one figure on this card that names its currency, and the only row here that is not
            one of MetaTrader's: the strip names the code once after Balance and leaves every other
            figure bare (09-toolbox.md 429), and this card has no strip to name it. */}
        <Row label="Stake" value={money.fmt(pos.stakeCents)} />
        {pos.phase === 'open' ? null : <Row label="State" value={state} />}
      </dl>

      {/* A one-pixel rule rather than a coloured bar: it is chrome telling the time, and MetaTrader
          does not decorate a position with a progress meter. */}
      <div className="h-px w-full bg-[var(--mt5-border)]">
        <div
          className="h-px transition-[width] duration-100 ease-linear"
          style={{ width: `${progress * 100}%`, background: side }}
        />
      </div>
      {earlyCloseEnabled ? (
        <button
          type="button"
          onClick={() => setClosing(true)}
          disabled={!closable}
          title={pos.sellable ? 'Close this position at the current price' : 'This contract settles at expiry'}
          className="h-9 w-full rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] text-[12px] font-semibold text-[var(--mt5-text)] transition hover:border-[var(--mt5-blue)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {closeWhy}
        </button>
      ) : null}
      {/*
        MetaTrader prints NO sentence under a position.

        Its row is Symbol / Ticket / Time / Type / Volume / Price / S/L / T/P / Price / Profit and
        stops there (docs/mt5/09-toolbox.md 258). This card carried two lines that were not
        MetaTrader's and were no longer true: "Closes automatically at expiry: market execution." and
        "Market execution. Left alone, it closes itself at expiry." A MetaTrader position has no
        expiry to close at, and on a brand with a price axis this one does not either in any sense a
        trader would recognise: it ends at its stop, its target, a manual close, or a horizon that is
        a backstop rather than the trade's character (docs/mt5/20-real-sl-tp.md 122-125).

        A brand with NO axis is the one case where the contract really does end on a term, which
        MetaTrader has no equivalent for. That divergence is stated once, plainly, and only there.
      */}
      {continuous ? null : (
        <p className="text-[10px] text-[var(--mt5-muted)]">
          This contract runs to its term: {pos.durationS}s from opening.
        </p>
      )}

      {closing ? (
        <MT5ClosePosition
          pos={pos}
          symbol={symbol}
          digits={digits}
          price={price}
          openPrice={openPrice}
          busy={pos.phase === 'settling'}
          onDismiss={() => setClosing(false)}
          // This card's OWN position. A bare `sell()` closes whichever one the provider holds as
          // newest, which was this one when only one could exist; several can now, and a card drawn
          // for a position has to close the position it was drawn for.
          onConfirm={() => { sell(pos.positionId ?? undefined); setClosing(false); }}
        />
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--mt5-muted)]">{label}</dt>
      <dd className="text-right text-white">{value}</dd>
    </>
  );
}
