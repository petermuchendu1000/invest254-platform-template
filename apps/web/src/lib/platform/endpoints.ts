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
  // Per-brand M-Pesa config (non-secret) + which secret refs are set + legal copy (docs/24).
  mpesaEnv?: string | null; mpesaShortcode?: string | null; mpesaCallbackBase?: string | null; mpesaB2cInitiator?: string | null;
  hasMpesaConsumerKey?: boolean; hasMpesaConsumerSecret?: boolean; hasMpesaPasskey?: boolean; hasMpesaB2cCredential?: boolean;
  legalCopy?: Record<string, unknown> | null;
  ownerUserId?: string | null;
}
export interface SiteWithConfig extends SiteRow { config: SiteConfig }
export interface SiteKpis {
  siteId: string; slug: string; name: string; status: string;
  users: number; depositsCents: number; withdrawalsCents: number; ggrCents: number; openPositions: number; bets: number;
}
export interface CreateSiteBody { slug: string; name: string; currency?: string | undefined; primaryDomain?: string | undefined }

/** Per-brand performance over a time window (docs/24 performance filters). */
export interface SitePerformance {
  siteId: string; slug: string; name: string; status: string;
  depositsCents: number; withdrawalsCents: number; ggrCents: number; bets: number; stakedCents: number; newPlayers: number;
}
export interface PerformanceResult { fromMs: number; toMs: number; sites: SitePerformance[] }

/** Result of minting a brand-scoped superadmin token for the platform owner (docs/24 impersonation). */
export interface ImpersonateResult {
  token: string; role: string; site: string;
  brand: { siteId: string; slug: string; name: string; primaryDomain: string | null };
}

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

/** Phase 2 (docs/24) — per-brand player management + audit. */
export interface Page<T> { items: T[]; nextCursor?: string | null }
export interface SiteUserRow {
  userId: string; username: string; phone: string; role: string; status: string;
  realBalanceCents: number; bonusBalanceCents: number; depositsCents: number; withdrawalsCents: number; betCount: number;
}
export interface AuditRow {
  id: string; actorId: string; actorRole: string; action: string; targetType: string; targetId: string | null; detail: unknown; createdAtMs: number;
}

export const platformApi = {
  overview: (t: string) => apiFetch<{ sites: SiteKpis[] }>('/platform/overview', { token: t }),
  performance: (t: string, fromMs: number, toMs: number) =>
    apiFetch<PerformanceResult>('/platform/performance', { token: t, query: { from: fromMs, to: toMs } }),
  impersonate: (t: string, siteId: string) =>
    apiFetch<ImpersonateResult>(`/platform/sites/${siteId}/impersonate`, { method: 'POST', token: t }),
  sites: (t: string) => apiFetch<{ sites: SiteWithConfig[] }>('/platform/sites', { token: t }),
  createSite: (t: string, body: CreateSiteBody) =>
    apiFetch<{ siteId: string }>('/platform/sites', { method: 'POST', token: t, body }),
  updateSite: (t: string, id: string, patch: Record<string, unknown>) =>
    apiFetch<SiteRow>(`/platform/sites/${id}`, { method: 'PATCH', token: t, body: patch }),
  setConfig: (t: string, id: string, patch: Record<string, unknown>) =>
    apiFetch<SiteConfig>(`/platform/sites/${id}/config`, { method: 'PATCH', token: t, body: patch }),
  setSiteOwner: (t: string, id: string, ownerUserId: string | null) =>
    apiFetch<SiteRow>(`/platform/sites/${id}/owner`, { method: 'PATCH', token: t, body: { ownerUserId } }),
  setTheme: (t: string, id: string, tokens: Record<string, string>) =>
    apiFetch<SiteRow>(`/platform/sites/${id}/theme`, { method: 'PATCH', token: t, body: { tokens } }),
  // Task R — cross-brand marketer rollup (reporting only).
  marketerRollup: (t: string) => apiFetch<{ marketers: MarketerRollupGroup[] }>('/platform/marketers/rollup', { token: t }),
  // Instant client onboarding (brand + economy + optional domain provisioning).
  onboard: (t: string, body: OnboardBody) => apiFetch<OnboardResult>('/platform/onboard', { method: 'POST', token: t, body }),
  domainStatus: (t: string, domain: string) => apiFetch<DomainStatus>('/platform/onboard/domain-status', { token: t, query: { domain } }),
  // Phase 2 — per-brand players + audit (cross-brand via explicit site id).
  siteUsers: (t: string, id: string, params?: Record<string, string | undefined>) => {
    const query: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) if (v != null && v !== '') query[k] = v;
    return apiFetch<Page<SiteUserRow>>(`/platform/sites/${id}/users`, { token: t, query });
  },
  siteAudit: (t: string, id: string) => apiFetch<Page<AuditRow>>(`/platform/sites/${id}/audit`, { token: t }),
  siteUserStatus: (t: string, id: string, uid: string, body: { status: string; reason?: string | undefined }) =>
    apiFetch(`/platform/sites/${id}/users/${uid}/status`, { method: 'POST', token: t, body }),
  siteUserRole: (t: string, id: string, uid: string, body: { role: string }) =>
    apiFetch(`/platform/sites/${id}/users/${uid}/role`, { method: 'POST', token: t, body }),
  siteUserBalance: (t: string, id: string, uid: string, body: { amountCents: number; reason?: string | undefined; kind?: string | undefined }) =>
    apiFetch(`/platform/sites/${id}/users/${uid}/balance`, { method: 'POST', token: t, body }),
};
