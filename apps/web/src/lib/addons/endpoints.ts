import { apiFetch } from '@/lib/api/client';

export type AddonCategory = 'chart' | 'trade_ui' | 'payment_gateway';
export interface CatalogItem {
  category: AddonCategory; key: string; display_name: string; price_cents: number;
  is_default: boolean; active: boolean; sort_order: number;
}
export interface BrandAddonRow {
  category: AddonCategory; key: string; display_name: string; price_cents: number;
  is_default: boolean; entitled: boolean; active: boolean; pending: boolean;
}
export interface AddonRequestRow {
  id: number; site_id: string; slug: string; name: string; category: AddonCategory; key: string;
  status: string; price_cents: number; note: string | null; created_at: string;
  requested_by: string | null; decided_by: string | null; decided_at: string | null;
}

/** Add-on catalog / entitlements / requests API (Issue 2). Cross-surface: platform console + /admin. */
export const addonApi = {
  catalog: (t: string) => apiFetch<{ items: CatalogItem[] }>('/addons/catalog', { token: t }),
  brand: (t: string, site?: string) => apiFetch<{ items: BrandAddonRow[] }>('/addons/brand', { token: t, query: site ? { site } : {} }),
  request: (t: string, body: { site?: string; category: string; key: string; note?: string }) =>
    apiFetch<{ id: number }>('/addons/request', { method: 'POST', token: t, body }),
  requests: (t: string, status?: string) =>
    apiFetch<{ requests: AddonRequestRow[] }>('/addons/requests', { token: t, query: status ? { status } : {} }),
  decide: (t: string, id: number, decision: 'approve' | 'reject', note?: string) =>
    apiFetch(`/addons/requests/${id}/decide`, { method: 'POST', token: t, body: { decision, note } }),
  setPrice: (t: string, body: { category: string; key: string; priceCents: number }) =>
    apiFetch('/addons/price', { method: 'PUT', token: t, body }),
  grant: (t: string, body: { site: string; category: string; key: string }) =>
    apiFetch('/addons/grant', { method: 'POST', token: t, body }),
  revoke: (t: string, body: { site: string; category: string; key: string }) =>
    apiFetch('/addons/revoke', { method: 'POST', token: t, body }),
};
