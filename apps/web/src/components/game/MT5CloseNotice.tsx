'use client';

import { lotsOfStake } from '@invest254/shared/account';
import { useDisplayMoney } from '@/lib/money';
import { useVolumeDigits } from '@/lib/game/volumeDigits';
import { cn } from '@/lib/cn';
import type { OutcomeFx } from '@/lib/game/outcomeFx';

/**
 * How MetaTrader actually reports a closed position.
 *
 * It does not open a dialog. Checked against the real terminal: when a position closes the row
 * simply leaves the Trade tab, the deal appears in History and a line is written to the Journal.
 * The only thing that pops is the optional push notification, which is a short, non-blocking line:
 * the symbol, the side and volume, and the profit. There is no headline, no "Collect", no amount
 * counting up, and nothing to dismiss before trading again.
 *
 * So this is a notification, not a dialog: it takes no focus, blocks no clicks, and the chart and
 * the ticket stay live underneath it. The classic shell keeps its celebration; a terminal gets this.
 */
export function MT5CloseNotice({ fx, visible, onDismiss }: {
  fx: OutcomeFx;
  visible: boolean;
  onDismiss: () => void;
}) {
  const money = useDisplayMoney();
  /**
   * The volume prints to the SETTLED symbol's digits, like every other surface.
   *
   * It comes in ON THE OUTCOME, not from the game socket. This used to call `useGameSocketApi()`,
   * and this component is rendered by `OutcomeOverlay`, which `Providers` mounts ABOVE
   * `GameSocketProvider`: that hook throws outside its provider, so the first position to close
   * threw inside render, the error boundary caught it, and the entire terminal unmounted. From the
   * trader's side a closed trade simply took the screen, the Trade buttons and all, which is the
   * worst possible moment to lose them. The provider fires the outcome and knows the symbol, so it
   * states it, exactly as this comment used to say it should.
   */
  const settledSymbol = fx.symbol ?? 'XAUUSD';
  const volDigits = useVolumeDigits(settledSymbol);
  const won = fx.result === 'win';
  // MetaTrader's money colours: blue for a profit, red for a loss. Never green.
  const tone = fx.pnlCents > 0 ? 'text-[var(--mt5-blue)]' : fx.pnlCents < 0 ? 'text-[var(--mt5-red)]' : 'text-white';
  const sideTone = fx.direction === 'sell' ? 'text-[var(--mt5-red)]' : 'text-[var(--mt5-blue)]';

  return (
    // The wrapper spans the screen only so the card can be placed in a corner; it never takes a
    // pointer event, which is the whole point of not being a dialog.
    <div
      // Below the app header rather than over it: a notification that covers the brand bar reads as a
      // rendering fault rather than as a notification.
      className="pointer-events-none fixed inset-x-0 top-12 z-[70] flex justify-center px-3 sm:top-14 sm:justify-end sm:px-4"
      aria-live="polite"
    >
      <div
        className={cn(
          'w-full max-w-[320px] overflow-hidden rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] shadow-lg transition-all duration-200',
          // On the way out it must stop taking clicks before it stops being painted, or an
          // invisible card sits over the screen for the length of the fade.
          visible ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0',
        )}
      >
        <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--mt5-muted)]">
            {fx.mode === 'manual' ? 'Position closed' : 'Position closed at expiry'}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="ml-auto -mr-1 px-1 text-[13px] leading-none text-[var(--mt5-muted)] transition hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="flex items-baseline justify-between gap-3 px-3 py-2 font-mono text-[12px] tabular-nums">
          <span className="min-w-0 truncate text-[var(--mt5-muted)]">
            {fx.ticket ? <span className="text-white">#{fx.ticket.slice(0, 8)}</span> : null}{' '}
            {fx.direction ? <span className={sideTone}>{fx.direction}</span> : null}{' '}
            {lotsOfStake(fx.stakeCents, volDigits)}
          </span>
          <span className={cn('shrink-0 text-[15px] font-semibold', tone)}>
            {won ? '+' : ''}{money.fmt(fx.pnlCents)}
          </span>
        </div>
      </div>
    </div>
  );
}
