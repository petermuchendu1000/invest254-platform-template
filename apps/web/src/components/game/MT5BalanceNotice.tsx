'use client';

import { useDisplayMoney } from '@/lib/money';
import { cn } from '@/lib/cn';

/**
 * How MetaTrader reports money arriving that was not a trade.
 *
 * A broker credit is a **balance operation**: MetaTrader records it in History as a deal whose Type
 * is `balance` rather than `buy` or `sell`, writes a line to the Journal, and raises the ordinary
 * notification. It does not celebrate. There is no confetti, no counting up, no gold card and no
 * "Deposit and play" call to action, because a terminal's job is to report what happened to the
 * account and then get out of the way.
 *
 * So this is the same non-blocking notification shape as `MT5CloseNotice`: it takes no focus,
 * blocks no clicks, and the chart and the ticket stay live underneath. The classic shell keeps its
 * celebration (`WelcomeBonusOverlay`), which is a different product making a different promise.
 */
export function MT5BalanceNotice({ amountCents, visible, onDismiss, comment }: {
  amountCents: number;
  visible: boolean;
  onDismiss: () => void;
  /** MetaTrader shows the broker's own comment against a balance operation. */
  comment: string;
}) {
  const money = useDisplayMoney();
  // MetaTrader's money colours: blue for money in, never green.
  const tone = amountCents >= 0 ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]';

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-12 z-[70] flex justify-center px-3 sm:top-14 sm:justify-end sm:px-4"
      aria-live="polite"
    >
      <div
        role="status"
        data-mt5-balance-notice=""
        className={cn(
          'pointer-events-auto w-full max-w-sm rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-3 py-2 shadow-xl transition',
          visible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0',
        )}
      >
        <div className="flex items-baseline gap-2">
          {/* MetaTrader's own name for a non-trade credit, and the word it files it under. */}
          <span className="text-[11px] font-semibold text-white">Balance operation</span>
          <span className={cn('ml-auto shrink-0 font-mono text-[13px] font-semibold tabular-nums', tone)}>
            {amountCents >= 0 ? '+' : ''}{money.fmt(amountCents)}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 px-1 text-[14px] leading-none text-[var(--mt5-muted)] transition hover:text-white"
          >
            ×
          </button>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-[var(--mt5-muted)]">{comment}</p>
      </div>
    </div>
  );
}
