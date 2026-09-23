'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { platformApi, type CreateSiteBody, type OnboardBody, type RegistrarConfigBody } from '@/lib/platform/endpoints';
import { useSession } from '@/lib/auth/session';
import type { SiteTheme } from '@/lib/brand/siteThemes';
import { faviconDataUri } from '@/lib/brand/mark';

function useTok() {
  return useSession((s) => s.token) as string;
}

export function usePlatformOverview() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'overview'], queryFn: () => platformApi.overview(t), enabled: !!t });
}

// ── Platform tier governance (Issue 1) ──
export function usePlatforms(enabled = true) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'platforms'], queryFn: () => platformApi.platforms(t), enabled: !!t && enabled });
}
export function usePlatformsOverview() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'platforms-overview'], queryFn: () => platformApi.platformsOverview(t), enabled: !!t });
}
function invalidatePlatformTier(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['platform', 'platforms'] });
  void qc.invalidateQueries({ queryKey: ['platform', 'platforms-overview'] });
  void qc.invalidateQueries({ queryKey: ['platform', 'sites'] });
  void qc.invalidateQueries({ queryKey: ['platform', 'platform-admins'] });
  void qc.invalidateQueries({ queryKey: ['platform', 'user-search'] });
}
/** docs/42 UI-9: the current platform admins (System admin only). */
export function usePlatformAdmins(enabled = true) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'platform-admins'], queryFn: () => platformApi.platformAdmins(t), enabled: !!t && enabled });
}
/** docs/42 UI-9: cross-brand directory search; pass an already-debounced query (>= 2 chars to run). */
export function useUserSearch(q: string) {
  const t = useTok(); const needle = q.trim();
  return useQuery({
    queryKey: ['platform', 'user-search', needle],
    queryFn: () => platformApi.searchUsers(t, needle),
    enabled: !!t && needle.length >= 2,
    staleTime: 15_000,
  });
}
export function useCreatePlatform() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { slug: string; name: string; ownerUserId?: string }) => platformApi.createPlatform(t, body),
    onSuccess: () => invalidatePlatformTier(qc),
  });
}
export function useUpdatePlatform() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: Record<string, unknown> }) => platformApi.updatePlatform(t, v.id, v.patch),
    onSuccess: () => invalidatePlatformTier(qc),
  });
}
export function useAssignSiteToPlatform() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { siteId: string; platformId: string }) => platformApi.assignSiteToPlatform(t, v.siteId, v.platformId),
    onSuccess: () => invalidatePlatformTier(qc),
  });
}
export function useAppointPlatformAdmin() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { userId: string; platformId: string }) => platformApi.appointPlatformAdmin(t, body),
    onSuccess: () => invalidatePlatformTier(qc),
  });
}
export function useRevokePlatformAdmin() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { userId: string; newRole: string }) => platformApi.revokePlatformAdmin(t, v.userId, v.newRole),
    onSuccess: () => invalidatePlatformTier(qc),
  });
}

// ── Global config console (migration 0092) ──
export function useGlobalConfig() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'global-config'], queryFn: () => platformApi.globalConfig(t), enabled: !!t });
}
export function useSetGlobalConfig() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => platformApi.setGlobalConfig(t, patch),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform', 'global-config'] }); },
  });
}
export function useDistributePool(platformId?: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { totalCents?: number; mode: string; overrides?: Record<string, number> }) => platformApi.distributePool(t, body, platformId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'pool-distributions'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'global-config'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'sites'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'pool-overview'] });
    },
  });
}
// POOL-1 (docs/46)
const invalidatePool = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ['pool-overview', 'pool-auto', 'pool-distributions', 'pool-demand', 'sites']) void qc.invalidateQueries({ queryKey: ['platform', k] });
};
export function usePoolOverview(platformId?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'pool-overview', platformId ?? 'all'], queryFn: () => platformApi.poolOverview(t, platformId), enabled: !!t, refetchInterval: 60_000 });
}
export function usePoolAutoSettings(platformId?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'pool-auto', platformId ?? 'own'], queryFn: () => platformApi.poolAutoSettings(t, platformId), enabled: !!t });
}
export function useSavePoolAutoSettings(platformId?: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mode: 'dynamic' | 'equal' | 'off'; dailyTotalCents: number | null; lookbackDays: number }) => platformApi.savePoolAutoSettings(t, body, platformId),
    onSuccess: () => invalidatePool(qc),
  });
}
export function useRunPoolAuto(platformId?: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({ mutationFn: () => platformApi.runPoolAuto(t, platformId), onSuccess: () => invalidatePool(qc) });
}
export function usePoolDistributions(platformId?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'pool-distributions', platformId ?? 'all'], queryFn: () => platformApi.poolDistributions(t, platformId), enabled: !!t });
}

