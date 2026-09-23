'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useSidebarCollapsed } from '@/lib/useSidebarCollapsed';
import { roleLabel } from '@/lib/roles';
import { Glyph } from './icons';
import { currentHref, type NavGroup, type NavItem } from './nav';

/**
 * UI-A — the shared operator shell for every admin tier (brand back office + platform/System console).
 *
 * Anatomy (Polaris / Atlassian / shadcn "sidebar" pattern, NN/g vertical-nav guidance):
 *  - header: the workspace this session acts on (brand / platform / System), never overflowing;
 *  - optional search launcher;
 *  - navigation: frequent work first, then LABELLED groups separated by dividers (dividers stay in the
 *    collapsed icon rail, so groups remain visible there), ONE current item with a quiet highlight;
 *  - footer: collapse control (⌘/Ctrl+B) and the signed-in account with Log out.
 * On phones: a sticky top bar that names the current page, with a drawer holding the same navigation and
 * the account (the old horizontal strip hid most items and had no way to log out).
 */
export interface ConsoleShellProps {
  storageKey: string;
  home: string;
  workspace: { title: string; subtitle: string; tone?: 'accent' | 'warn' | 'muted' };
  groups: NavGroup[];
  user: { username?: string | null | undefined; role?: string | null | undefined };
  onLogout: () => void;
  onSearch?: () => void;
  /** Extra account actions shown above the account row (e.g. "Exit brand"). */
  footerExtra?: React.ReactNode;
  contentWidth?: 'max-w-5xl' | 'max-w-6xl' | 'max-w-7xl';
  children: React.ReactNode;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function ConsoleShell(props: ConsoleShellProps) {
  const { storageKey, groups, onSearch, contentWidth = 'max-w-6xl', children } = props;
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebarCollapsed(storageKey);
  const [drawer, setDrawer] = React.useState(false);
  const current = currentHref(groups, pathname);
  const currentItem = groups.flatMap((g) => g.items).find((i) => i.href === current) ?? null;

  // ⌘/Ctrl+B toggles the rail (VS Code / shadcn convention); ignored while typing.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'b') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  // The drawer closes on navigation.
  React.useEffect(() => { setDrawer(false); }, [pathname]);

  return (
    <div className="flex min-h-dvh bg-bg">
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 md:flex',
          collapsed ? 'w-[68px]' : 'w-64',
        )}
      >
        <SidebarBody {...props} collapsed={collapsed} current={current} onToggleCollapse={toggle} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone top bar: names the current page, opens the drawer. */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-2 backdrop-blur md:hidden">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Open menu"
            aria-expanded={drawer}
            aria-controls="console-drawer"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-fg transition hover:bg-surface-2"
          >
            {Glyph.menu}
          </button>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-semibold">{currentItem?.label ?? props.workspace.title}</div>
            <div className="truncate text-[11px] text-muted">{props.workspace.title}</div>
          </div>
          {onSearch ? (
            <button type="button" onClick={onSearch} aria-label="Search" className="flex h-10 w-10 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg">
              {Glyph.search}
            </button>
          ) : null}
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-7">
          <div className={cn('mx-auto flex w-full flex-col gap-6', contentWidth)}>{children}</div>
        </main>
      </div>

      {drawer ? <Drawer onClose={() => setDrawer(false)}><SidebarBody {...props} collapsed={false} current={current} inDrawer onClose={() => setDrawer(false)} /></Drawer> : null}
    </div>
  );
}

function Drawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const panel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (panel.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel.current?.querySelector<HTMLElement>('nav a'))?.focus();
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        id="console-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="absolute inset-y-0 left-0 flex w-[86vw] max-w-[320px] flex-col border-r border-border bg-surface shadow-2xl"
      >
        {children}
      </div>
    </div>
  );
}

function Mark() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-black/5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/triocodes-mark.png" alt="" className="h-6 w-6 object-contain" />
    </span>
  );
}

function initials(name?: string | null): string {
  const s = (name ?? '').replace(/^@/, '').trim();
  return (s.slice(0, 2) || '··').toUpperCase();
}

