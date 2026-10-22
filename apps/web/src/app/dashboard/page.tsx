'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSession } from '@/lib/auth/session';
import { useIsMarketer } from '@/lib/marketer/isMarketer';
import { useHydrated } from '@/lib/useHydrated';
import { MarketerDashboardView } from '@/components/marketer/MarketerDashboardView';
import { MT5TitleBar, MT5Screen } from '@/components/mt5/kit';
import { MT5_TOKENS } from '@/lib/ui/mt5Tokens';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';

/**
 * Marketer dashboard route. This is the destination the covert top-left hotspot navigates to
 * (replacing the old modal). Gated to marketers only: unauthenticated or non-marketer users are
 * redirected home so the page — and its idempotent enroll self-heal — is only ever reached by a
 * confirmed marketer.
 */
export default function DashboardPage() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const router = useRouter();
  const { isMarketer, resolved } = useIsMarketer();
  /**
   * The dashboard is reached from inside the terminal, so on a candlestick brand it wears the
   * terminal's clothes. Every figure, card and rule on the 547-line view below paints from the
   * --pp-* tokens and not one hard-coded colour, so re-pointing them here repaints the whole page —
   * MetaTrader's surfaces, its border, its blue, and square corners via --pp-radius.
   */
  const mt5 = useTerminalSkin();

  useEffect(() => {
    if (!hydrated) return;
    // No token, or a resolved profile that isn't a marketer -> this page isn't for them.
    // Only bounce once the answer is RESOLVED: redirecting on an unresolved wallet would throw a
    // marketer back to the trade screen before their own app had a chance to load.
    if (!token || (resolved && !isMarketer)) router.replace('/');
  }, [hydrated, token, resolved, isMarketer, router]);

  // While hydrating, awaiting the profile, or redirecting a non-marketer, show a neutral skeleton —
  // under the title bar, which on a phone is this screen's only navigation (MT5TitleBar).
  if (!hydrated || !token || !user || !resolved || !isMarketer) {
    const skeleton = <Skeleton className="h-64 w-full" />;
    return mt5 ? <MT5Screen title="Dashboard"><div className="p-3">{skeleton}</div></MT5Screen> : skeleton;
  }

  if (!mt5) return <MarketerDashboardView />;

  return (
    <div style={MT5_TOKENS} className="mt5-square flex min-h-0 flex-1 flex-col bg-[var(--mt5-surface)] text-white">
      {/* Named as MetaTrader names a screen, in the band it names it in — so arriving here reads as
          another screen of the terminal rather than a different site. */}
      <MT5TitleBar title="Dashboard" back />
      <div className="flex-1 p-3">
        <MarketerDashboardView />
      </div>
    </div>
  );
}