// ── Payment-gateway provider switches (migration 0116) ──
export function usePaymentProviders() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'payment-providers'], queryFn: () => platformApi.paymentProviders(t), enabled: !!t });
}
export function useSetProviderGlobal() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { code: string; enabled: boolean }) => platformApi.setProviderGlobal(t, v.code, v.enabled),
    onSuccess: (data) => { qc.setQueryData(['platform', 'payment-providers'], data); },
  });
}
export function useSetProviderSite() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { code: string; siteId: string; enabled: boolean | null }) => platformApi.setProviderSite(t, v.code, v.siteId, v.enabled),
    onSuccess: (data) => { qc.setQueryData(['platform', 'payment-providers'], data); },
  });
}

// ── Gateway CONFIGURATION (migration 0130) ──
export function useGatewayConfigs() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'gateway-configs'], queryFn: () => platformApi.gatewayConfigs(t), enabled: !!t });
}
export function useSaveGatewayConfig() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { code: string; values: Record<string, string> }) => platformApi.saveGatewayConfig(t, v.code, v.values),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform', 'gateway-configs'] }); },
  });
}
export function useTestGatewayConfig() {
  const t = useTok();
  return useMutation({
    mutationFn: (v: { code: string; draft: Record<string, string> }) => platformApi.testGatewayConfig(t, v.code, v.draft),
  });
}

// Dynamic (demand-based) distribution (docs/25 §15)
export function usePoolDemand(params: { lookbackDays?: number | undefined; totalCents?: number | undefined }, enabled = true, platformId?: string) {
  const t = useTok();
  return useQuery({
    queryKey: ['platform', 'pool-demand', params.lookbackDays ?? null, params.totalCents ?? null, platformId ?? 'all'],
    queryFn: () => platformApi.poolDemand(t, params, platformId),
    enabled: !!t && enabled,
  });
}
export function useDistributePoolDynamic(platformId?: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { totalCents?: number | undefined; lookbackDays?: number | undefined }) => platformApi.distributePoolDynamic(t, body, platformId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'pool-distributions'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'pool-demand'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'global-config'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'sites'] });
    },
  });
}

export function usePlatformSites(platformId?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'sites', platformId ?? 'all'], queryFn: () => platformApi.sites(t, platformId), enabled: !!t });
}

/** Per-brand performance over a [fromMs, toMs) window (docs/24 performance filters). Disabled until
 *  a range is active; the query key includes the range so changing dates refetches. */
export function usePlatformPerformance(fromMs: number | null, toMs: number | null) {
  const t = useTok();
  return useQuery({
    queryKey: ['platform', 'performance', fromMs, toMs],
    queryFn: () => platformApi.performance(t, fromMs as number, toMs as number),
    enabled: !!t && fromMs != null && toMs != null && toMs > fromMs,
  });
}

/** Cross-brand marketer rollup (docs/22 Task R): per marketer -> per-site clients/GGR/commission + totals. */
export function usePlatformMarketerRollup() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'marketers'], queryFn: () => platformApi.marketerRollup(t), enabled: !!t });
}

/** Mint a brand-scoped `admin` token so the owner or a platform admin can enter a client's admin console. */
export function useImpersonate() {
  const t = useTok();
  return useMutation({ mutationFn: (siteId: string) => platformApi.impersonate(t, siteId) });
}

