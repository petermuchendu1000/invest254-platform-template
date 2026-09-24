import { apiFetch } from '@/lib/api/client';
import type { CohortEconomy, PaymentsEconomy } from '@invest254/shared/globaleconomy';
import type { AdminUserDetail, UserOverrideRow, UserOverridePatch } from '@/lib/admin/types';

/** A brand's economy (mirrors site_game_config; cents for money fields). */
export interface SiteConfig {
  houseEdge: number; maxMultiplier: number; minStakeCents: number; maxStakeCents: number; minWithdrawalCents: number;
  /** Currency-native minimum withdrawal in the brand's display currency major units (docs/25 §16). */
  minWithdrawalNative?: number | null;
  defaultDurationS: number; tickRateMs: number; driftBias: number; volatility: number; targetWinRate: number; version: number;
}
export interface SiteRow {
  siteId: string; slug: string; name: string; status: string;
  primaryDomain: string | null; logoUrl: string | null; faviconUrl: string | null; wordmarkText: string | null;
  colorPrimary: string; colorBg: string; colorAccent: string; theme: string;
  currency: string; locale: string; chartStyle?: string; tradeUi?: string; licenceLine: string | null; supportEmail: string | null; supportWhatsapp?: string | null;
  // Per-brand M-Pesa config (non-secret) + which secret refs are set + legal copy (docs/24).
  mpesaEnv?: string | null; mpesaShortcode?: string | null; mpesaCallbackBase?: string | null; mpesaB2cInitiator?: string | null;
  hasMpesaConsumerKey?: boolean; hasMpesaConsumerSecret?: boolean; hasMpesaPasskey?: boolean; hasMpesaB2cCredential?: boolean;
  legalCopy?: Record<string, unknown> | null;
  ownerUserId?: string | null;
  /** UI-F: the platform the brand belongs to. */
  platformId?: string | null;
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

/** Result of minting a brand-scoped `admin` token (with an `act` claim) for the owner or a platform admin (docs/24 impersonation). */
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

/** Platform-superadmin API surface (docs/22 Task H + R). Gated per route: system-owner routes vs platform-admin routes (see docs/42 §3). */
export interface OnboardColors { primary?: string; bg?: string; accent?: string }
export interface OnboardBody {
  slug: string; name: string; primaryDomain?: string; currency?: string; supportEmail?: string;
  colors?: OnboardColors; provisionDomain?: boolean; platformId?: string;
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
export interface RegistrarDomainRow { domain: string; expires: string | null; usingRegistrarDns: boolean; alreadyClient: boolean; suggestedSlug: string; suggestedName: string }
export interface RegistrarDomainsDto { registrarConfigured: boolean; domains: RegistrarDomainRow[] }

/** Per-platform registrar (Namecheap) config (Issue 1 #3). The API key is never returned — only masked. */
export interface RegistrarConfigDto {
  platformId: string; providerCode: string; settings: Record<string, string>;
  secretMeta: Record<string, { set: boolean; last4: string }>; hasSecret: boolean;
  encVersion: number; updatedAt: string | null; exists: boolean;
  egressIp: string | null; encryptionConfigured: boolean;
}
export interface RegistrarConfigSaveDto { platformId: string; hasSecret: boolean; settings: Record<string, string>; exists: boolean }
export interface RegistrarTestDto { ok: boolean; detail: string; egressIp: string | null }
export interface RegistrarConfigBody { apiUser?: string; userName?: string; clientIp?: string; apiKey?: string }

/** Phase 2 (docs/24) — per-brand player management + audit. */
export interface Page<T> { items: T[]; nextCursor?: string | null }
export interface SiteUserRow {
  userId: string; username: string; phone: string; role: string; status: string;
  realBalanceCents: number; bonusBalanceCents: number; depositsCents: number; withdrawalsCents: number; betCount: number;
}
export interface AuditRow {
  id: string; actorId: string; actorRole: string; action: string; targetType: string; targetId: string | null; detail: unknown; createdAtMs: number;
}
/** docs/42 UI-10: an audit row in the platform-wide view (brand + actor name). */
export interface PlatformAuditRowDto extends AuditRow { siteId: string | null; siteName: string | null; actorUsername: string | null }

/** Platform-wide master config (migrations 0092 + 0099) — the global console. */
export interface GlobalConfigDto {
  depositsEnabled: boolean; withdrawalsEnabled: boolean; playEnabled: boolean;
  marketersEnabled: boolean; registrationsEnabled: boolean;
  maintenanceMessage: string | null; globalDailyPoolCents: number | null;
  // Migration 0099 — per-field ENFORCE-able economy overrides (global wins over site + user).
  playerEconomy: CohortEconomy; marketerEconomy: CohortEconomy; payments: PaymentsEconomy;
  version: number; updatedAt: string | null;
}
export interface DistributeResultDto { totalCents: number; mode: string; perSite: Record<string, number> }
export interface PoolDistributionDto { id: number; totalCents: number; mode: string; siteCount: number; perSite: Record<string, number>; createdAt: string; source?: string }
/** POOL-1 (docs/46): one brand's pool today. */
export interface PoolOverviewRowDto {
  siteId: string; name: string; slug: string; platformId: string | null; platformName: string | null;
  poolMode: boolean; withdrawalsEnabled: boolean; defaultCents: number; todayCents: number; paidCents: number;
  reservedCents: number; availableCents: number; todaySet: boolean; pendingCount: number; pendingCents: number;
  paid7dCents: number; lastChangedAtMs: number | null;
}
export type PoolAutoMode = 'dynamic' | 'equal' | 'off';
export interface PoolAutoSettingsDto {
  platformId: string; mode: PoolAutoMode; dailyTotalCents: number | null; lookbackDays: number; isDefault: boolean;
  lastRunAtMs: number | null; lastRunOk: boolean | null; lastRunMessage: string | null; updatedAtMs: number | null;
}
export interface PoolAutoRunDto { platformId: string; mode: PoolAutoMode; ok: boolean; message: string; totalCents: number; brands: number }

/** Superadmin payment-gateway registry view (migration 0116). */
export interface PaymentProviderDto { code: string; displayName: string; enabledGlobal: boolean; sortOrder: number }
export interface PaymentProviderOverrideDto { siteId: string; providerCode: string; enabled: boolean }
export interface PaymentProvidersDto { providers: PaymentProviderDto[]; overrides: PaymentProviderOverrideDto[] }

// ── Gateway CONFIGURATION (migration 0130): credentials + settings, secrets masked to the browser ──
export interface GatewayFieldDto {
  key: string; label: string; kind: 'text' | 'secret' | 'select' | 'url' | 'email' | 'number';
  secret: boolean; required: boolean; placeholder?: string; help?: string;
  options?: { value: string; label: string }[]; default?: string; pattern?: string; group?: string;
}
export interface GatewaySchemaDto { code: string; displayName: string; docsUrl: string; blurb: string; playerAvailable: boolean; fields: GatewayFieldDto[] }
export interface GatewayConfigDto {
  providerCode: string; siteId: string | null;
  settings: Record<string, string>;
  secretMeta: Record<string, { set: boolean; last4: string }>;
  hasSecret: boolean; encVersion: number; updatedAt: string | null; exists: boolean;
}
export interface GatewayConfigEntryDto { code: string; schema: GatewaySchemaDto; config: GatewayConfigDto }
export interface GatewayConfigsDto { providers: GatewayConfigEntryDto[] }
export interface ConnResultDto { ok: boolean; status: 'valid' | 'invalid' | 'unreachable' | 'not_configured'; detail: string }

// Dynamic (demand-based) pool distribution (docs/25 §15)
export interface PoolDemandRowDto {
  siteId: string; slug: string; targetRtp: number;
  forecastTurnoverCents: number; recentTurnoverCents: number; requiredCents: number;
  currentPoolCents: number; suggestedCents: number; coverage: number;
}
export interface PoolDemandPreviewDto {
  lookbackDays: number; totalCents: number; alpha: number; floorFrac: number; capMult: number;
  rows: PoolDemandRowDto[]; suggestedTotalCents: number; reserveCents: number;
}
export interface DistributeDynamicResultDto extends DistributeResultDto { preview: PoolDemandPreviewDto }

export const platformApi = {
  overview: (t: string) => apiFetch<{ sites: SiteKpis[] }>('/platform/overview', { token: t }),
  performance: (t: string, fromMs: number, toMs: number) =>
    apiFetch<PerformanceResult>('/platform/performance', { token: t, query: { from: fromMs, to: toMs } }),
  impersonate: (t: string, siteId: string) =>
    apiFetch<ImpersonateResult>(`/platform/sites/${siteId}/impersonate`, { method: 'POST', token: t }),
  sites: (t: string, platformId?: string) => apiFetch<{ sites: SiteWithConfig[] }>('/platform/sites', { token: t, query: { platform: platformId } }),
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
  // docs/42 UI-9: `platformId` is honoured for the System admin only (a platform admin is pinned server-side).
  onboardCapabilities: (t: string, platformId?: string) => apiFetch<{ domainConfigured: boolean; registrarConfigured: boolean }>('/platform/onboard/capabilities', { token: t, query: { platform: platformId } }),
  registrarDomains: (t: string, platformId?: string) => apiFetch<RegistrarDomainsDto>('/platform/domains/registrar', { token: t, query: { platform: platformId } }),
  domainHealth: (t: string) => apiFetch<{ configured: boolean; statuses: Record<string, string> }>('/platform/domains/health', { token: t }),
  domainStatus: (t: string, domain: string) => apiFetch<DomainStatus>('/platform/onboard/domain-status', { token: t, query: { domain } }),
  // Per-platform registrar (Namecheap) configuration (Issue 1 #3).
  registrarConfig: (t: string, platformId?: string) => apiFetch<RegistrarConfigDto>('/platform/registrar/config', { token: t, query: { platform: platformId } }),
  setRegistrarConfig: (t: string, body: RegistrarConfigBody, platformId?: string) => apiFetch<RegistrarConfigSaveDto>('/platform/registrar/config', { method: 'PUT', token: t, body, query: { platform: platformId } }),
  testRegistrarConfig: (t: string, body: RegistrarConfigBody, platformId?: string) => apiFetch<RegistrarTestDto>('/platform/registrar/config/test', { method: 'POST', token: t, body, query: { platform: platformId } }),
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
  // docs/42 UI-10 — player detail, overrides (read + validated write) and the platform-wide audit trail
  siteUserDetail: (t: string, id: string, uid: string) => apiFetch<AdminUserDetail>(`/platform/sites/${id}/users/${uid}`, { token: t }),
  siteUserOverrides: (t: string, id: string, uid: string) => apiFetch<UserOverrideRow>(`/platform/sites/${id}/users/${uid}/overrides`, { token: t }),
  setSiteUserOverrides: (t: string, id: string, uid: string, patch: UserOverridePatch) =>
    apiFetch<UserOverrideRow>(`/platform/sites/${id}/users/${uid}/overrides`, { method: 'PATCH', token: t, body: patch }),
  platformAudit: (t: string, q: { platformId?: string | undefined; siteId?: string | undefined; cursor?: string | undefined; limit?: number | undefined }) =>
    apiFetch<Page<PlatformAuditRowDto>>('/platform/audit-log', { token: t, query: { platform: q.platformId, site: q.siteId, cursor: q.cursor, limit: q.limit } }),
  // ── Global config console (migration 0092) ──
  globalConfig: (t: string) => apiFetch<{ config: GlobalConfigDto }>('/platform/global-config', { token: t }),
  // ── Payment-gateway provider switches (migration 0116) ──
  paymentProviders: (t: string) => apiFetch<PaymentProvidersDto>('/platform/payment-providers', { token: t }),
  setProviderGlobal: (t: string, code: string, enabled: boolean) =>
    apiFetch<PaymentProvidersDto>(`/platform/payment-providers/${encodeURIComponent(code)}/global`, { method: 'POST', token: t, body: { enabled } }),
  setProviderSite: (t: string, code: string, siteId: string, enabled: boolean | null) =>
    apiFetch<PaymentProvidersDto>(`/platform/payment-providers/${encodeURIComponent(code)}/site`, { method: 'POST', token: t, body: { siteId, enabled } }),

  // ── Gateway config (migration 0130) ──
  gatewayConfigs: (t: string) => apiFetch<GatewayConfigsDto>('/platform/payment-providers/config', { token: t }),
  saveGatewayConfig: (t: string, code: string, values: Record<string, string>) =>
    apiFetch<{ config: GatewayConfigDto }>(`/platform/payment-providers/${encodeURIComponent(code)}/config`, { method: 'PUT', token: t, body: values }),
  testGatewayConfig: (t: string, code: string, draft: Record<string, string>) =>
    apiFetch<{ result: ConnResultDto }>(`/platform/payment-providers/${encodeURIComponent(code)}/config/test`, { method: 'POST', token: t, body: draft }),
  setGlobalConfig: (t: string, patch: Record<string, unknown>) =>
    apiFetch<{ config: GlobalConfigDto }>('/platform/global-config', { method: 'PATCH', token: t, body: patch }),
  // docs/42 UI-9: `platformId` scopes the System admin's pool actions to one platform (omitted = global).
  distributePool: (t: string, body: { totalCents?: number; mode: string; overrides?: Record<string, number> }, platformId?: string) =>
    apiFetch<{ result: DistributeResultDto }>('/platform/pool/distribute', { method: 'POST', token: t, body, query: { platform: platformId } }),
  poolDistributions: (t: string, platformId?: string) =>
    apiFetch<{ distributions: PoolDistributionDto[] }>('/platform/pool/distributions', { token: t, query: { platform: platformId } }),
  // POOL-1 (docs/46): per-brand overview + automatic daily distribution.
  poolOverview: (t: string, platformId?: string) =>
    apiFetch<{ platformId: string | null; brands: PoolOverviewRowDto[] }>('/platform/pool/overview', { token: t, query: { platform: platformId } }),
  poolAutoSettings: (t: string, platformId?: string) =>
    apiFetch<{ settings: PoolAutoSettingsDto }>('/platform/pool/auto-settings', { token: t, query: { platform: platformId } }),
  savePoolAutoSettings: (t: string, body: { mode: PoolAutoMode; dailyTotalCents: number | null; lookbackDays: number }, platformId?: string) =>
    apiFetch<{ settings: PoolAutoSettingsDto }>('/platform/pool/auto-settings', { method: 'PUT', token: t, body, query: { platform: platformId } }),
  runPoolAuto: (t: string, platformId?: string) =>
    apiFetch<{ run: PoolAutoRunDto }>('/platform/pool/auto-run', { method: 'POST', token: t, query: { platform: platformId } }),
  // Dynamic (demand-based) distribution — preview (read-only) + apply.
  poolDemand: (t: string, params?: { lookbackDays?: number | undefined; totalCents?: number | undefined }, platformId?: string) => {
    const query: Record<string, number | string> = {};
    if (platformId) query.platform = platformId;
    if (params?.lookbackDays != null) query.lookbackDays = params.lookbackDays;
    if (params?.totalCents != null) query.totalCents = params.totalCents;
    return apiFetch<{ preview: PoolDemandPreviewDto }>('/platform/pool/demand', { token: t, query });
  },
  distributePoolDynamic: (t: string, body: { totalCents?: number | undefined; lookbackDays?: number | undefined }, platformId?: string) =>
    apiFetch<{ result: DistributeDynamicResultDto }>('/platform/pool/distribute-dynamic', { method: 'POST', token: t, body, query: { platform: platformId } }),

  // ── Platform tier governance (Issue 1) — System-admin only ──
  platforms: (t: string) => apiFetch<{ platforms: PlatformDto[] }>('/platform/platforms', { token: t }),
  platformsOverview: (t: string) => apiFetch<{ platforms: PlatformKpisDto[] }>('/platform/platforms/overview', { token: t }),
  createPlatform: (t: string, body: { slug: string; name: string; ownerUserId?: string }) =>
    apiFetch<{ platformId: string }>('/platform/platforms', { method: 'POST', token: t, body }),
  updatePlatform: (t: string, id: string, patch: Record<string, unknown>) =>
    apiFetch<PlatformDto>(`/platform/platforms/${id}`, { method: 'PATCH', token: t, body: patch }),
  assignSiteToPlatform: (t: string, siteId: string, platformId: string) =>
    apiFetch<{ siteId: string; platformId: string }>(`/platform/sites/${siteId}/assign`, { method: 'POST', token: t, body: { platformId } }),
  appointPlatformAdmin: (t: string, body: { userId: string; platformId: string }) =>
    apiFetch<AppointResultDto>('/platform/platform-admins', { method: 'POST', token: t, body }),
  revokePlatformAdmin: (t: string, uid: string, newRole: string) =>
    apiFetch<{ userId: string; role: string }>(`/platform/platform-admins/${uid}/revoke`, { method: 'POST', token: t, body: { newRole } }),
  // docs/42 UI-9: who the platform admins are + find a person across brands (System admin only)
  platformAdmins: (t: string, platformId?: string) =>
    apiFetch<{ admins: PlatformAdminDto[] }>('/platform/platform-admins', { token: t, query: { platform: platformId } }),
  searchUsers: (t: string, q: string) =>
    apiFetch<{ users: DirectoryUserDto[] }>('/platform/users/search', { token: t, query: { q } }),
};

/** Platform tier (Issue 1). */
export interface PlatformDto { platformId: string; slug: string; name: string; status: string; ownerUserId: string | null; notes: string | null }
export interface PlatformKpisDto { platformId: string; slug: string; name: string; status: string; sites: number; users: number; siteAdmins: number; platformAdmins: number }
export interface AppointResultDto { userId: string; role: string; platformId: string | null }
export interface PlatformAdminDto {
  userId: string; username: string | null; phone: string | null; status: string;
  platformId: string | null; platformName: string | null; homeSiteId: string | null; homeSiteName: string | null; createdAtMs: number;
}
export interface DirectoryUserDto {
  userId: string; username: string | null; phone: string | null; role: string; status: string;
  siteId: string | null; siteName: string | null; platformId: string | null; platformName: string | null; isDefaultMarketer: boolean;
}
