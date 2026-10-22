'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/cn';

/**
 * MetaTrader Android's Quotes row context menu.
 *
 * Its six items, in its order, under its own labels (docs/mt5/04-mobile-app.md section 2; iOS's are
 * different words in a different order, and Android's is the build this shell follows):
 *
 *   1. New order            hidden when not connected to the server
 *   2. Chart
 *   3. Properties           the symbol specification
 *   4. Depth of Market
 *   5. Market statistics
 *   6. Advanced view mode
 *
 * It is a bottom sheet rather than the desktop's positioned menu, because it is opened by TAPPING a
 * row — "To open the context menu, tap on the trading operation line in the list" — and a menu
 * anchored at the tap would land under the thumb that opened it.
 *
 * An item this platform cannot do carries the reason and is disabled, rather than being dropped or
 * drawn as if it worked. The one exception is MetaTrader's own: `New order` is absent, not
 * disabled, while the socket is down, because that is what MetaTrader does with it.
 */
export interface MobileQuoteMenuItem {
  label: string;
  onPick?: (() => void) | undefined;
  /** Why it cannot be done here. Present means the row is disabled and says this. */
  unavailable?: string | undefined;
  /** MetaTrader's checkable items show their state. */
  checked?: boolean | undefined;
}

export function MT5MobileQuoteMenu({ title, subtitle, items, onDismiss }: {
  title: string;
  subtitle: string;
  items: readonly MobileQuoteMenuItem[];
  onDismiss: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onDismiss]);

  return (
    <>
      <button type="button" aria-label="Close menu" onClick={onDismiss} className="fixed inset-0 z-40 bg-black/60" />
      <div
        role="dialog"
        aria-label={`${title} menu`}
        className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto overscroll-contain rounded-t-xl border-t border-[var(--mt5-border)] bg-[var(--mt5-surface)] pb-[env(safe-area-inset-bottom)] shadow-2xl"
      >
        <div className="border-b border-[var(--mt5-border)] px-4 py-3">
          <div className="text-[14px] font-bold text-white">{title}</div>
          <div className="pt-0.5 font-mono text-[11px] text-[var(--mt5-muted)] tabular-nums">{subtitle}</div>
        </div>
        <ul>
          {items.map((it) => (
            <li key={it.label}>
              <button
                type="button"
                data-mw-mobile-item={it.label}
                disabled={it.unavailable !== undefined}
                title={it.unavailable}
                onClick={() => { it.onPick?.(); onDismiss(); }}
                className={cn(
                  'flex w-full items-center gap-2 px-4 py-3 text-left text-[14px] transition',
                  it.unavailable === undefined ? 'text-[var(--mt5-text)] active:bg-[var(--mt5-raised)]' : 'cursor-not-allowed text-[var(--mt5-muted)] opacity-55',
                )}
              >
                <span className="flex-1">{it.label}</span>
                {/* MetaTrader's blue tick on a checked item. Drawn, like every other glyph in this
                    phone chrome, so it cannot come out as a box on an Android system font. */}
                {it.checked ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="#3183ff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-label="On">
                    <path d="M5 13l4.5 4.5L19 7" />
                  </svg>
                ) : null}
              </button>
              {it.unavailable === undefined ? null : (
                <p className="px-4 pb-2 text-[10px] leading-snug text-[var(--mt5-muted)]">{it.unavailable}</p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
