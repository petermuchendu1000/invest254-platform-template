'use client';

import { cn } from '@/lib/cn';
import { useDisplayMoney } from '@/lib/money';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { MK } from '@/lib/marketer/labels';
import type { Direction } from '@invest254/shared';

/**
 * CURRENT TRADE — what the panel shows while a contract is in flight.
 *
 * The screen it copies replaces the whole order form with this while a trade runs, rather than
 * tucking a P&L figure under a form the trader can no longer use. That is the right call and this
 * follows it: during a contract there is exactly one thing on this panel, and it is the contract.
 *
 * ONE COMPONENT, TWO SOURCES. It is handed plain numbers, not a position object, so the same panel
 * renders a REAL contract (figures from the engine's `position_update`) and a GUEST DEMO one
 * (figures simulated in the browser — see `lib/game/demoTrade`). Keeping it ignorant of which is
 * which is what stops the two drifting into different-looking screens; keeping the DEMO label on
 * the shell rather than in here is what stops it ever being wrong about which money is at stake.
 *
 * The progress bar and the big block take the DIRECTION's colour, not the P&L's — a sell that is
 * winning is still a sell. The P&L figure itself is the thing that goes green or red.
 */
export function CurrentTradePanel({
  direction,
  market,
  entryPrice,
  priceDigits,
  stakeCents,
  secondsLeft,
  progress,
  livePnlCents,
  estReturnCents,
  livePrice,
  phase,
  onClose,
  closeDisabled,
  className,
}: {
  direction: Direction;
  /** The instrument, as the mock names it beside the side: "GLOBAL/KES". */
  market: string;
  entryPrice: number | null;
  priceDigits: number;
  stakeCents: number;
  secondsLeft: number;
  /** 0..1 through the contract. */
  progress: number;
  livePnlCents: number;
  estReturnCents: number;
  livePrice: number | null;
  phase: 'pending' | 'open' | 'settling';
  /** Early close, when the brand allows it. Omitted entirely when it does not. */
  onClose?: () => void;
  closeDisabled?: boolean;
  className?: string;
}) {
  const { fmt } = useDisplayMoney();
  const { isMarketer } = useMarketerSkin();
  const buy = direction === 'buy';
  const up = livePnlCents >= 0;

  const price = (v: number | null) => (v === null ? '—' : v.toFixed(priceDigits));

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col', className)}>
      <h2 className="mb-3 shrink-0 text-xs font-bold uppercase tracking-widest text-muted">Current Trade</h2>

      {/* The mock's label/value ledger. `tabular-nums` throughout so nothing shifts as it ticks. */}
      <dl className="mb-4 shrink-0 space-y-2.5 text-sm">
        <Row label="Current Trade">
          {/* MARKETER: a wordless arrow and one neutral accent, never BUY/SELL and never the
              green/red pair — the same substitution `LivePnl` makes, for the same reason. */}
          <span className={cn('font-bold', isMarketer ? 'text-accent' : buy ? 'text-up' : 'text-down')}>
            {isMarketer ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="inline h-3.5 w-3.5" role="img" aria-label={buy ? 'Up' : 'Down'}>
                <path d={buy ? 'M12 19V5M5 12l7-7 7 7' : 'M12 5v14M5 12l7 7 7-7'} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (buy ? 'BUY' : 'SELL')}
          </span>{' '}
          <span className="text-muted">{market}</span>
        </Row>
        <Row label="Entry Price">
          <span className="font-mono font-bold tabular-nums text-fg">{price(entryPrice)}</span>
        </Row>
        <Row label="Invested">
          <span className="font-bold tabular-nums text-fg">{fmt(stakeCents)}</span>
        </Row>
        <Row label="Auto Sell">
          {/* Amber, because it is the one figure here that is counting DOWN on the trader. */}
          <span className="font-bold tabular-nums text-warn">{secondsLeft}s</span>
        </Row>
        <Row label={isMarketer ? MK.liveValue : 'Live P&L'}>
          <span className={cn('font-bold tabular-nums', isMarketer ? 'text-fg' : up ? 'text-up' : 'text-down')}>
            {up ? '+' : '−'}{fmt(Math.abs(livePnlCents))}
          </span>
        </Row>
        <Row label="Est. Return">
          <span className="font-bold tabular-nums text-accent">{fmt(Math.max(0, estReturnCents))}</span>
        </Row>
      </dl>

      {/*
        The big block. It is a STATUS, not a button — nothing here is pressable, so it is a div with
        a live region rather than a disabled button a trader would keep tapping.
      */}
      <div
        className={cn(
          'shrink-0 rounded-xl px-4 py-4 text-center',
          isMarketer ? 'bg-accent/15' : buy ? 'bg-up/15' : 'bg-down/15',
        )}
        role="status"
        aria-live="polite"
      >
        <div className={cn('text-sm font-extrabold uppercase tracking-wide', isMarketer ? 'text-accent' : buy ? 'text-up' : 'text-down')}>
          {phase === 'settling' ? 'Settling…' : `Processing trade (${secondsLeft}s)`}
        </div>
        <div className="mt-1 text-xl font-black tabular-nums text-fg">{fmt(Math.max(0, estReturnCents))}</div>

        {/* The fill is the contract's own progress, so the bar and the countdown cannot disagree. */}
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-fg/10">
          <div
            className={cn('h-full rounded-full transition-[width] duration-200 ease-linear', isMarketer ? 'bg-accent' : buy ? 'bg-up' : 'bg-down')}
            style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
          />
        </div>
      </div>

      {/* The live price under the block, as the mock prints it. */}
      <p className="mt-2 shrink-0 text-center text-xs text-muted">
        Live: <span className="font-mono tabular-nums text-fg">{price(livePrice)}</span>
      </p>

      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          disabled={closeDisabled}
          className="mt-3 h-11 w-full shrink-0 rounded-lg bg-surface-2 text-sm font-bold text-fg transition-colors hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === 'settling' ? 'Closing…' : 'Close Trade'}
        </button>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}
