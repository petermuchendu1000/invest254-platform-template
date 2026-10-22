'use client';

import { useEffect } from 'react';

/**
 * MetaTrader's position context menu.
 *
 * On a phone MetaTrader opens this from the position row in the Trade tab: Android on a long press,
 * iOS on a tap (its own help is self-contradictory about the tap, and the research says so rather
 * than picking one). Either way it is how a trader reaches the Close position form, which is why
 * this exists: the form had no MetaTrader-shaped route into it.
 *
 * MetaQuotes' Android help lists four items:
 *
 *     Close position
 *     New order          (symbol and volume pre-filled from the position)
 *     Modify position    (edits SL and TP)
 *     Chart
 *
 * A second research pass read six items off a screenshot, adding "Close by" and
 * "Bulk Operations...". The two disagree; both are recorded in docs/mt5. Neither extra applies
 * here: "Close by" is hedging-only, and bulk operations need several positions at once, while this
 * engine holds one position at a time and cannot hedge.
 *
 * "New order" is dropped for the same reason: the single-open rule means a second order cannot be
 * placed while this one is live, so the item would open something that is guaranteed to be refused.
 * A menu entry that cannot work is worse than one that is not there.
 */
export interface PositionMenuItem {
  id: string;
  label: string;
  onPick: () => void;
  disabled?: boolean | undefined;
  /** Shown under the label when the item cannot act, so it explains itself instead of greying out. */
  note?: string | undefined;
}

export function MT5PositionMenu({
  title, subtitle, items, onDismiss,
}: {
  title: string;
  subtitle: string;
  items: PositionMenuItem[];
  onDismiss: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Position menu" className="fixed inset-0 z-[80] flex flex-col justify-end sm:items-center sm:justify-center">
      <button type="button" aria-label="Dismiss menu" onClick={onDismiss} className="absolute inset-0 bg-black/60" />
      <div className="relative w-full border-t border-[var(--mt5-border)] bg-[var(--mt5-surface)] sm:max-w-[320px] sm:rounded-sm sm:border">
        {/* MetaTrader heads the sheet with the position it acts on, so there is no doubt which. */}
        <div className="border-b border-[var(--mt5-border)] px-3 py-2.5">
          <span className="block truncate text-[13px] font-semibold text-white">{title}</span>
          <span className="block truncate font-mono text-[11px] text-[var(--mt5-muted)]">{subtitle}</span>
        </div>
        <ul>
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                onClick={it.onPick}
                disabled={it.disabled}
                className="flex w-full flex-col items-start border-b border-[var(--mt5-border)]/60 px-3 py-3 text-left text-[14px] text-[var(--mt5-text)] transition last:border-b-0 hover:bg-[var(--mt5-raised)] disabled:cursor-not-allowed disabled:text-[var(--mt5-muted)]"
              >
                {it.label}
                {it.note ? <span className="mt-0.5 text-[11px] leading-snug text-[var(--mt5-muted)]">{it.note}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
