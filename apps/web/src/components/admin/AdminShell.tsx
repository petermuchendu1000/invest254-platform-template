'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSession } from '@/lib/auth/session';
import { roleFromToken, actorFromToken } from '@/lib/auth/token';
import { can, type Capability } from '@invest254/shared/capabilities';
import { AdminSignIn } from '@/components/auth/AdminSignIn';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';
import { useSidebarCollapsed } from '@/lib/useSidebarCollapsed';
import { getImpersonatingBrand } from '@/lib/platform/impersonate';
import { BrandPicker } from '@/components/admin/BrandPicker';

// docs/42 P2: every nav entry is gated by a capability from packages/shared/src/capabilities.ts, evaluated
// on the TOKEN role (what the API authorises) — never a hand-written role list.
type NavItem = { href: string; label: string; icon: React.ReactNode; cap?: Capability };
type NavSection = { title: string; items: NavItem[]; cap?: Capability; hideWhileImpersonating?: boolean };

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Two tiers: Operations (any site admin) and Governance (SYSTEM owner only — the owner-tier powers
// a site admin does not have: game economy, payment rails, fairness seeds). Issue 1 / F1.
const SECTIONS: NavSection[] = [
  {
    title: 'Operations',
    items: [
      { href: '/admin', label: 'Overview', icon: <Icon d="M3 13h8V3H3zM13 21h8V3h-8zM3 21h8v-6H3z" /> },
      { href: '/admin/withdrawals', label: 'Withdrawals', icon: <Icon d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /> },
      { href: '/admin/users', label: 'Users', icon: <Icon d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM3 21a7 7 0 0118 0" /> },
      { href: '/admin/finance', label: 'Finance', icon: <Icon d="M3 6h18M3 12h18M3 18h18M7 3v18" /> },
      { href: '/admin/marketer-finance', label: 'Marketer finance', icon: <Icon d="M21 12V7H5a2 2 0 010-4h14v4M3 5v14a2 2 0 002 2h16v-5M18 12a2 2 0 000 4h4v-4z" /> },
      { href: '/admin/support', label: 'Support', icon: <Icon d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" /> },
      { href: '/admin/tickets', label: 'Tickets', icon: <Icon d="M4 5h16v6a2 2 0 000 2v6H4v-6a2 2 0 000-2zM9 5v14" /> },
      { href: '/admin/systems', label: 'Systems', icon: <Icon d="M20 7l-9-4-9 4 9 4 9-4zM3 12l9 4 9-4M3 17l9 4 9-4" /> },
      { href: '/admin/reports', label: 'Reports', icon: <Icon d="M9 17v-6m4 6V7m4 10v-4M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" /> },
      { href: '/admin/announcements', label: 'Announcements', icon: <Icon d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.6V5a2 2 0 10-4 0v.4A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /> },
    ],
  },
];

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
  const { collapsed, toggle } = useSidebarCollapsed('admin-sidebar-collapsed');
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
    return (
      <div className="min-h-dvh">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <Link href="/platform" className="text-sm text-muted hover:text-fg">← System console</Link>
          <Button variant="secondary" size="sm" onClick={logout}>Log out</Button>
        </div>
        <BrandPicker />
      </div>
    );
  }

  const isSuper = can(effectiveRole, 'backoffice.governance');  // owner-tier accent (system owner's own session)
  const impRoleLabel = 'admin';
  const brandName = impersonating?.name ?? user?.scope?.site?.name ?? null;
  const sections = SECTIONS
    .filter((s) => (!s.cap || can(effectiveRole, s.cap)) && !(s.hideWhileImpersonating && impersonating))
    .map((s) => ({ ...s, items: s.items.filter((n) => !n.cap || can(effectiveRole, n.cap)) }));
  const active = (href: string) => (href === '/admin' ? pathname === '/admin' : pathname?.startsWith(href));

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Sidebar (desktop) / top bar + scroll nav (mobile) */}
      <aside
        className={cn(
          'flex shrink-0 flex-col border-b bg-surface transition-[width] duration-200 md:h-dvh md:border-b-0 md:border-r md:sticky md:top-0',
          collapsed ? 'md:w-16' : 'md:w-60',
          isSuper ? 'border-warn/40' : 'border-border',
        )}
      >
        <div className={cn('flex items-center gap-2 py-3', collapsed ? 'justify-between px-4 md:justify-center md:px-2' : 'justify-between px-4')}>
          <Link href="/admin" className={cn('flex min-w-0 items-center gap-2', collapsed && 'md:hidden')}>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-black/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/triocodes-mark.png" alt="TrioCodes" className="h-6 w-6 object-contain" />
            </span>
            <span className="flex flex-col leading-tight">
              {/* docs/42 UI-8 (P3): always name the brand this session acts on. */}
              <span className="truncate text-sm font-semibold tracking-tight" title={brandName ?? undefined}>
                {brandName ?? 'TrioCodes'} {brandName ? 'Admin' : 'Console'}
              </span>
              <span className={cn('text-[10px] font-medium uppercase tracking-wide', isSuper || impersonating ? 'text-warn' : 'text-muted')}>
                {impersonating ? `Opened from the console · as ${impRoleLabel}` : isSuper ? 'Owner · all brands' : 'Brand admin'}
              </span>
            </span>
          </Link>
          {/* Desktop-only collapse toggle (icon-rail pattern). State persists via localStorage. */}
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

        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:px-2">
          {sections.map((section) => (
            <React.Fragment key={section.title}>
              <span
                className={cn(
                  'mt-2 hidden px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider md:block',
                  section.cap === 'backoffice.governance' ? 'text-warn' : 'text-muted',
                  collapsed && 'md:hidden',
                )}
              >
                {section.title}
                {section.cap === 'backoffice.governance' ? ' · owner' : ''}
              </span>
              {section.items.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active(n.href) ? 'page' : undefined}
                  title={collapsed ? n.label : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
                    collapsed && 'md:justify-center md:px-2',
                    active(n.href)
                      ? section.cap === 'backoffice.governance'
                        ? 'bg-warn text-bg'
                        : 'bg-accent text-accent-fg'
                      : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {n.icon}
                  <span className={cn(collapsed && 'md:hidden')}>{n.label}</span>
                </Link>
              ))}
            </React.Fragment>
          ))}
        </nav>

        <div className={cn('mt-auto hidden flex-col gap-2 border-t border-border py-3 md:flex', collapsed ? 'px-2' : 'px-4')}>
          {collapsed ? (
            <button
              type="button"
              onClick={logout}
              title="Log out"
              aria-label="Log out"
              className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-muted transition hover:text-fg"
            >
              <Icon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            </button>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <span className="truncate text-sm font-medium">@{user?.username}</span>
                <span
                  className={cn(
                    'inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    impersonating ? 'bg-warn/20 text-warn' : isSuper ? 'bg-warn/15 text-warn' : 'bg-surface-2 text-muted',
                  )}
                  title={impersonating ? `Logged in as ${impRoleLabel}, accessing ${impersonating.name}` : undefined}
                >
                  {impersonating ? `Accessing ${impersonating.name}` : isSuper ? '★ System owner' : `Admin · ${brandName ?? 'brand'}`}
                </span>
              </div>
              <Button variant="secondary" size="sm" onClick={logout}>
                Log out
              </Button>
            </>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-5 md:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">{children}</div>
      </main>
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
