'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useSupportChat } from '@/lib/support/useSupportChat';
import { useEntryScanner } from '@/lib/game/entryScannerUi';

function Icon({ path, className = 'h-5 w-5' }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={path} />
    </svg>
  );
}

/**
 * Digits-brand bottom navigation (matches the digits broker mock): Live Chat · AI · Positions.
 * Only rendered for `trade_ui = 'digits'` brands on the trade surface. Live Chat opens the existing
 * support widget; Positions links to history; AI opens the Entry Scanner (rendered inside the trade
 * screen, which owns the socket feed the scanner samples).
 */
export function DigitsBottomNav() {
  const pathname = usePathname();
  const setSupportOpen = useSupportChat((s) => s.setOpen);
  const openScanner = useEntryScanner((s) => s.setOpen);

  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface">
      <ul className="mx-auto flex w-full max-w-app items-end justify-around px-4 py-1.5">
        <li>
          <button
            type="button"
            onClick={() => setSupportOpen(true)}
            className="flex flex-col items-center gap-1 rounded-xl px-3 py-1.5 text-[11px] font-semibold text-muted transition hover:text-fg"
          >
            <Icon path="M21 15a2 2 0 01-2 2H8l-5 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            Live Chat
          </button>
        </li>

        <li className="-mt-3">
          <button
            type="button"
            onClick={() => openScanner(true)}
            aria-label="AI Entry Scanner"
            className="group flex flex-col items-center gap-1 text-[11px] font-semibold text-fg"
          >
            <span className="relative flex h-12 w-12 items-center justify-center">
              {/* slow attention halo (respects reduced motion) */}
              <span aria-hidden className="absolute inline-flex h-11 w-11 rounded-full bg-accent/25 opacity-70 [animation-duration:2.4s] motion-safe:animate-ping motion-reduce:hidden" />
              <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent shadow-[0_0_22px_-3px_var(--pp-accent)] ring-1 ring-accent/40 transition duration-200 group-active:scale-95 group-hover:ring-accent/70">
                {/* robot-face mark (accent line-art) with a gentle twinkle */}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-7 w-7 [animation-duration:2.6s] motion-safe:animate-pulse">
                  <line x1="12" y1="2" x2="12" y2="4.6" />
                  <circle cx="12" cy="1.9" r="1" fill="currentColor" stroke="none" />
                  <rect x="4" y="4.6" width="16" height="13.8" rx="4" />
                  <rect x="1.5" y="9.6" width="2" height="4" rx="1" />
                  <rect x="20.5" y="9.6" width="2" height="4" rx="1" />
                  <circle cx="9" cy="11" r="2.2" />
                  <circle cx="15" cy="11" r="2.2" />
                  <circle cx="9" cy="11" r="0.85" fill="currentColor" stroke="none" />
                  <circle cx="15" cy="11" r="0.85" fill="currentColor" stroke="none" />
                  <path d="M8.6 14.4c1 1.4 5.8 1.4 6.8 0" />
                </svg>
              </span>
            </span>
            AI
          </button>
        </li>

        <li>
          <Link
            href="/history/digits"
            aria-current={pathname.startsWith('/history/digits') ? 'page' : undefined}
            className={cn(
              'flex flex-col items-center gap-1 rounded-xl px-3 py-1.5 text-[11px] font-semibold transition',
              pathname.startsWith('/history/digits') ? 'text-accent' : 'text-muted hover:text-fg',
            )}
          >
            <Icon path="M12 8v4l3 2M21 12a9 9 0 11-9-9" />
            Positions
          </Link>
        </li>
      </ul>
    </nav>
  );
}
