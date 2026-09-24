'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSession } from '@/lib/auth/session';
import { AdminSignIn } from '@/components/auth/AdminSignIn';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';
import { ConsoleShell, ShellGate } from '@/components/console/ConsoleShell';
import { consoleNav } from '@/components/console/nav';
import { CommandPalette } from '@/components/platform/CommandPalette';
import { roleFromToken, actorFromToken } from '@/lib/auth/token';
import { can } from '@invest254/shared/capabilities';
import { endImpersonation } from '@/lib/platform/impersonate';

/**
 * Operator-console gate for the System owner and platform admins (docs/42: console.enter = platform admin +
 * System owner; console.system = owner only). The chrome itself is the shared ConsoleShell (UI-A).
 */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const { logout } = useAuthActions();

  if (!hydrated) {
    return <div className="mx-auto w-full max-w-app p-4"><Skeleton className="h-64 w-full" /></div>;
  }
  if (!token) {
    // Unified operator sign-in (Issue 1): identity-based, brand-agnostic, so a platform_admin can
    // sign in here regardless of which host serves the console.
    return <AdminSignIn />;
  }
  // docs/42 UI-3: decisions use the TOKEN role (what the API authorises). A brand session opened from
  // the console (impersonation, `act` claim) is not a console session: offer the way back, don't 404.
  const actor = actorFromToken(token);
  if (actor) {
    return (
      <Gate
        title={`You're in ${actor.brand ?? 'a brand'} as admin`}
        body="Leave the brand to return to your console."
        action={<Button onClick={() => { void endImpersonation(); }}>Exit brand</Button>}
      />
    );
  }
  const tokenRole = roleFromToken(token);
  if (!can(tokenRole, 'console.enter')) {
    // Wrong tier: reveal nothing — no hint that an operator console exists here.
    return <Gate title="404" body="This page could not be found." action={null} />;
  }
  // Platform admins see a SCOPED console (their platform's sites only); system-only tools are hidden.
  const isSystem = can(tokenRole, 'console.system');

  // Defense-in-depth: hide-from-nav is not enough. A platform admin typing a System-only URL must get
  // a plain 404 (reveal nothing), not a broken page that 403s every call. The API + RPCs already gate
  // these, this is the matching client guard.
  // Onboarding + registrar config are available to platform admins (they manage their own clients);
  // platforms/payments/global-config remain SYSTEM-owner only.
  const SYSTEM_ONLY_PREFIXES = ['/platform/platforms', '/platform/payments', '/platform/config', '/platform/logs', '/platform/mpesa', '/platform/engine'];
  if (!isSystem && SYSTEM_ONLY_PREFIXES.some((p) => pathname?.startsWith(p))) {
    return <Gate title="404" body="This page could not be found." action={null} />;
  }

  return (
    <OperatorConsole isSystem={isSystem} platformName={user?.scope?.platform?.name ?? null} username={user?.username ?? null} role={tokenRole} onLogout={logout}>
      {children}
    </OperatorConsole>
  );
}

/**
 * The console chrome (UI-A): grouped navigation from components/console/nav + the ⌘K palette. Exported so the
 * System owner's brand picker (/admin) renders inside the same console instead of a bare page.
 */
export function OperatorConsole({ isSystem, platformName, username, role, onLogout, children }: {
  isSystem: boolean; platformName: string | null; username: string | null; role: string | null | undefined;
  onLogout: () => void; children: React.ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const groups = React.useMemo(() => consoleNav(isSystem), [isSystem]);
  // Global ⌘K / Ctrl-K opens the command palette.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <ConsoleShell
        storageKey="platform-sidebar-collapsed"
        home="/platform"
        // docs/42 UI-8 (P3): a platform admin always sees WHICH platform it is operating.
        workspace={isSystem
          ? { title: 'System console', subtitle: 'All platforms' }
          : { title: platformName ?? 'Your platform', subtitle: 'Platform console' }}
        groups={groups}
        user={{ username, role }}
        onLogout={onLogout}
        onSearch={() => setPaletteOpen(true)}
        contentWidth="max-w-6xl"
      >
        {children}
      </ConsoleShell>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} nav={groups} />
    </>
  );
}

const Gate = ShellGate;
