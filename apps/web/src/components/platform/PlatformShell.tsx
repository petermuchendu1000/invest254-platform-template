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
import { CommandPalette } from '@/components/platform/CommandPalette';

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV = [
  { href: '/platform', label: 'Overview', exact: true, icon: <Icon d="M3 13h8V3H3zM13 21h8V3h-8zM3 21h8v-6H3z" /> },
  { href: '/platform/onboard', label: 'Onboard client', icon: <Icon d="M12 5v14M5 12h14" /> },
  { href: '/platform/config', label: 'Global config', icon: <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /> },
];

/**
 * Operator-console shell for the platform-superadmin: a persistent left sidebar (desktop) / top
 * scroll-nav (mobile), a global ⌘K command palette, and strict platform_superadmin gating.
 * Brand-token styling, consistent with the admin back office.
 */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const openAuth = useAuthUi((s) => s.openAuth);
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
    return (
      <Gate title="Platform sign-in required" body="Log in with the platform owner account to access the operator console."
        action={<Button onClick={() => openAuth('login')}>Log in</Button>} />
    );
  }
  if (user && user.role !== 'platform_superadmin') {
    return (
      <Gate title="Platform owner only" body="This console manages every client brand and is restricted to the platform owner."
        action={<Link href="/admin"><Button variant="outline">Back to admin</Button></Link>} />
    );
  }

  const active = (href: string, exact?: boolean) => (exact ? pathname === href : pathname?.startsWith(href));

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className={cn('flex shrink-0 flex-col border-b border-border bg-surface transition-[width] duration-200 md:h-dvh md:border-b-0 md:border-r md:sticky md:top-0', collapsed ? 'md:w-16' : 'md:w-60')}>
        <div className={cn('flex items-center gap-2 py-3', collapsed ? 'justify-between px-4 md:justify-center md:px-2' : 'px-4')}>
          <span className={cn('flex items-center gap-2', collapsed && 'md:hidden')}>
            <LogoMark className="h-7 w-7 shrink-0" />
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">invest254 Platform</span>
              <span className="text-[10px] font-medium uppercase tracking-wide text-accent">Operator console</span>
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
          {NAV.map((n) => (
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
              <Link href="/admin" title="Admin back office" aria-label="Admin back office" className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:text-fg"><Icon d="M14 6l-6 6 6 6" /></Link>
              <button type="button" onClick={logout} title="Log out" aria-label="Log out" className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-muted transition hover:text-fg"><Icon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></button>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <span className="truncate text-sm font-medium">@{user?.username}</span>
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">◆ Platform owner</span>
              </div>
              <Link href="/admin" className="text-xs text-muted hover:text-fg">← Admin back office</Link>
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
