'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { addonApi, type AddonPatch } from '@/lib/addons/endpoints';

function useTok(): string { return useSession((s) => s.token) as string; }

export function useAddonCatalog() {
  const t = useTok();
  return useQuery({ queryKey: ['addons', 'catalog'], queryFn: () => addonApi.catalog(t), enabled: !!t });
}
export function useAddonBrand(site?: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['addons', 'brand', site ?? 'self'], queryFn: () => addonApi.brand(t, site ?? undefined), enabled: !!t });
}
export function useAddonRequests(status?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['addons', 'requests', status ?? null], queryFn: () => addonApi.requests(t, status), enabled: !!t });
}
export function useRequestAddon() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { site?: string; category: string; key: string; note?: string }) => addonApi.request(t, b),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['addons'] }); },
  });
}
export function useDecideAddonRequest() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; decision: 'approve' | 'reject'; note?: string }) => addonApi.decide(t, v.id, v.decision, v.note),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['addons'] }); },
  });
}
export function useSetAddonPrice() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { category: string; key: string; priceCents: number }) => addonApi.setPrice(t, b),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['addons', 'catalog'] }); },
  });
}
export function useGrantAddon() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { site: string; category: string; key: string }) => addonApi.grant(t, b),
    // a chart / trade-UI grant also changes the brand's ACTIVE system (sites.chart_style / trade_ui)
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['addons'] }); void qc.invalidateQueries({ queryKey: ['platform', 'sites'] }); },
  });
}
export function useRevokeAddon() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { site: string; category: string; key: string }) => addonApi.revoke(t, b),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['addons'] }); void qc.invalidateQueries({ queryKey: ['platform', 'sites'] }); },
  });
}

// ── ADDON-1 ──
function useAll() { const qc = useQueryClient(); return () => { void qc.invalidateQueries({ queryKey: ['addons'] }); void qc.invalidateQueries({ queryKey: ['platform', 'sites'] }); void qc.invalidateQueries({ queryKey: ['billing'] }); }; }
export function useAddonBrands(enabled = true) {
  const t = useTok();
  return useQuery({ queryKey: ['addons', 'brands'], queryFn: () => addonApi.brands(t), enabled: !!t && enabled });
}
export function useUpdateAddon() {
  const t = useTok(); const inv = useAll();
  return useMutation({ mutationFn: (v: { category: string; key: string; patch: AddonPatch }) => addonApi.update(t, v.category, v.key, v.patch), onSuccess: inv });
}
export function useCancelAddonRequest() {
  const t = useTok(); const inv = useAll();
  return useMutation({ mutationFn: (id: number) => addonApi.cancel(t, id), onSuccess: inv });
}
export function useActivateAddon() {
  const t = useTok(); const inv = useAll();
  return useMutation({ mutationFn: (b: { site?: string; category: string; key: string }) => addonApi.activate(t, b), onSuccess: inv });
}
