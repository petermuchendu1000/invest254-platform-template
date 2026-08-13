'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { platformApi, type CreateSiteBody } from '@/lib/platform/endpoints';
import { useSession } from '@/lib/auth/session';

function useTok() {
  return useSession((s) => s.token) as string;
}

export function usePlatformOverview() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'overview'], queryFn: () => platformApi.overview(t), enabled: !!t });
}

export function usePlatformSites() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'sites'], queryFn: () => platformApi.sites(t), enabled: !!t });
}

/** Cross-brand marketer rollup (docs/22 Task R): per marketer -> per-site clients/GGR/commission + totals. */
export function usePlatformMarketerRollup() {
  const t = useTok();
  return useQuery({ queryKey: ['platform', 'marketers'], queryFn: () => platformApi.marketerRollup(t), enabled: !!t });
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
