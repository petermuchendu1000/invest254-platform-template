import * as React from 'react';
import { can, type Capability } from '@invest254/shared/capabilities';
import { Icons } from './icons';

/**
 * UI-A: the ONE place that defines each operator tier's navigation. Frequent daily work sits at the top
 * with no group label, then labelled groups ordered by how often they are used. Every item is gated by a
 * capability (docs/42 P2) on the TOKEN role, never a hand-written role list.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** Extra routes that belong to this item (e.g. a brand page under Overview). */
  also?: (path: string) => boolean;
  exact?: boolean;
  cap?: Capability;
  /** Hint shown in the command palette. */
  hint?: string;
}
export interface NavGroup { id: string; label?: string; items: NavItem[] }

export function isActive(item: NavItem, path: string | null | undefined): boolean {
  if (!path) return false;
  if (item.also?.(path)) return true;
  if (item.exact) return path === item.href;
  return path === item.href || path.startsWith(`${item.href}/`);
}

/** The single item that owns the route: the longest matching href wins (so /admin/users beats /admin). */
export function currentHref(groups: NavGroup[], path: string | null | undefined): string | null {
  let best: NavItem | null = null;
  for (const g of groups) for (const i of g.items) {
    if (!isActive(i, path)) continue;
    if (!best || i.href.length > best.href.length) best = i;
  }
  return best?.href ?? null;
}

const filterCaps = (groups: NavGroup[], role: string | null | undefined): NavGroup[] =>
  groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.cap || can(role, i.cap)) }))
    .filter((g) => g.items.length > 0);

/** Brand back office (/admin): a site admin, or an operator who opened a brand from the console. */
export function brandAdminNav(role: string | null | undefined): NavGroup[] {
  return filterCaps([
    { id: 'home', items: [
      { href: '/admin', label: 'Overview', icon: Icons.overview, exact: true, hint: 'KPIs and alerts' },
    ] },
    { id: 'money', label: 'Money', items: [
      { href: '/admin/withdrawals', label: 'Withdrawals', icon: Icons.withdrawals, hint: 'Review and pay out' },
      { href: '/admin/finance', label: 'Finance', icon: Icons.finance, hint: 'Deposits and transactions' },
      { href: '/admin/marketer-finance', label: 'Marketer payouts', icon: Icons.marketers, hint: 'Referral and affiliate payouts' },
      { href: '/admin/reports', label: 'Reports', icon: Icons.reports, hint: 'Daily and date-range figures' },
    ] },
    { id: 'players', label: 'Players', items: [
      { href: '/admin/users', label: 'Users', icon: Icons.users, hint: 'Players, marketers and staff' },
      { href: '/admin/announcements', label: 'Announcements', icon: Icons.announcements, hint: 'Notify players' },
    ] },
    { id: 'support', label: 'Support', items: [
      { href: '/admin/support', label: 'Player chats', icon: Icons.chats, hint: 'Conversations from players' },
      { href: '/admin/tickets', label: 'Platform tickets', icon: Icons.tickets, hint: 'Ask your platform for help' },
    ] },
    { id: 'brand', label: 'Brand', items: [
      { href: '/admin/systems', label: 'Add-ons & gateways', icon: Icons.addons, hint: 'Charts, trade screens, gateways' },
    ] },
  ], role);
}

/**
 * Operator console (/platform). `isSystem` = the System owner (every platform); otherwise a platform admin,
 * scoped to its own platform. The owner also reaches a brand's back office (/admin) from here.
 */
export function consoleNav(isSystem: boolean): NavGroup[] {
  const overview: NavItem = {
    href: '/platform', label: 'Overview', icon: Icons.overview, exact: true, hint: 'All brands at a glance',
    also: (p) => p.startsWith('/platform/clients/'),
  };
  const tickets: NavItem = { href: '/platform/tickets', label: 'Tickets', icon: Icons.tickets, hint: 'Issues raised by brand admins' };
  const onboard: NavItem = { href: '/platform/onboard', label: 'Onboard brand', icon: Icons.onboard, hint: 'Create a new brand' };
  const registrar: NavItem = { href: '/platform/registrar', label: 'Domain registrar', icon: Icons.registrar, hint: 'Namecheap connection' };
  const accounts: NavItem = { href: '/platform/payment-accounts', label: 'Payment accounts', icon: Icons.accounts, hint: 'Your own M-Pesa and gateway accounts' };
  const pool: NavItem = { href: '/platform/pool', label: 'Withdrawal pool', icon: Icons.pool, hint: 'Daily payout budget per brand' };
  const billing: NavItem = { href: '/platform/billing', label: 'Billing', icon: Icons.billing, hint: 'Plans and subscriptions' };
  if (!isSystem) {
    return [
      { id: 'home', items: [overview, tickets] },
      { id: 'brands', label: 'Brands', items: [onboard, registrar] },
      { id: 'money', label: 'Money', items: [accounts, pool] },
      { id: 'oversight', label: 'Oversight', items: [
        { href: '/platform/activity', label: 'Audit log', icon: Icons.audit, hint: 'Who did what, on which brand' },
      ] },
      { id: 'account', label: 'Account', items: [billing] },
    ];
  }
  return [
    { id: 'home', items: [overview, tickets] },
    { id: 'brands', label: 'Brands & platforms', items: [
      { href: '/platform/platforms', label: 'Platforms', icon: Icons.platforms, hint: 'Platforms and their admins' },
      onboard,
      registrar,
      { href: '/admin', label: 'Brand back office', icon: Icons.backoffice, hint: 'Open a brand as its admin' },
    ] },
    { id: 'money', label: 'Money', items: [
      accounts,
      { href: '/platform/payments', label: 'Gateways', icon: Icons.gateways, hint: 'Gateway catalogue and credentials' },
      { href: '/platform/mpesa', label: 'M-Pesa defaults', icon: Icons.mpesa, hint: 'The System M-Pesa account' },
      pool,
    ] },
    { id: 'commercial', label: 'Commercial', items: [
      billing,
      { href: '/platform/addons', label: 'Add-ons & requests', icon: Icons.addons, hint: 'Prices and brand requests' },
    ] },
    { id: 'system', label: 'System', items: [
      { href: '/platform/config', label: 'Controls & economy', icon: Icons.controls, hint: 'Kill switches, economy, limits' },
      { href: '/platform/audit', label: 'Audit log', icon: Icons.audit, hint: 'Every privileged action' },
      { href: '/platform/logs', label: 'System logs', icon: Icons.logs, hint: 'API and engine logs' },
      { href: '/platform/engine', label: 'Deployment', icon: Icons.deployment, hint: 'Restart the engine' },
    ] },
  ];
}
