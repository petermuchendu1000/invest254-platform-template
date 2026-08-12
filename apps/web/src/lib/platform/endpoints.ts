import { apiFetch } from '@/lib/api/client';

/** A brand's economy (mirrors site_game_config; cents for money fields). */
export interface SiteConfig {
  houseEdge: number; maxMultiplier: number; minStakeCents: number; maxStakeCents: number; minWithdrawalCents: number;
  defaultDurationS: number; tickRateMs: number; driftBias: number; volatility: number; targetWinRate: number; version: number;
}
export interface SiteRow {
  siteId: string; slug: string; name: string; status: string;
  primaryDomain: string | null; logoUrl: string | null; faviconUrl: string | null; wordmarkText: string | null;
  colorPrimary: string; colorBg: string; colorAccent: string; theme: string;
  currency: string; locale: string; licenceLine: string | null; supportEmail: string | null;
}
export interface SiteWithConfig extends SiteRow { config: SiteConfig }
export interface SiteKpis {
  siteId: string; slug: string; name: string; status: string;
  users: number; depositsCents: number; withdrawalsCents: number; ggrCents: number; openPositions: number; bets: number;
}
export interface CreateSiteBody { slug: string; name: string; currency?: string | undefined; primaryDomain?: string | undefined }

/** Platform-superadmin API surface (docs/22 Task H). All calls require a platform_superadmin token. */
export const platformApi = {
  overview: (t: string) => apiFetch<{ sites: SiteKpis[] }>('/platform/overview', { token: t }),
  sites: (t: string) => apiFetch<{ sites: SiteWithConfig[] }>('/platform/sites', { token: t }),
  createSite: (t: string, body: CreateSiteBody) =>
    apiFetch<{ siteId: string }>('/platform/sites', { method: 'POST', token: t, body }),
  updateSite: (t: string, id: string, patch: Record<string, unknown>) =>
    apiFetch<SiteRow>(`/platform/sites/${id}`, { method: 'PATCH', token: t, body: patch }),
  setConfig: (t: string, id: string, patch: Record<string, unknown>) =>
    apiFetch<SiteConfig>(`/platform/sites/${id}/config`, { method: 'PATCH', token: t, body: patch }),
};
