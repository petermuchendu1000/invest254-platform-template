'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import type { GatewaySchemaDto, ConnResultDto } from '@/lib/platform/endpoints';

/** PAY-1 (docs/43) — per-platform / per-brand payment accounts. */
export type ScopeType = 'platform' | 'site';
export interface ScopeStateDto { scopeType: ScopeType; scopeId: string; name: string; active: boolean; payoutsEnabled: boolean; activatedAtMs: number | null }
export interface ScopedConfigDto {
  providerCode: string; scopeType: ScopeType; scopeId: string; settings: Record<string, string>;
  secretMeta: Record<string, { set: boolean; last4: string }>; hasSecret: boolean; updatedAt: string | null; exists: boolean;
}
export interface GatewayStatusDto { configured: boolean; depositsReady: boolean; payoutsReady: boolean; missing: string[] }
export interface ScopeDetailDto {
  scope: { type: ScopeType; id: string }; state: ScopeStateDto | null;
  schemas: Record<string, GatewaySchemaDto>; configs: Record<string, ScopedConfigDto>; status: Record<string, GatewayStatusDto>;
  liveRails?: string[];
}

const base = (t: ScopeType, id: string) => `/platform/payment-scopes/${t}/${id}`;
export const scopesApi = {
  list: (tok: string, platformId?: string) => apiFetch<{ platformId: string; scopes: ScopeStateDto[] }>('/platform/payment-scopes', { token: tok, query: { platform: platformId } }),
  detail: (tok: string, t: ScopeType, id: string) => apiFetch<ScopeDetailDto>(base(t, id), { token: tok }),
  save: (tok: string, t: ScopeType, id: string, code: string, values: Record<string, string>) =>
    apiFetch<{ config: ScopedConfigDto }>(`${base(t, id)}/gateways/${code}`, { method: 'PUT', token: tok, body: values }),
  remove: (tok: string, t: ScopeType, id: string, code: string) => apiFetch<{ removed: boolean }>(`${base(t, id)}/gateways/${code}/remove`, { method: 'POST', token: tok }),
  test: (tok: string, t: ScopeType, id: string, code: string, values: Record<string, string>) =>
    apiFetch<{ result: ConnResultDto }>(`${base(t, id)}/gateways/${code}/test`, { method: 'POST', token: tok, body: values }),
  activate: (tok: string, t: ScopeType, id: string, payoutsEnabled: boolean) =>
    apiFetch<{ active: boolean; payoutsEnabled: boolean }>(`${base(t, id)}/activate`, { method: 'POST', token: tok, body: { payoutsEnabled } }),
  deactivate: (tok: string, t: ScopeType, id: string) => apiFetch<{ active: boolean }>(`${base(t, id)}/deactivate`, { method: 'POST', token: tok }),
};

const useTok = () => useSession((s) => s.token) as string;
export function usePaymentScopes(platformId?: string) {
  const t = useTok();
  return useQuery({ queryKey: ['payment-scopes', platformId ?? 'own'], queryFn: () => scopesApi.list(t, platformId), enabled: !!t });
}
export function usePaymentScope(type: ScopeType | null, id: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['payment-scope', type, id], queryFn: () => scopesApi.detail(t, type!, id!), enabled: !!t && !!type && !!id });
}
function useScopeMutation<V>(fn: (t: string, v: V) => Promise<unknown>) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => fn(t, v),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payment-scopes'] }); void qc.invalidateQueries({ queryKey: ['payment-scope'] }); },
  });
}
export const useSaveScopedGateway = () => useScopeMutation((t, v: { type: ScopeType; id: string; code: string; values: Record<string, string> }) => scopesApi.save(t, v.type, v.id, v.code, v.values));
export const useRemoveScopedGateway = () => useScopeMutation((t, v: { type: ScopeType; id: string; code: string }) => scopesApi.remove(t, v.type, v.id, v.code));
export const useActivateScope = () => useScopeMutation((t, v: { type: ScopeType; id: string; payoutsEnabled: boolean }) => scopesApi.activate(t, v.type, v.id, v.payoutsEnabled));
export const useDeactivateScope = () => useScopeMutation((t, v: { type: ScopeType; id: string }) => scopesApi.deactivate(t, v.type, v.id));
export function useTestScopedGateway() {
  const t = useTok();
  return useMutation({ mutationFn: (v: { type: ScopeType; id: string; code: string; values: Record<string, string> }) => scopesApi.test(t, v.type, v.id, v.code, v.values) });
}
