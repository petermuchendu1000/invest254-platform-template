'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AdminSignIn } from '@/components/auth/AdminSignIn';
import { useSession } from '@/lib/auth/session';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';

/**
 * /console — the UNIFIED OPERATOR ENTRY POINT (Issue 1).
 *
 * One URL for every admin, meant to be served on a dedicated admin domain (e.g. console.<host>).
 * Logged out → the identity-based operator sign-in. Logged in → routed to the surface for the
 * account's role: System owner / Platform admin → /platform; Site admin/superadmin → /admin.
 * A non-operator who lands here is told they have no console access (and can sign out).
 */
function destinationFor(role: string | undefined | null): string | null {
  if (role === 'platform_superadmin' || role === 'platform_admin') return '/platform';
  if (role === 'admin') return '/admin';
  return null;
}

export default function ConsoleEntryPage() {
  const hydrated = useHydrated();
  const router = useRouter();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const { logout } = useAuthActions();

  const dest = destinationFor(user?.role);

  React.useEffect(() => {
    if (token && dest) router.replace(dest);
  }, [token, dest, router]);

  if (!hydrated) return null;

  // Signed in as an operator → redirecting to their console.
  if (token && dest) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg text-sm text-muted">
        Opening your console…
      </div>
    );
  }

  // Signed in but not an operator account → reveal nothing beyond a 404.
  if (token && user && !dest) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-bg px-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">404</h1>
        <p className="text-sm text-muted">This page could not be found.</p>
        <button onClick={logout} className="mt-2 text-xs text-muted underline underline-offset-2 hover:text-fg">Sign out</button>
      </div>
    );
  }

  return <AdminSignIn />;
}
