import { apiFetch } from '@/lib/api/client';

export type AddonCategory = 'chart' | 'trade_ui' | 'payment_gateway';
export type BillingType = 'free' | 'one_off' | 'monthly';
export interface CatalogItem {
  category: AddonCategory; key: string; display_name: string; description: string; price_cents: number;
  billing_type: BillingType; setup_fee_cents: number; is_default: boolean; active: boolean; sort_order: number;
  /** Owner only (null for operators): brands that own it, brands using it now, open requests. */
  brands: number | null; in_use: number | null; pending: number | null;
}
export interface BrandAddonRow {
  category: AddonCategory; key: string; display_name: string; description: string; price_cents: number;
  billing_type: BillingType; setup_fee_cents: number; is_default: boolean; offered: boolean;
  entitled: boolean; granted_at: string | null; active: boolean; pending: boolean;
  request_id: number | null; requested_at: string | null; request_note: string | null;
}
export interface AddonRequestRow {
  id: number; site_id: string; slug: string; name: string; platform_id: string | null; platform_name: string | null;
  category: AddonCategory; key: string; display_name: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled'; price_cents: number; billing_type: BillingType; setup_fee_cents: number;
  note: string | null; decision_note: string | null; created_at: string;
  requested_by: string | null; requested_by_name: string | null; decided_by: string | null; decided_by_name: string | null; decided_at: string | null;
}
export interface AddonBrandRow {
  site_id: string; name: string; slug: string; status: string; platform_id: string | null; platform_name: string | null;
  chart_style: string; trade_ui: string; owned: string[]; pending: number;
}
export interface AddonPatch {
  displayName?: string; description?: string; billingType?: BillingType; priceCents?: number; setupFeeCents?: number; active?: boolean;
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
  update: (t: string, category: string, key: string, patch: AddonPatch) =>
    apiFetch(`/addons/catalog/${category}/${key}`, { method: 'PATCH', token: t, body: patch }),
  cancel: (t: string, id: number) => apiFetch(`/addons/requests/${id}/cancel`, { method: 'POST', token: t }),
  activate: (t: string, body: { site?: string; category: string; key: string }) =>
    apiFetch('/addons/activate', { method: 'POST', token: t, body }),
  brands: (t: string) => apiFetch<{ brands: AddonBrandRow[] }>('/addons/brands', { token: t }),
};
