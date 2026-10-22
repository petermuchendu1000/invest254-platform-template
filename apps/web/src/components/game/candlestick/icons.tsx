/**
 * The four icons the mock puts on its tabs and its header nav.
 *
 * Inline SVG rather than an icon package: four glyphs do not justify a dependency, and these are
 * drawn to the mock's weight (1.8 stroke on a 24 box, rendered at 14–16px) so they sit at the same
 * optical size as the labels beside them. `currentColor` throughout, because every one of them is
 * painted by the tab state around it — the brand's `accent` when active, `muted` when not. No
 * colour is set here, so these never need touching when a brand's palette changes.
 */
import { cn } from '@/lib/cn';

export type CandleIconName = 'trade' | 'chat' | 'top' | 'tours';

export function CIcon({ name, className = 'h-4 w-4' }: { name: CandleIconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      // `shrink-0` here rather than at every call site: an SVG is a flex child on every tab bar that
      // uses it, and a flex child with no basis is squashed before the label beside it is, which at
      // 320px turned the glyphs into slivers.
      className={cn('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}

const PATHS: Record<CandleIconName, React.ReactNode> = {
  /** A candle with its wick — the trade tab, and the thing the screen is named after. */
  trade: (
    <>
      <path d="M9 4v3M9 17v3M15 7v3M15 15v3" />
      <rect x="6.5" y="7" width="5" height="10" rx="1" />
      <rect x="12.5" y="10" width="5" height="5" rx="1" />
    </>
  ),
  /** A speech bubble. */
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.9-.9L3 20.5l1.7-4.9a8.1 8.1 0 0 1-1-3.9 8.4 8.4 0 0 1 8.5-8.2 8.4 8.4 0 0 1 8.8 8Z" />,
  /** A trophy — Top Traders. */
  top: (
    <>
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M7 6H4.5a2.5 2.5 0 0 0 2.5 2.5M17 6h2.5A2.5 2.5 0 0 1 17 8.5" />
      <path d="M12 14v3M9 20h6M10 17h4" />
    </>
  ),
  /** A rosette — Tournaments. */
  tours: (
    <>
      <circle cx="12" cy="9" r="5" />
      <path d="m9 13.5-1.5 6.5L12 18l4.5 2-1.5-6.5" />
    </>
  ),
};
