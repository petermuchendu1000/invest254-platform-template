'use client';

import { useEffect } from 'react';
import { lotsOfStake } from '@invest254/shared/account';
import { useVolumeDigits } from '@/lib/game/volumeDigits';
import { useDisplayMoney } from '@/lib/money';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { dealResultLabel } from '@/lib/game/dealWording';
import { positionTicket, priceText } from '@/lib/history/mt5history';
import { XAUUSD } from '@invest254/shared/candles';
import { MT5TitleBar, MT5Summary, MT5SummaryLine } from '@/components/mt5/kit';
import { cn } from '@/lib/cn';
import { Modal } from '@/components/ui/Modal';
import { DisplayMoney as Money } from '@/lib/money';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/format';
import { usePositionDetail } from '@/lib/positions/hooks';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium text-fg">{children}</span>
    </div>
  );
}

/**
 * MetaTrader's own deal detail, for a terminal brand.
 *
 * This is the seam the brand sweep was reported for: `MT5History` is a clean MetaTrader screen with
 * a blue title bar and dotted-leader figures, and tapping one of its deal rows opened a
 * soft-cornered card in the APP's palette (`bg-surface`, `border-border`, `text-up`/`text-down`,
 * `sm:rounded-2xl`, a brand-accent button). The file had no terminal detection at all.
 *
 * Rather than repaint the card's tokens, this renders MetaTrader's layout: its title bar carrying
 * the ticket, and its label-leader-value rows, which is what the screen it opens from uses. The
 * other shells keep the card below, untouched.
 */
function MT5PositionDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading, isError } = usePositionDetail(id);
  const money = useDisplayMoney();
  // Volume to the SYMBOL's own volume digits, so every surface states one lot size for one position
  // (docs/mt5/09-toolbox.md 300, rows at 313-318).
  const volumeDigits = useVolumeDigits(data?.symbol ?? XAUUSD.symbol);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  if (!id) return null;
  /**
   * The CHART price, not the engine's curve rate.
   *
   * This printed `entryRate.toFixed(5)` and so read "Price: 0.30412" while the history table one
   * layer behind it read "2,412.37" for the same trade. They are different numbers: the rate is the
   * engine's unitless curve value, and the price is what the trader saw on the axis, stamped at
   * execution (migration 0180). The screen this opens from resolves it with `priceText`, which also
   * carries the "at market" fallback for a trade placed before the column existed, so the detail
   * uses the same function rather than inventing a second answer.
   */
  const px = (v: number | null | undefined) => priceText(v, XAUUSD.digits);
  return (
    <>
      <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 z-40 bg-black/60" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Position detail"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto overscroll-contain border-t border-[var(--mt5-border)] bg-[var(--mt5-surface)] pb-[env(safe-area-inset-bottom)] text-[var(--mt5-text)] shadow-2xl sm:inset-0 sm:m-auto sm:h-fit sm:max-w-md sm:rounded-sm sm:border"
      >
        <MT5TitleBar
          embedded
          title="Position detail"
          subtitle={data ? `#${positionTicket(data)}` : undefined}
          actions={
            <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded text-white">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-4 w-4" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          }
        />
        {isLoading ? (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--mt5-muted)]">Loading…</div>
        ) : isError || !data ? (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--mt5-red)]">Couldn&apos;t load this position.</div>
        ) : (
          <MT5Summary>
            {/* MetaTrader's own vocabulary on a settled trade: a CLOSED DEAL, with the signed and
                coloured Profit figure saying whether it made money. See lib/game/dealWording. */}
            {/* MetaTrader names the instrument on every record. The trade carries its own now
                (migration 0182); a row written before that column reads null, which means the
                brand's own symbol, which is what every row meant before it existed. */}
            <MT5SummaryLine label="Symbol" value={data.symbol ?? XAUUSD.symbol} />
            <MT5SummaryLine label="Type" value={data.direction} />
            <MT5SummaryLine label="Volume" value={lotsOfStake(data.stakeCents, volumeDigits)} />
            <MT5SummaryLine label="Price" value={px(data.entryPrice)} />
            {data.settledAt === null ? null : <MT5SummaryLine label="Close price" value={px(data.exitPrice)} />}
            <MT5SummaryLine label="Status" value={dealResultLabel(data, true)} />
            <MT5SummaryLine label="Volume in money" value={money.fmt(data.stakeCents)} />
            {data.payoutCents === null ? null : <MT5SummaryLine label="Payout" value={money.fmt(data.payoutCents)} />}
            {data.pnlCents === null ? null : (
              <MT5SummaryLine
                label="Profit"
                value={money.fmt(data.pnlCents)}
                {...(data.pnlCents < 0 ? { tone: 'bad' as const } : {})}
              />
            )}
            <MT5SummaryLine label="Expiry" value={`${data.durationS}s`} />
            <MT5SummaryLine label="Time" value={formatDateTime(data.openedAt)} />
            {data.settledAt === null ? null : <MT5SummaryLine label="Closed" value={formatDateTime(data.settledAt)} />}
          </MT5Summary>
        )}
      </div>
    </>
  );
}

export function PositionDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const terminal = useTerminalSkin();
  const { data, isLoading, isError } = usePositionDetail(id);

  if (terminal) return <MT5PositionDetail id={id} onClose={onClose} />;

  return (
    <Modal open={!!id} onClose={onClose} title="Position detail" chrome={false}>
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="text-base font-semibold">Position detail</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted hover:text-fg">
          Close
        </button>
      </div>

      <div className="flex flex-col gap-1 p-4">
        {isLoading ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : isError || !data ? (
          <p className="text-sm text-down">Couldn&apos;t load this position.</p>
        ) : (
          <>
            <Row label="Direction">
              <span className={cn('uppercase', data.direction === 'buy' ? 'text-up' : 'text-down')}>
                {data.direction}
              </span>
            </Row>
            <Row label="Status">
              <span className="capitalize">{data.status}</span>
            </Row>
            {data.result ? (
              <Row label="Result">
                <span className={cn('capitalize', data.result === 'win' ? 'text-up' : 'text-down')}>
                  {data.result}
                  {data.multiplier ? ` · ×${data.multiplier.toFixed(2)}` : ''}
                </span>
              </Row>
            ) : null}
            <Row label="Stake">
              <Money cents={data.stakeCents} />
            </Row>
            {data.payoutCents !== null ? (
              <Row label="Payout">
                <Money cents={data.payoutCents} />
              </Row>
            ) : null}
            {data.pnlCents !== null ? (
              <Row label="P&L">
                <Money
                  cents={data.pnlCents}
                  className={data.pnlCents >= 0 ? 'text-up' : 'text-down'}
                />
              </Row>
            ) : null}
            <Row label="Entry rate">{data.entryRate.toFixed(5)}</Row>
            {data.exitRate !== null ? <Row label="Exit rate">{data.exitRate.toFixed(5)}</Row> : null}
            <Row label="Duration">{data.durationS}s</Row>
            <Row label="Opened">{formatDateTime(data.openedAt)}</Row>
            {data.settledAt !== null ? <Row label="Settled">{formatDateTime(data.settledAt)}</Row> : null}

            <Button variant="secondary" fullWidth className="mt-4" onClick={onClose}>
              Done
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