/** Invalidate both platform reads after any mutation so the console reflects the change. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['platform', 'sites'] });
    void qc.invalidateQueries({ queryKey: ['platform', 'overview'] });
  };
}

export function useCreateSite() {
  const t = useTok();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: CreateSiteBody) => platformApi.createSite(t, body), onSuccess: invalidate });
}

/** Onboarding capabilities: is Cloudflare provisioning on, and are nameservers auto-set (else manual)? */
export function useOnboardCapabilities(platformId?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'onboard-caps', platformId ?? ''], queryFn: () => platformApi.onboardCapabilities(t, platformId), enabled: !!t, staleTime: 300_000 });
}

/** List the registrar (Namecheap) account's domains, annotated with which are already clients. */
export function useRegistrarDomains(enabled = true, platformId?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'registrar-domains', platformId ?? ''], queryFn: () => platformApi.registrarDomains(t, platformId), enabled: !!t && enabled, staleTime: 60_000 });
}

/** Real per-domain health (Cloudflare Pages custom-domain statuses) for a truthful Clients table. */
export function useDomainHealth() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'domain-health'], queryFn: () => platformApi.domainHealth(t), enabled: !!t, staleTime: 60_000 });
}

/** Instant client onboarding: brand + economy (+ optional domain provisioning) in one call. */
export function useOnboardClient() {
  const t = useTok();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: OnboardBody) => platformApi.onboard(t, body), onSuccess: invalidate });
}

// ── Per-platform registrar (Namecheap) config (Issue 1 #3) ──────────────────────────────────────
/** docs/42 UI-9: `platformId` — the System admin's chosen platform (ignored server-side for a platform admin). */
export function useRegistrarConfig(platformId?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'registrar-config', platformId ?? ''], queryFn: () => platformApi.registrarConfig(t, platformId), enabled: !!t });
}
export function useSetRegistrarConfig(platformId?: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RegistrarConfigBody) => platformApi.setRegistrarConfig(t, body, platformId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'registrar-config'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'onboard-caps'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'registrar-domains'] });
    },
  });
}
export function useTestRegistrarConfig(platformId?: string) {
  const t = useTok();
  return useMutation({ mutationFn: (body: RegistrarConfigBody) => platformApi.testRegistrarConfig(t, body, platformId) });
}

/** Poll a domain's provisioning status (zone active + Pages custom domains validated). */
export function useDomainStatus(domain: string | null) {
  const t = useTok();
  return useQuery({
    queryKey: ['platform', 'domain-status', domain],
    queryFn: () => platformApi.domainStatus(t, domain as string),
    enabled: !!t && !!domain,
    refetchInterval: 15_000,
  });
}

export function useUpdateSite() {
  const t = useTok();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; patch: Record<string, unknown> }) => platformApi.updateSite(t, v.id, v.patch),
    onSuccess: invalidate,
  });
}

export function useSetSiteConfig() {
  const t = useTok();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; patch: Record<string, unknown> }) => platformApi.setConfig(t, v.id, v.patch),
    onSuccess: invalidate,
  });
}

/** Assign/clear a brand's marketer (owner_user_id) — site-owner commission model. */
export function useSetSiteOwner() {
  const t = useTok();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; ownerUserId: string | null }) => platformApi.setSiteOwner(t, v.id, v.ownerUserId),
    onSuccess: invalidate,
  });
}

/** Persist a brand's full design-token palette (docs/22 Task G+). */
export function useSetSiteTheme() {
  const t = useTok();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; tokens: Record<string, string> }) => platformApi.setTheme(t, v.id, v.tokens),
    onSuccess: invalidate,
  });
}

/**
 * Apply a COMPLETE curated site theme (one of the 56 mirrors in lib/brand/siteThemes) to a client in
 * one action: writes the full token palette (theme_tokens) AND the mode + legacy colour_* columns so
 * the whole brand re-skins. Both are platform-tier writes (owner or the brand's platform admin); served live on the next /site/brand
 * fetch (colours instant; radius/mono/heading render once the web build carries the token contract).
 */
