'use client';

import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's back chevron, as one control.
 *
 * There was no shared back control and no `router.back()` anywhere in the app. The four terminal
 * screens — History, Settings, Funds and the marketer dashboard — are each pushed FROM the chart
 * and each ended with no way back to it but re-opening the drawer and tapping Trade; the affiliate
 * screen, the legal pages and a referral landing had nothing at all. The two arrows that did exist
 * were hand-drawn SVG and a literal `←` glyph in two unrelated files.
 *
 * `onBack` first, then the browser's own history, then `fallback`. The order matters: a sheet
 * passes its own dismiss, a pushed route wants the history entry it came from so that going back
 * is the same whether the trader uses this or the system gesture, and a screen opened directly from
 * a link (a shared `/legal` URL, a notification) has no history to return to and needs somewhere to
 * go rather than a dead button.
 */
export function MT5Back({
  onBack, fallback = '/', label = 'Back', className,
}: {
  onBack?: (() => void) | undefined;
  /** Where to go when there is no history entry to return to. The chart, by default. */
  fallback?: string;
  label?: string;
  className?: string | undefined;
}) {
  const router = useRouter();
  const go = () => {
    if (onBack) { onBack(); return; }
    // `history.length <= 1` is a tab opened straight onto this page: there is nothing behind it.
    if (typeof window !== 'undefined' && window.history.length > 1) { router.back(); return; }
    router.push(fallback);
  };
  return (
    <button
      type="button"
      onClick={go}
      aria-label={label}
      data-mt5-back=""
      className={cn(
        'grid h-10 w-10 shrink-0 place-items-center rounded text-white transition hover:bg-white/20',
        className,
      )}
    >
      {/* MetaTrader's own chevron: a stroke, not a filled triangle, and the same 22px the
          hamburger beside it draws at so the two bars line up. */}
      <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M15 5l-7 7 7 7" />
      </svg>
    </button>
  );
}
