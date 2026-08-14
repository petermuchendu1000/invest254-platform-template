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

/** One brand's slice of a marketer's cross-brand rollup (docs/22 Task R). */
export interface MarketerRollupSite {
  affiliateUserId: string; siteId: string; siteSlug: string; siteName: string;
  clients: number; ggrCents: number; commissionCents: number;
}
/** A marketer grouped across brands (by global identity when linked; else standalone). */
export interface MarketerRollupGroup {
  marketerGlobalId: string | null; label: string | null;
  sites: MarketerRollupSite[];
  totals: { clients: number; ggrCents: number; commissionCents: number };
}

/** Platform-superadmin API surface (docs/22 Task H + R). All calls require a platform_superadmin token. */
export interface OnboardColors { primary?: string; bg?: string; accent?: string }
export interface OnboardBody {
  slug: string; name: string; primaryDomain?: string; currency?: string; supportEmail?: string;
  colors?: OnboardColors; provisionDomain?: boolean;
}
export interface ProvisionResult {
  domain: string; zoneId: string; nameServers: string[]; zoneStatus: string;
  nameserversUpdated: boolean; pages: { name: string; status: string }[]; note: string;
}
export interface OnboardBrand {
  siteId: string; slug: string; name: string; primaryDomain: string | null; currency: string; status: string; resolvesByHost: boolean;
}
export interface OnboardResult { siteId: string; brand: OnboardBrand; domain: ProvisionResult | null }
export interface DomainStatus { domain: string; zoneStatus: string | null; pages: { name: string; status: string }[]; active: boolean }

export const platformApi = {
  overview: (t: string) => apiFetch<{ sites: SiteKpis[] }>('/platform/overview', { token: t }),
  sites: (t: string) => apiFetch<{ sites: SiteWithConfig[] }>('/platform/sites', { token: t }),
  createSite: (t: string, body: CreateSiteBody) =>
    apiFetch<{ siteId: string }>('/platform/sites', { method: 'POST', token: t, body }),
  updateSite: (t: string, id: string, patch: Record<string, unknown>) =>
    apiFetch<SiteRow>(`/platform/sites/${id}`, { method: 'PATCH', token: t, body: patch }),
  setConfig: (t: string, id: string, patch: Record<string, unknown>) =>
    apiFetch<SiteConfig>(`/platform/sites/${id}/config`, { method: 'PATCH', token: t, body: patch }),
  setTheme: (t: string, id: string, tokens: Record<string, string>) =>
    apiFetch<SiteRow>(`/platform/sites/${id}/theme`, { method: 'PATCH', token: t, body: { tokens } }),
  // Task R — cross-brand marketer rollup (reporting only).
  marketerRollup: (t: string) => apiFetch<{ marketers: MarketerRollupGroup[] }>('/platform/marketers/rollup', { token: t }),
  // Instant client onboarding (brand + economy + optional domain provisioning).
  onboard: (t: string, body: OnboardBody) => apiFetch<OnboardResult>('/platform/onboard', { method: 'POST', token: t, body }),
  domainStatus: (t: string, domain: string) => apiFetch<DomainStatus>('/platform/onboard/domain-status', { token: t, query: { domain } }),
};
