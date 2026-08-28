'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSession } from '@/lib/auth/session';
import { useAuthUi } from '@/lib/auth/ui';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';
import { LogoMark } from '@/components/layout/Logo';
import { useSidebarCollapsed } from '@/lib/useSidebarCollapsed';

type NavItem = { href: string; label: string; icon: React.ReactNode };
type NavSection = { title: string; items: NavItem[]; superadmin?: boolean; platform?: boolean };

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Two tiers: Operations (any admin) and Governance (superadmin/owner only — the powers a plain
// admin does not have: roles, game economy, payment rails, fairness seeds).
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
      { href: '/admin/reports', label: 'Reports', icon: <Icon d="M9 17v-6m4 6V7m4 10v-4M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" /> },
      { href: '/admin/audit', label: 'Audit log', icon: <Icon d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /> },
      { href: '/admin/announcements', label: 'Announcements', icon: <Icon d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.6V5a2 2 0 10-4 0v.4A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /> },
    ],
  },
  {
    title: 'Governance',
    superadmin: true,
    items: [
      { href: '/admin/game', label: 'Game config', icon: <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-2.82 1.17V21a2 2 0 11-4 0v-.09A1.65 1.65 0 007 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 14H4a2 2 0 110-4h.09A1.65 1.65 0 006 7.6l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 0011 4.6V4a2 2 0 114 0v.09a1.65 1.65 0 002.82 1.17l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 10H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /> },
      { href: '/admin/mpesa', label: 'M-Pesa', icon: <Icon d="M5 7h14M5 7a2 2 0 00-2 2v6a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2M5 7V5a2 2 0 012-2h10a2 2 0 012 2v2M12 14a2 2 0 100-4 2 2 0 000 4z" /> },
      { href: '/admin/fly', label: 'Fly.io', icon: <Icon d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09zM12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /> },
    ],
  },
  {
    title: 'Platform',
    platform: true,
    items: [
      { href: '/platform', label: 'All brands', icon: <Icon d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" /> },
    ],
  },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const openAuth = useAuthUi((s) => s.openAuth);
  const { logout } = useAuthActions();
  const { collapsed, toggle } = useSidebarCollapsed('admin-sidebar-collapsed');

  if (!hydrated) {
    return (
      <div className="mx-auto w-full max-w-app p-4">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!token) {
    return (
      <Gate
        title="Admin sign-in required"
        body="Log in with an administrator account to access the back office."
        action={<Button onClick={() => openAuth('login')}>Log in</Button>}
      />
    );
  }
  if (user && user.role !== 'admin' && user.role !== 'superadmin' && user.role !== 'platform_superadmin') {
    return (
      <Gate
        title="Not authorised"
        body="This area is for administrators only."
        action={
          <Link href="/">
            <Button variant="outline">Back to app</Button>
          </Link>
        }
      />
    );
  }

  const isPlatform = user?.role === 'platform_superadmin';
  const isSuper = user?.role === 'superadmin' || isPlatform;
  const sections = SECTIONS.filter((s) => (!s.superadmin || isSuper) && (!s.platform || isPlatform));
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
            <LogoMark className="h-7 w-7 shrink-0" />
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">invest254 {isSuper ? 'Console' : 'Admin'}</span>
              <span className={cn('text-[10px] font-medium uppercase tracking-wide', isSuper ? 'text-warn' : 'text-muted')}>
                {isSuper ? 'Owner · full authority' : 'Operations'}
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
                  section.superadmin ? 'text-warn' : 'text-muted',
                  collapsed && 'md:hidden',
                )}
              >
                {section.title}
                {section.superadmin ? ' · owner' : ''}
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
                      ? section.superadmin
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
                    isSuper ? 'bg-warn/15 text-warn' : 'bg-surface-2 text-muted',
                  )}
                >
                  {isSuper ? '★ System owner' : 'Operator'}
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
