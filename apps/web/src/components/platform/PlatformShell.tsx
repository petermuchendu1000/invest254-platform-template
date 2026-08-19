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
  { href: '/platform/marketers', label: 'Marketers', icon: <Icon d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4 0m8-4a3 3 0 10-3-3" /> },
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
      <aside className="flex shrink-0 flex-col border-b border-border bg-surface md:h-dvh md:w-60 md:border-b-0 md:border-r md:sticky md:top-0">
        <div className="flex items-center gap-2 px-4 py-3">
          <LogoMark className="h-7 w-7" />
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">invest254 Platform</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-accent">Operator console</span>
          </span>
        </div>

        {/* ⌘K launcher */}
        <div className="px-2 pb-1">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted transition hover:text-fg"
          >
            <span className="flex items-center gap-2"><Icon d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />Search…</span>
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium">⌘K</kbd>
          </button>
        </div>

        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href, n.exact) ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
                active(n.href, n.exact) ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {n.icon}
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="mt-auto hidden flex-col gap-2 border-t border-border px-4 py-3 md:flex">
          <div className="flex flex-col gap-1">
            <span className="truncate text-sm font-medium">@{user?.username}</span>
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">◆ Platform owner</span>
          </div>
          <Link href="/admin" className="text-xs text-muted hover:text-fg">← Admin back office</Link>
          <Button variant="secondary" size="sm" onClick={logout}>Log out</Button>
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
