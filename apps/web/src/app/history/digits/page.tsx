import Link from 'next/link';
import { DigitHistoryPanel } from '@/components/game/digits/DigitHistoryPanel';

export const metadata = { title: 'Trade history' };

/**
 * Dedicated DIGIT trade-history page (docs/34). The reviewable receipt feed lives on its own route
 * so the trade surface stays focused on placing contracts. Reached from the digits shell's bottom
 * nav ("Positions"). Renders the shared receipt panel in full-page mode (no inner max-height —
 * the standard shell page-scrolls) so every settled + open contract is reviewable.
 */
export default function DigitHistoryPage() {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          aria-label="Back to trade"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="text-lg font-semibold text-fg">Trade history</h1>
      </div>
      <DigitHistoryPanel embedded={false} />
    </section>
  );
}
