'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSession } from '@/lib/auth/session';
import { AdminSignIn } from '@/components/auth/AdminSignIn';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';
import { useSidebarCollapsed } from '@/lib/useSidebarCollapsed';
import { CommandPalette } from '@/components/platform/CommandPalette';
import { roleFromToken, actorFromToken } from '@/lib/auth/token';
import { can } from '@invest254/shared/capabilities';
import { endImpersonation } from '@/lib/platform/impersonate';

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV = [
  { href: '/platform', label: 'Overview', exact: true, icon: <Icon d="M3 13h8V3H3zM13 21h8V3h-8zM3 21h8v-6H3z" /> },
  { href: '/platform/tickets', label: 'Tickets', icon: <Icon d="M4 5h16v6a2 2 0 000 2v6H4v-6a2 2 0 000-2zM9 5v14" /> },
  { href: '/platform/billing', label: 'Billing', icon: <Icon d="M3 10h18M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2zM7 15h4" /> },
  // system: true = System owner only (hidden from a scoped Platform admin).
  { href: '/platform/platforms', label: 'Platforms', system: true, icon: <Icon d="M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5" /> },
  // Onboarding + registrar config are PLATFORM-admin tools (each admin manages its own clients).
  { href: '/platform/onboard', label: 'Onboard client', icon: <Icon d="M12 5v14M5 12h14" /> },
  { href: '/platform/registrar', label: 'Domain registrar', icon: <Icon d="M3 12a9 9 0 1018 0 9 9 0 00-18 0zM3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" /> },
  { href: '/platform/pool', label: 'Withdrawal pool', icon: <Icon d="M3 7h18M3 12h18M3 17h18M6 3v18" /> },
  { href: '/platform/payments', label: 'Payments', system: true, icon: <Icon d="M3 10h18M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" /> },
  { href: '/platform/config', label: 'Global config', system: true, icon: <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /> },
  { href: '/platform/addons', label: 'Add-ons & requests', system: true, icon: <Icon d="M20 7l-9-4-9 4 9 4 9-4zM3 12l9 4 9-4M3 17l9 4 9-4" /> },
  // docs/42 UI-2: owner governance lives in the console (moved from the brand back office).
  { href: '/platform/audit', label: 'Audit log', system: true, icon: <Icon d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /> },
  { href: '/platform/logs', label: 'System logs', system: true, icon: <Icon d="M4 5h16M4 5a1 1 0 00-1 1v12a1 1 0 001 1h16a1 1 0 001-1V6a1 1 0 00-1-1M8 9h8M8 13h8M8 17h5" /> },
  { href: '/platform/mpesa', label: 'M-Pesa (global)', system: true, icon: <Icon d="M5 7h14M5 7a2 2 0 00-2 2v6a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2M5 7V5a2 2 0 012-2h10a2 2 0 012 2v2M12 14a2 2 0 100-4 2 2 0 000 4z" /> },
  { href: '/platform/engine', label: 'Engine (Fly.io)', system: true, icon: <Icon d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /> },
];

/**
 * Operator-console shell for the system owner and platform admins: a persistent left sidebar (desktop) / top
 * scroll-nav (mobile), a global ⌘K command palette, and capability gating (docs/42: console.enter =
 * platform admin + system owner; console.system = owner only).
 * Brand-token styling, consistent with the admin back office.
 */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const { logout } = useAuthActions();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const { collapsed, toggle } = useSidebarCollapsed('platform-sidebar-collapsed');

  // Global ⌘K / Ctrl-K to open the command palette (ignored while typing in a field elsewhere is
  // fine — the palette is a navigation aid, not a text shortcut).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  const SYSTEM_ONLY_PREFIXES = ['/platform/platforms', '/platform/payments', '/platform/config', '/platform/addons', '/platform/audit', '/platform/logs', '/platform/mpesa', '/platform/engine'];
  if (!isSystem && SYSTEM_ONLY_PREFIXES.some((p) => pathname?.startsWith(p))) {
    return <Gate title="404" body="This page could not be found." action={null} />;
  }

  const active = (href: string, exact?: boolean) => (exact ? pathname === href : pathname?.startsWith(href));

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className={cn('flex shrink-0 flex-col border-b border-border bg-surface transition-[width] duration-200 md:h-dvh md:border-b-0 md:border-r md:sticky md:top-0', collapsed ? 'md:w-16' : 'md:w-60')}>
        <div className={cn('flex items-center gap-2 py-3', collapsed ? 'justify-between px-4 md:justify-center md:px-2' : 'px-4')}>
          <span className={cn('flex items-center gap-2', collapsed && 'md:hidden')}>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-black/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/triocodes-mark.png" alt="TrioCodes" className="h-6 w-6 object-contain" />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">TrioCodes</span>
              {/* docs/42 UI-8 (P3): a platform admin always sees WHICH platform it is operating. */}
              <span className="truncate text-[10px] font-medium uppercase tracking-wide text-accent">
                {isSystem ? 'System console · all platforms' : `Platform · ${user?.scope?.platform?.name ?? 'your platform'}`}
              </span>
            </span>
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg md:flex"
          >
            <Icon d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
          </button>
        </div>

        {/* ⌘K launcher */}
        <div className="px-2 pb-1">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            title="Search (⌘K)"
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted transition hover:text-fg',
              collapsed ? 'md:justify-center md:px-2' : 'justify-between',
            )}
          >
            <span className="flex items-center gap-2"><Icon d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /><span className={cn(collapsed && 'md:hidden')}>Search…</span></span>
            <kbd className={cn('rounded border border-border px-1.5 py-0.5 text-[10px] font-medium', collapsed && 'md:hidden')}>⌘K</kbd>
          </button>
        </div>

        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {NAV.filter((n) => isSystem || !('system' in n && n.system)).map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href, n.exact) ? 'page' : undefined}
              title={collapsed ? n.label : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
                collapsed && 'md:justify-center md:px-2',
                active(n.href, n.exact) ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {n.icon}
              <span className={cn(collapsed && 'md:hidden')}>{n.label}</span>
            </Link>
          ))}
        </nav>

        <div className={cn('mt-auto hidden flex-col gap-2 border-t border-border py-3 md:flex', collapsed ? 'px-2' : 'px-4')}>
          {collapsed ? (
            <>
              {/* Only the SYSTEM owner has a single-brand back office at /admin; a platform admin
                  drills into a brand via impersonation, so the link would 404 for them (Issue 1). */}
              {isSystem && <Link href="/admin" title="Open a brand" aria-label="Open a brand" className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:text-fg"><Icon d="M14 6l-6 6 6 6" /></Link>}
              <button type="button" onClick={logout} title="Log out" aria-label="Log out" className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-muted transition hover:text-fg"><Icon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></button>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <span className="truncate text-sm font-medium">@{user?.username}</span>
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">{isSystem ? '◆ System owner' : `◆ Platform admin · ${user?.scope?.platform?.name ?? ''}`}</span>
              </div>
              {isSystem && <Link href="/admin" className="text-xs text-muted hover:text-fg">Open a brand →</Link>}
              <Button variant="secondary" size="sm" onClick={logout}>Log out</Button>
            </>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-5 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">{children}</div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function Gate({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-sm text-sm text-muted">{body}</p>
      {action}
    </div>
  );
}
