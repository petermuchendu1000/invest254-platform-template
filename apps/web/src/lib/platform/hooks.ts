'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { platformApi, type CreateSiteBody, type OnboardBody } from '@/lib/platform/endpoints';
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
export function useDistributePool() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { totalCents?: number; mode: string; overrides?: Record<string, number> }) => platformApi.distributePool(t, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'pool-distributions'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'global-config'] });
      void qc.invalidateQueries({ queryKey: ['platform', 'sites'] });
    },
  });
}
export function usePoolDistributions() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'pool-distributions'], queryFn: () => platformApi.poolDistributions(t), enabled: !!t });
}

export function usePlatformSites() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'sites'], queryFn: () => platformApi.sites(t), enabled: !!t });
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

/** Mint a brand-scoped superadmin token so the platform owner can enter a client's admin console. */
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

/** Instant client onboarding: brand + economy (+ optional domain provisioning) in one call. */
export function useOnboardClient() {
  const t = useTok();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: OnboardBody) => platformApi.onboard(t, body), onSuccess: invalidate });
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
 * the whole brand re-skins. Both are platform_superadmin writes; served live on the next /site/brand
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
export function usePlatformUserAction(id: string) {
  const t = useTok();
  const qc = useQueryClient();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['platform', 'site-users', id] }); void qc.invalidateQueries({ queryKey: ['platform', 'site-audit', id] }); };
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
