'use client';

import { useEffect } from 'react';
import { lotsOfStake } from '@invest254/shared/account';
import { useVolumeDigits } from '@/lib/game/volumeDigits';
import { useDisplayMoney } from '@/lib/money';
import { useLevelsStore } from '@/lib/game/levelsStore';
import { levelPrice } from '@/lib/game/levelWatch';
import { cn } from '@/lib/cn';
import { ticketLabel, type ActivePosition } from '@/lib/game/betting';

/**
 * MetaTrader's Close position screen.
 *
 * This replaces a button that was invented. MT5 has a real form for closing a position, and it was
 * measured off MetaQuotes' own screenshots rather than remembered: see docs/mt5/01-order-and-close-dialogs.md.
 *
 * The model here is the ANDROID close screen, because this product is phone first and the Android
 * screen is the closest original:
 *
 *   title     "Close position #57040054558"
 *   subtitle  "buy 0.61 GBPUSD at 1.33629"
 *   body      volume stepper, prices, S/L and T/P rows, fill policy, the Attention warning
 *   action    TEXT, not a filled button: "CLOSE WITH PROFIT 334.89", the words in orange
 *             (#FF9300 measured) and the amount in blue
 *
 * The desktop variant is a different thing again: the same Order window retitled
 * "Position: #328906 buy 0.01 EURUSD 1.16082" with a pale cream button reading
 * "Close #328906 buy 0.01 EURUSD 1.16082 by Market". That one needs the Order window itself, which
 * is the next piece of work, so it is deliberately not faked here.
 *
 * Where this contract differs from a MetaTrader position, the form says so rather than rendering a
 * control that cannot work:
 *   - Volume is a VALUE, not a stepper. MT5 closes part of a position by typing a smaller volume;
 *     this engine settles a contract whole, so a stepper here would be a lie.
 *   - S/L is the stake. A losing contract is never sellable, so the most it can lose is fixed.
 *   - This screen only ever opens on a position that CAN be closed, which here means one in profit,
 *     so "CLOSE WITH PROFIT" is always the truthful label.
 */
const ORANGE = '#ff9300'; // measured from MetaQuotes' own Android close_position.png
const SL_ORANGE = '#dd5b4e'; // the S/L chip red/orange from the mobile order form
const TP_GREEN = '#0eb52e'; // the T/P chip green from the mobile order form
/** The terminal's own profit/loss pair, the same one every grid and the chart already use. */
const PROFIT_BLUE = '#3183ff';
const LOSS_RED = '#f23645';

