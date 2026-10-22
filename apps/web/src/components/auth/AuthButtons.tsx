'use client';

import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ProfileMenu } from '@/components/auth/ProfileMenu';
import { useAuthUi } from '@/lib/auth/ui';
import { useSession } from '@/lib/auth/session';
import { useHydrated } from '@/lib/useHydrated';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { cn } from '@/lib/cn';

export function AuthButtons() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const openAuth = useAuthUi((s) => s.openAuth);
  /**
   * On the blue title bar these were a ghost button and a GREEN pill with a glow — the single
   * loudest non-MetaTrader thing left up there. MetaTrader's own title-bar actions are flat: plain
   * white text, and a bordered white outline for the one that commits. No fill, no shadow, no
   * second colour on a band that is already one colour.
   */
  const terminal = useTerminalSkin();

  // Match the server-rendered (logged-out) markup until mounted.
  if (!hydrated || !token) {
    if (terminal) {
      return (
        <>
          <button
            type="button"
            onClick={() => openAuth('login')}
            className="h-8 shrink-0 rounded px-2.5 text-[13px] font-medium text-white transition hover:bg-white/20"
          >
            Login
          </button>
          <button
            type="button"
            onClick={() => openAuth('register')}
            className="h-8 shrink-0 rounded border border-white/70 px-2.5 text-[13px] font-semibold text-white transition hover:bg-white/20"
          >
            Sign Up
          </button>
        </>
      );
    }
    return (
      <>
        <Button variant="ghost" size="sm" className="px-2.5 sm:px-3" onClick={() => openAuth('login')}>
          Login
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="px-2.5 font-semibold shadow-md shadow-accent/40 sm:px-3"
          onClick={() => openAuth('register')}
        >
          Sign Up
        </Button>
      </>
    );
  }

  if (!user) return <Skeleton className={cn('rounded-full', terminal ? 'h-8 w-8' : 'h-9 w-9')} />;

  return <ProfileMenu user={user} />;
}