function SidebarBody(
  props: ConsoleShellProps & {
    collapsed: boolean;
    current: string | null;
    onToggleCollapse?: () => void;
    inDrawer?: boolean;
    onClose?: () => void;
  },
) {
  const { home, workspace, groups, user, onLogout, onSearch, footerExtra, collapsed, current, onToggleCollapse, inDrawer, onClose } = props;
  const toneCls = workspace.tone === 'warn' ? 'text-warn' : workspace.tone === 'muted' ? 'text-muted' : 'text-accent';
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => setMac(isMac()), []);
  // Keep the current item in view when the list is taller than the screen (e.g. System → Deployment).
  const navRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  return (
    <>
      {/* Workspace */}
      <div className={cn('flex h-16 shrink-0 items-center gap-2 border-b border-border px-3', collapsed && 'justify-center px-2')}>
        <Link
          href={home}
          title={collapsed ? `${workspace.title} · ${workspace.subtitle}` : undefined}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 transition hover:bg-surface-2"
        >
          <Mark />
          {!collapsed ? (
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-semibold tracking-tight" title={workspace.title}>{workspace.title}</span>
              <span className={cn('block truncate text-[11px] font-medium', toneCls)} title={workspace.subtitle}>{workspace.subtitle}</span>
            </span>
          ) : null}
        </Link>
        {inDrawer ? (
          <button type="button" onClick={onClose} aria-label="Close menu" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg">
            {Glyph.close}
          </button>
        ) : null}
      </div>

      {onSearch && !inDrawer ? (
        <div className={cn('px-3 pt-3', collapsed && 'px-2')}>
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search"
            title={collapsed ? 'Search' : undefined}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 text-sm text-muted transition hover:border-muted/40 hover:text-fg',
              collapsed && 'justify-center px-0',
            )}
          >
            {Glyph.search}
            {!collapsed ? (
              <>
                <span className="flex-1 text-left">Search…</span>
                <kbd className="rounded border border-border px-1.5 py-0.5 font-sans text-[10px] font-medium">{mac ? '⌘K' : 'Ctrl K'}</kbd>
              </>
            ) : null}
          </button>
        </div>
      ) : null}

      <nav ref={navRef} aria-label="Console" className={cn('flex-1 overflow-y-auto px-3 py-3', collapsed && 'px-2')}>
        {groups.map((g, gi) => (
          <div key={g.id} className={cn(gi > 0 && 'mt-2.5 border-t border-border/70 pt-2.5')}>
            {g.label && !collapsed ? (
              <div data-nav-group-label className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted/80">
                {g.label}
              </div>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={item.href === current} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn('shrink-0 border-t border-border p-3', collapsed && 'px-2')}>
        {footerExtra}
        {onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${mac ? '⌘' : 'Ctrl+'}B)`}
            className={cn(
              'mb-2 flex h-8 w-full items-center gap-3 rounded-lg px-3 text-xs text-muted transition hover:bg-surface-2 hover:text-fg',
              collapsed && 'justify-center px-0',
            )}
          >
            {collapsed ? Glyph.expand : Glyph.collapse}
            {!collapsed ? <span>Collapse</span> : null}
          </button>
        ) : null}
        <div className={cn('flex items-center gap-2.5 rounded-lg', collapsed ? 'flex-col' : 'px-1')}>
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-fg ring-1 ring-border"
            title={collapsed ? `@${user.username ?? ''} · ${roleLabel(user.role)}` : undefined}
            aria-hidden
          >
            {initials(user.username)}
          </span>
          {!collapsed ? (
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium">@{user.username ?? '…'}</span>
              <span className="block truncate text-[11px] text-muted">{roleLabel(user.role)}</span>
            </span>
          ) : null}
          <button
            type="button"
            onClick={onLogout}
            aria-label="Log out"
            title="Log out"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-down"
          >
            {Glyph.logout}
          </button>
        </div>
      </div>
    </>
  );
}

function NavLink({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        'group relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm outline-none md:h-8 transition-colors focus-visible:ring-2 focus-visible:ring-accent/60',
        collapsed && 'justify-center px-0',
        active ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg',
      )}
    >
      {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-accent" /> : null}
      <span className={cn('shrink-0 transition-colors', active ? 'text-accent' : 'text-muted group-hover:text-fg')}>{item.icon}</span>
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </Link>
  );
}

/** Centered status page used by the shells' gates (404 / exit brand). */
export function ShellGate({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-sm text-sm text-muted">{body}</p>
      {action}
    </div>
  );
}
