/**
 * addonservice.ts — add-on catalog / entitlements / requests service (Issue 2, API layer).
 *
 * Thin, typed wrapper over the SECURITY DEFINER RPCs (0144-0146). Authorization + scope live in the
 * RPCs (system-admin-only writes; requesters bounded by fn_actor_target_sites); this layer only shapes
 * arguments and returns. Used by /api/v1/addons/* and by the payments/chart enforcement paths.
 */
import type { Querier } from "@invest254/engine";

export type AddonCategory = "chart" | "trade_ui" | "payment_gateway";
export type BillingType = "free" | "one_off" | "monthly";
export interface CatalogItem {
  category: AddonCategory; key: string; display_name: string; description: string; price_cents: number;
  billing_type: BillingType; setup_fee_cents: number; is_default: boolean; active: boolean; sort_order: number;
  /** Owner only: brands that own it, brands using it now, open requests. */
  brands: number | null; in_use: number | null; pending: number | null;
}
export interface AddonPatch {
  displayName?: string; description?: string; billingType?: BillingType; priceCents?: number; setupFeeCents?: number;
  active?: boolean; sortOrder?: number;
}
export interface BrandAddonRow {
  category: AddonCategory; key: string; display_name: string; price_cents: number;
  is_default: boolean; entitled: boolean; active: boolean; pending: boolean;
}

export class AddonService {
  constructor(private readonly q: Querier) {}

  async catalog(actorRole: string): Promise<CatalogItem[]> {
    const r = await this.q.query("select fn_addon_catalog_list($1) as v", [actorRole]);
    return (r.rows[0]?.v ?? []) as CatalogItem[];
  }
  async setPrice(actorId: string, actorRole: string, category: string, key: string, priceCents: number): Promise<unknown> {
    const r = await this.q.query("select fn_addon_set_price($1,$2,$3,$4,$5) as v", [actorId, actorRole, category, key, priceCents]);
    return r.rows[0]?.v ?? null;
  }
  async brandView(actorId: string, actorRole: string, siteId: string): Promise<BrandAddonRow[]> {
    const r = await this.q.query("select fn_addon_brand_view($1,$2,$3) as v", [actorId, actorRole, siteId]);
    return (r.rows[0]?.v ?? []) as BrandAddonRow[];
  }
  async request(actorId: string, actorRole: string, siteId: string, category: string, key: string, note: string | null): Promise<unknown> {
    const r = await this.q.query("select fn_addon_request($1,$2,$3,$4,$5,$6) as v", [actorId, actorRole, siteId, category, key, note]);
    return r.rows[0]?.v ?? null;
  }
  async listRequests(actorId: string, actorRole: string, status: string | null): Promise<unknown[]> {
    const r = await this.q.query("select fn_addon_list_requests($1,$2,$3) as v", [actorId, actorRole, status]);
    return (r.rows[0]?.v ?? []) as unknown[];
  }
  async decideRequest(actorId: string, actorRole: string, requestId: number, decision: string, note: string | null): Promise<unknown> {
    const r = await this.q.query("select fn_addon_decide_request($1,$2,$3,$4,$5) as v", [actorId, actorRole, requestId, decision, note]);
    return r.rows[0]?.v ?? null;
  }
  async grant(actorId: string, actorRole: string, siteId: string, category: string, key: string): Promise<unknown> {
    const r = await this.q.query("select fn_addon_grant($1,$2,$3,$4,$5) as v", [actorId, actorRole, siteId, category, key]);
    return r.rows[0]?.v ?? null;
  }
  async update(actorId: string, actorRole: string, category: string, key: string, patch: AddonPatch): Promise<unknown> {
    const r = await this.q.query("select fn_addon_update($1,$2,$3,$4,$5::jsonb) as v", [actorId, actorRole, category, key, JSON.stringify(patch)]);
    return r.rows[0]?.v ?? null;
  }
  async cancelRequest(actorId: string, actorRole: string, requestId: number): Promise<unknown> {
    const r = await this.q.query("select fn_addon_cancel_request($1,$2,$3) as v", [actorId, actorRole, requestId]);
    return r.rows[0]?.v ?? null;
  }
  async activate(actorId: string, actorRole: string, siteId: string, category: string, key: string): Promise<unknown> {
    const r = await this.q.query("select fn_addon_activate($1,$2,$3,$4,$5) as v", [actorId, actorRole, siteId, category, key]);
    return r.rows[0]?.v ?? null;
  }
  async brands(actorId: string, actorRole: string): Promise<unknown[]> {
    const r = await this.q.query("select fn_addon_brands($1,$2) as v", [actorId, actorRole]);
    return (r.rows[0]?.v ?? []) as unknown[];
  }
  async revoke(actorId: string, actorRole: string, siteId: string, category: string, key: string): Promise<unknown> {
    const r = await this.q.query("select fn_addon_revoke($1,$2,$3,$4,$5) as v", [actorId, actorRole, siteId, category, key]);
    return r.rows[0]?.v ?? null;
  }
}
