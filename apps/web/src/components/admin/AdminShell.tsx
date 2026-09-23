'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSession } from '@/lib/auth/session';
import { roleFromToken, actorFromToken } from '@/lib/auth/token';
import { can } from '@invest254/shared/capabilities';
import { AdminSignIn } from '@/components/auth/AdminSignIn';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';
import { getImpersonatingBrand, endImpersonation } from '@/lib/platform/impersonate';
import { BrandPicker } from '@/components/admin/BrandPicker';
import { ConsoleShell, ShellGate } from '@/components/console/ConsoleShell';
import { brandAdminNav } from '@/components/console/nav';
import { Glyph } from '@/components/console/icons';
import { OperatorConsole } from '@/components/platform/PlatformShell';

// docs/42 P2: every nav entry is gated by a capability evaluated on the TOKEN role (what the API authorises).
// UI-A: the navigation itself lives in components/console/nav (grouped: Money / Players / Support / Brand).

const MOVED_TO_CONSOLE: Record<string, string> = {
  '/admin/audit': '/platform/audit', '/admin/logs': '/platform/logs', '/admin/fly': '/platform/engine',
  '/admin/mpesa': '/platform/mpesa', '/admin/game': '/platform',
};

export function AdminShell({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const { logout } = useAuthActions();
  const router = useRouter();
  // docs/42 UI-2: owner governance moved to the console — forward the owner's old bookmarks there
  // (the shell would otherwise show the brand picker before the old page could redirect).
  React.useEffect(() => {
    const moved = pathname ? MOVED_TO_CONSOLE[pathname] : undefined;
    if (moved && can(roleFromToken(token), 'console.system') && !actorFromToken(token)) router.replace(moved);
  }, [pathname, token, router]);
  if (!hydrated) {
    return (
      <div className="mx-auto w-full max-w-app p-4">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!token) {
    // Unified operator sign-in (Issue 1): identity-based, brand-agnostic.
    return <AdminSignIn />;
  }

  // Impersonation fence — safe to read synchronously now we're past hydration (client-only, no SSR
  // mismatch, and no useEffect race that could briefly authorise off the wrong role).
  const impersonating = getImpersonatingBrand();

  // EFFECTIVE role = the ACTIVE TOKEN's role: exactly what the API authorises (docs/42 UI-3). While
  // impersonating that is 'admin' — /auth/me would report the operator's own tier and show controls the
  // brand session is refused. Impersonation itself is read from the token's `act` claim (any tab).
  const effectiveRole = roleFromToken(token) ?? '';

  // When NOT impersonating, wait for /auth/me before deciding (prevents a wrong-role flash).
  if (!impersonating && !user) {
    return (
      <div className="mx-auto w-full max-w-app p-4">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!can(effectiveRole, 'backoffice.enter')) {
    // Wrong tier: reveal nothing.
    return <Gate title="404" body="This page could not be found." action={null} />;
  }
  // docs/42 UI-2 (owner decision): the system owner's OWN session never works an unscoped back office —
  // it picks a brand first (then works it as that brand's admin). Global settings live in the console.
  if (can(effectiveRole, 'console.system') && !impersonating) {
    // UI-A: the picker opens inside the System console (same sidebar, "Brand back office" current).
    return (
      <OperatorConsole isSystem platformName={null} username={user?.username ?? null} role={effectiveRole} onLogout={logout}>
        <BrandPicker />
      </OperatorConsole>
    );
  }

  const brandName = impersonating?.name ?? user?.scope?.site?.name ?? null;
  const operator = actorFromToken(token);
  return (
    <ConsoleShell
      storageKey="admin-sidebar-collapsed"
      home="/admin"
      // docs/42 UI-8 (P3): always name the brand this session acts on.
      workspace={impersonating
        ? { title: brandName ?? 'Brand', subtitle: 'Opened from the console', tone: 'warn' }
        : { title: brandName ?? 'Brand', subtitle: 'Brand admin' }}
      groups={brandAdminNav(effectiveRole)}
      // An operator inside a brand is shown as who they really are (the banner says which brand).
      user={{ username: user?.username ?? null, role: operator?.role ?? effectiveRole }}
      onLogout={logout}
      footerExtra={impersonating ? (
        <button
          type="button"
          onClick={() => { void endImpersonation(); }}
          className="mb-2 flex h-8 w-full items-center gap-3 rounded-lg px-3 text-xs font-medium text-warn transition hover:bg-warn/10"
        >
          {Glyph.exit}
          <span>Exit brand</span>
        </button>
      ) : null}
      contentWidth="max-w-6xl"
    >
      {children}
    </ConsoleShell>
  );
}

const Gate = ShellGate;