export function useApplySiteTheme() {
  const t = useTok();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (v: { id: string; slug: string; theme: SiteTheme }) => {
      const tk = v.theme.tokens as unknown as Record<string, string>;
      // Regenerate the THEME-AWARE favicon from this theme's colours (shape seeded by slug), and
      // clear any stale raster logo so the app renders the live token-driven mark. Then mode +
      // colours, then the full token palette.
      const favicon = faviconDataUri(tk, v.slug || v.id);
      await platformApi.updateSite(t, v.id, {
        theme: v.theme.mode, color_primary: tk.brand, color_bg: tk.bg, color_accent: tk.accent,
        favicon_url: favicon, logo_url: '',
      });
      return platformApi.setTheme(t, v.id, tk);
    },
    onSuccess: invalidate,
  });
}

/** Phase 2 — players in a brand (searchable). */
export function usePlatformSiteUsers(id: string, params?: Record<string, string | undefined>) {
  const t = useTok();
  return useQuery({
    queryKey: ['platform', 'site-users', id, params],
    queryFn: () => platformApi.siteUsers(t, id, params),
    enabled: !!t && !!id,
  });
}

/** Phase 2 — a brand's audit trail. */
export function usePlatformSiteAudit(id: string) {
  const t = useTok();
  return useQuery({
    queryKey: ['platform', 'site-audit', id],
    queryFn: () => platformApi.siteAudit(t, id),
    enabled: !!t && !!id,
  });
}

/** Phase 2 — player actions (status / role / balance) for a brand; refreshes the players list. */
/** docs/42 UI-10: one player's detail in the console (platform-scoped server-side). */
export function usePlatformUserDetail(siteId: string, uid: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'site-user', siteId, uid], queryFn: () => platformApi.siteUserDetail(t, siteId, uid as string), enabled: !!t && !!uid });
}
export function usePlatformUserOverrides(siteId: string, uid: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'site-user-overrides', siteId, uid], queryFn: () => platformApi.siteUserOverrides(t, siteId, uid as string), enabled: !!t && !!uid });
}
export function useSetPlatformUserOverrides(siteId: string, uid: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: import('@/lib/admin/types').UserOverridePatch) => platformApi.setSiteUserOverrides(t, siteId, uid, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'site-user-overrides', siteId, uid] });
      void qc.invalidateQueries({ queryKey: ['platform', 'site-audit', siteId] });
      void qc.invalidateQueries({ queryKey: ['platform', 'audit-log'] });
    },
  });
}
/** docs/42 UI-10: the audit trail across the caller's platform (owner: every brand, or one platform). */
export function usePlatformAudit(q: { platformId?: string | undefined; siteId?: string | undefined }) {
  const t = useTok();
  return useInfiniteQuery({
    queryKey: ['platform', 'audit-log', q.platformId ?? 'all', q.siteId ?? 'all'],
    enabled: !!t,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => platformApi.platformAudit(t, { ...q, cursor: pageParam, limit: 50 }),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
}
export function usePlatformUserAction(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['platform', 'site-users', id] });
    void qc.invalidateQueries({ queryKey: ['platform', 'site-user', id] });
    void qc.invalidateQueries({ queryKey: ['platform', 'site-audit', id] });
    void qc.invalidateQueries({ queryKey: ['platform', 'audit-log'] });
  };
  return useMutation({
    mutationFn: async (v:
      | { kind: 'status'; uid: string; status: string; reason?: string }
      | { kind: 'role'; uid: string; role: string }
      | { kind: 'balance'; uid: string; amountCents: number; reason?: string; balanceKind?: string }) => {
      if (v.kind === 'status') return platformApi.siteUserStatus(t, id, v.uid, { status: v.status, reason: v.reason });
      if (v.kind === 'role') return platformApi.siteUserRole(t, id, v.uid, { role: v.role });
      return platformApi.siteUserBalance(t, id, v.uid, { amountCents: v.amountCents, reason: v.reason, kind: v.balanceKind });
    },
    onSuccess: refresh,
  });
}
