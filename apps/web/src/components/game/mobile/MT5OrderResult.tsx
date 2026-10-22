'use client';

import type { OrderResult } from '@/lib/game/orderResult';

/**
 * MetaTrader's execution result, in the order window.
 *
 * *"Once an order is sent, its execution results will appear in the window: either confirmation of
 * a successful trade or a rejection with the reason specified"* (docs/mt5/04-mobile-app.md section
 * 5, documented for both platforms). MetaTrader puts it over the order form it was sent from, not
 * in a floating card somewhere else, and the form stays underneath: that is what "in the window"
 * means, and it is why this is a panel rather than a toast.
 *
 * ── Why not a popup ─────────────────────────────────────────────────────────────────────────────
 * Android CAN show trade results as chart pop-ups, but only with the "Trade notifications" chart
 * setting on, and that is the chart, not the order window. The terminal shell's own confirmation
 * toast was removed for exactly this reason; the rejection one stays for the surfaces that have no
 * window of their own (the one-click panel firing instantly, the desktop shell).
 *
 * ── The wording ─────────────────────────────────────────────────────────────────────────────────
 * `Done` is MetaTrader's word for a filled order, the one its own Journal and History use, and the
 * fill reads in its phrasing: `sell 0.03 XAUUSD at 3082.07`. The ticket number is MetaTrader's
 * `#` prefix, shortened, because this engine's position ids are uuids and a trader needs a handle,
 * not thirty-six characters.
 */
export function MT5OrderResult({ result, onDismiss, placement = 'overlay' }: {
  result: OrderResult;
  /** MetaTrader's result is acknowledged, and the window goes back to the form. */
  onDismiss: () => void;
  /**
   * Where the panel sits, because MetaTrader's two order windows are different shapes.
   *
   * `overlay` is the PHONE's: a full-screen order window whose result rises over the bottom of the
   * form, which is where MetaTrader's own mobile result appears and where the form's action button
   * already is. Nothing is lost, because that window exists only to send this one order.
   *
   * `inline` is the DOCKED desktop ticket's, and it is not a style choice. That ticket is a
   * permanent panel, not a modal: the trader goes back to it to place the next order. Pinned to the
   * bottom the panel landed squarely on `Sell by Market` and `Buy by Market` and stayed there until
   * it was dismissed, so a filled order took the trade buttons away with it. In flow it says the
   * same thing in the same window, at the top of the ticket, with the buttons still reachable.
   */
  placement?: 'overlay' | 'inline';
}) {
  const rejected = result.kind === 'rejected';
  return (
    <div
      role="status"
      aria-live="polite"
      data-order-result={result.kind}
      data-order-result-placement={placement}
      className={
        placement === 'overlay'
          ? 'absolute inset-x-0 bottom-0 z-10 border-t bg-[var(--mt5-surface)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3'
          : 'rounded-sm border bg-[var(--mt5-surface)] px-3 pb-3 pt-2.5'
      }
      style={placement === 'overlay'
        ? { borderTopColor: rejected ? '#f23645' : '#2b3543' }
        : { borderColor: rejected ? '#f23645' : '#2b3543' }}
    >
      {result.kind === 'sending' ? (
        <>
          <div className="flex items-center gap-2">
            {/* MetaTrader waits here too: the order is with the server and nothing is known yet. */}
            <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--mt5-blue)]" />
            <span className="text-[14px] font-semibold text-white">
              Sending {result.direction === 'buy' ? 'buy' : 'sell'} order
            </span>
          </div>
          <p className="pt-1 text-[11px] text-[var(--mt5-muted)]">
            The order fills at the next engine tick.
          </p>
        </>
      ) : result.kind === 'done' ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-bold text-[var(--mt5-green)]">Done</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-white tabular-nums">
              {result.line}
            </span>
          </div>
          {result.ticket === null ? null : (
            <p className="pt-1 font-mono text-[11px] text-[var(--mt5-muted)] tabular-nums">
              #{result.ticket.slice(0, 8)}
            </p>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="mt-2 h-9 w-full rounded bg-[var(--mt5-raised)] text-[13px] font-semibold text-[var(--mt5-blue)]"
          >
            OK
          </button>
        </>
      ) : (
        <>
          <div className="text-[14px] font-bold text-[var(--mt5-red)]">{result.title}</div>
          {result.detail === undefined ? null : (
            <p className="pt-1 text-[11px] leading-snug text-[var(--mt5-muted)]">{result.detail}</p>
          )}
          {/* MetaTrader's requote flow ends on an `OK` that "returns you to the order screen", and a
              plain rejection is acknowledged the same way. */}
          <button
            type="button"
            onClick={onDismiss}
            className="mt-2 h-9 w-full rounded bg-[var(--mt5-raised)] text-[13px] font-semibold text-[var(--mt5-blue)]"
          >
            OK
          </button>
        </>
      )}
    </div>
  );
}
