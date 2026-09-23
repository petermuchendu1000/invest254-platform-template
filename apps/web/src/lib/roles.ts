/**
 * One display name per role, used everywhere a role is shown (UI-A / audit B7, B11). The product's
 * vocabulary: System owner → Platform admin → Brand admin; players and marketers are the brand's users.
 */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  platform_superadmin: 'System owner',
  platform_admin: 'Platform admin',
  superadmin: 'Brand superadmin',
  admin: 'Brand admin',
  marketer: 'Marketer',
  player: 'Player',
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