export function MT5ClosePosition({
  pos, symbol, digits, price, openPrice, onDismiss, onConfirm, busy,
}: {
  pos: ActivePosition;
  symbol: string;
  digits: number;
  /** The live price, already mapped through the day anchor. */
  price: number | null;
  /**
   * The OPEN price, mapped the same way. MetaTrader quotes this in the symbol's digits on the
   * subtitle line; the raw engine rate is a 0..1 curve value and must never reach the screen.
   */
  openPrice: number | null;
  onDismiss: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const money = useDisplayMoney();
  /** The same level the ticket set and the chart drew, so this screen names the one TP there is. */
  const levels = useLevelsStore((s) => s.levels);
  const levelRef = useLevelsStore((s) => s.ref);
  const tpPrice = pos.tpPrice ?? levelPrice(levels, levelRef ?? openPrice, 'tp', digits);
  /** The ENGINE's stop, falling back to the local store the way the T/P row does. */
  const slPrice = pos.slPrice ?? levelPrice(levels, levelRef ?? openPrice, 'sl', digits);
  // Volume to the SYMBOL's own volume digits, so every surface states one lot size for one
  // position (docs/mt5/09-toolbox.md 300, rows at 313-318).
  const volumeDigits = useVolumeDigits(symbol);
  const lots = lotsOfStake(pos.stakeCents, volumeDigits);
  /**
   * What this close actually does to the trader's money. A position exactly flat closes at neither,
   * so it gets MetaTrader's bare verb rather than a sign it does not have.
   */
  const closeVerb = pos.livePnlCents > 0 ? 'Close with profit'
    : pos.livePnlCents < 0 ? 'Close with loss'
    : 'Close';

  // Escape closes the screen, as every MetaTrader dialog does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const px = (v: number | null) => (v === null ? '-' : v.toFixed(digits));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Close position ${ticketOf(pos)}`}
      className="fixed inset-0 z-[80] flex flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)] sm:items-center sm:justify-center sm:bg-black/60 sm:p-4"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col bg-[var(--mt5-surface)] sm:h-auto sm:max-w-[420px] sm:flex-none sm:rounded-sm sm:border sm:border-[var(--mt5-border)]">
        {/* Title block: MetaTrader names the ticket on the first line and the deal on the second. */}
        <div className="flex items-start gap-2 border-b border-[var(--mt5-border)] px-3 py-2.5">
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Back"
            className="-ml-1 shrink-0 px-1 text-[20px] leading-none text-[var(--mt5-muted)] transition hover:text-white"
          >
            ‹
          </button>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold leading-tight">
              Close position #{ticketOf(pos)}
            </span>
            <span className="block truncate font-mono text-[12px] leading-tight text-[var(--mt5-muted)]">
              {pos.direction} {lots} {symbol} at {px(openPrice)}
            </span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Volume. A value, not a stepper: see the note at the top of this file. */}
          <Row label="Volume">
            <span className="font-mono text-[14px] font-semibold tabular-nums">{lots}</span>
          </Row>
          <p className="px-3 pb-2 text-[11px] leading-snug text-[var(--mt5-muted)]">
            This contract closes in full. Partial close is a MetaTrader position feature that a
            fixed-term contract does not have.
          </p>

          {/* The price, large, as the mobile form shows it. One price, not two: this feed quotes a
              single rate, and rendering a fabricated bid/ask spread would be the exact kind of
              invention this screen exists to undo. */}
          <div className="flex items-end justify-center gap-2 border-y border-[var(--mt5-border)] px-3 py-4">
            <span className="font-mono text-[32px] font-semibold leading-none tabular-nums">
              {px(price)}
            </span>
          </div>

          {/*
            MetaTrader's S/L is a PRICE, and so is ours now.

            This row used to print the STAKE with "(max loss)" beside it, because the contract had no
            price-level stop to show. It has had one since docs/mt5/20-real-sl-tp.md, so the old row
            was claiming a stop was set on a position that might have none, while the Toolbox grid
            said "-" and the live panel said "not set" for the same position: three surfaces, three
            answers. `09-toolbox.md` 336-338 settles it, and MetaTrader's own answer for an unset
            level is blank — which this row still was not printing, so all three now are.
          */}
          <Row label="S / L" accent={SL_ORANGE}>
            <span className="font-mono text-[13px] tabular-nums text-[var(--mt5-muted)]">
              {slPrice === null ? '' : slPrice.toFixed(digits)}
            </span>
          </Row>
          <Row label="T / P" accent={TP_GREEN}>
            <span className="font-mono text-[13px] tabular-nums text-[var(--mt5-muted)]">
              {tpPrice === null ? '' : tpPrice.toFixed(digits)}
            </span>
          </Row>
          <Row label="Fill policy">
            <span className="font-mono text-[13px] text-[var(--mt5-muted)]">Fill or Kill</span>
          </Row>

          {/* MetaTrader's own warning, verbatim from the Android close screen. */}
          <p className="px-3 py-3 text-[11px] leading-snug text-[var(--mt5-muted)]">
            Attention! The trade will be executed at market conditions, difference with requested
            price may be significant!
          </p>
        </div>

        {/*
          The action. MetaTrader's Android close screen makes this TEXT, not a filled button: the
          words in orange and the amount in blue (`04-mobile-app.md` 314, `01` 584-586).

          The words follow the SIGN, which they did not before. This screen used to hard-code
          "Close with profit" on the reasoning, written into this file's own header, that "this
          screen only ever opens on a position that CAN be closed, which here means one in profit".
          That stopped being true when continuous pricing made a loser closable by hand: a trader
          closing at -246.16 was told, in orange, that they were closing with a profit.

          MetaQuotes' published screenshot happens to show a winner, so the docs record only the
          profit string. Rather than invent a verbatim loss string, this mirrors the sense of the one
          that IS recorded and colours the amount with the terminal's own profit-blue / loss-red
          pair, which is the rule everywhere else in this shell.
        */}
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="flex w-full shrink-0 items-center justify-center gap-2 border-t border-[var(--mt5-border)] px-3 py-4 text-[14px] font-bold uppercase tracking-wide transition disabled:opacity-50"
        >
          <span style={{ color: ORANGE }}>{busy ? 'Closing…' : closeVerb}</span>
          {busy ? null : (
            <span
              className="font-mono tabular-nums"
              style={{ color: pos.livePnlCents < 0 ? LOSS_RED : PROFIT_BLUE }}
            >
              {money.fmt(pos.livePnlCents)}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children, accent }: { label: string; children: React.ReactNode; accent?: string }) {
  return (
    <div
      className={cn('flex items-center justify-between gap-3 border-b px-3 py-2.5')}
      style={{ borderColor: accent ?? '#2b3543' }}
    >
      <span className="text-[12px] uppercase tracking-wide text-[var(--mt5-muted)]">{label}</span>
      {children}
    </div>
  );
}

/** MetaTrader's ticket, the one the confirmation names: `Close #328906 …`, 01-order-and-close-dialogs.md 155. */
function ticketOf(pos: ActivePosition): string {
  return ticketLabel(pos);
}
