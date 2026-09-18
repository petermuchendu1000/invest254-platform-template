import type { Querier } from "./wallet.js";

/**
 * Subscription plans + per-platform subscriptions (Issue 2). All mutations go through the SECURITY
 * DEFINER fn_subscription_* RPCs (0136–0138), which gate on platform_superadmin and enforce the
 * plan quotas + hard-suspend via triggers. This is a thin, typed transport over those RPCs plus the
 * leak-safe read helpers used by the console.
 */
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const iso = (v: unknown): string | null => (v == null ? null : String(v));

export interface SubscriptionPlan {
  key: string; name: string; maxSites: number | null; maxUsers: number | null;
  priceCents: number | null; currency: string; billingPeriod: string; isCustom: boolean; sort: number;
}
export interface PlatformSubscription {
  platformId: string; planKey: string; status: string;
  trialEndsAt: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; graceEndsAt: string | null;
  customPriceCents: number | null; customMaxSites: number | null; customMaxUsers: number | null;
  lastPaymentAt: string | null; notes: string | null;
}
export interface PlatformUsage {
  planKey: string; status: string; sites: number; users: number;
  maxSites: number | null; maxUsers: number | null;
  trialEndsAt: string | null; currentPeriodEnd: string | null; graceEndsAt: string | null;
}
export interface SubscriptionEvent {
  id: number; platformId: string; fromStatus: string | null; toStatus: string | null; planKey: string | null;
  reason: string; amountCents: number | null; actorId: string | null; actorRole: string | null; createdAtMs: number;
}

function mapPlan(x: Record<string, unknown>): SubscriptionPlan {
  return { key: String(x.key), name: String(x.name),
    maxSites: x.max_sites == null ? null : num(x.max_sites), maxUsers: x.max_users == null ? null : num(x.max_users),
    priceCents: x.price_cents == null ? null : num(x.price_cents), currency: String(x.currency),
    billingPeriod: String(x.billing_period), isCustom: Boolean(x.is_custom), sort: num(x.sort) };
}
function mapSub(x: Record<string, unknown>): PlatformSubscription {
  return { platformId: String(x.platform_id), planKey: String(x.plan_key), status: String(x.status),
    trialEndsAt: iso(x.trial_ends_at), currentPeriodStart: iso(x.current_period_start),
    currentPeriodEnd: iso(x.current_period_end), graceEndsAt: iso(x.grace_ends_at),
    customPriceCents: x.custom_price_cents == null ? null : num(x.custom_price_cents),
    customMaxSites: x.custom_max_sites == null ? null : num(x.custom_max_sites),
    customMaxUsers: x.custom_max_users == null ? null : num(x.custom_max_users),
    lastPaymentAt: iso(x.last_payment_at), notes: x.notes == null ? null : String(x.notes) };
}

export interface SubscriptionRepository {
  listPlans(): Promise<SubscriptionPlan[]>;
  getSubscription(platformId: string): Promise<PlatformSubscription | null>;
  usage(platformId: string): Promise<PlatformUsage | null>;
  listEvents(platformId: string, limit: number): Promise<SubscriptionEvent[]>;
  setPlan(actorId: string, actorRole: string, platformId: string, planKey: string, customPrice: number | null, customSites: number | null, customUsers: number | null): Promise<PlatformSubscription>;
  setStatus(actorId: string, actorRole: string, platformId: string, status: string, reason: string | null): Promise<PlatformSubscription>;
  recordPayment(actorId: string, actorRole: string, platformId: string, amountCents: number, periodDays: number | null): Promise<PlatformSubscription>;
  autoAdvance(): Promise<number>;
}

export class PgSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly q: Querier) {}
  async listPlans(): Promise<SubscriptionPlan[]> {
    const r = await this.q.query("select * from subscription_plans where active order by sort", []);
    return r.rows.map((x: Record<string, unknown>) => mapPlan(x));
  }
  async getSubscription(platformId: string): Promise<PlatformSubscription | null> {
    const r = await this.q.query("select * from platform_subscriptions where platform_id=$1", [platformId]);
    return r.rows.length ? mapSub(r.rows[0] as Record<string, unknown>) : null;
  }
  async usage(platformId: string): Promise<PlatformUsage | null> {
    const r = await this.q.query("select * from fn_platform_usage($1)", [platformId]);
    if (!r.rows.length) return null;
    const x = r.rows[0] as Record<string, unknown>;
    return { planKey: String(x.plan_key), status: String(x.status), sites: num(x.sites), users: num(x.users),
      maxSites: x.max_sites == null ? null : num(x.max_sites), maxUsers: x.max_users == null ? null : num(x.max_users),
      trialEndsAt: iso(x.trial_ends_at), currentPeriodEnd: iso(x.current_period_end), graceEndsAt: iso(x.grace_ends_at) };
  }
  async listEvents(platformId: string, limit: number): Promise<SubscriptionEvent[]> {
    const r = await this.q.query(
      "select * from subscription_events where platform_id=$1 order by created_at desc limit $2", [platformId, limit]);
    return r.rows.map((x: Record<string, unknown>) => ({
      id: num(x.id), platformId: String(x.platform_id), fromStatus: x.from_status == null ? null : String(x.from_status),
      toStatus: x.to_status == null ? null : String(x.to_status), planKey: x.plan_key == null ? null : String(x.plan_key),
      reason: String(x.reason), amountCents: x.amount_cents == null ? null : num(x.amount_cents),
      actorId: x.actor_id == null ? null : String(x.actor_id), actorRole: x.actor_role == null ? null : String(x.actor_role),
      createdAtMs: new Date(String(x.created_at)).getTime() }));
  }
  async setPlan(a: string, r: string, p: string, plan: string, cp: number | null, cs: number | null, cu: number | null): Promise<PlatformSubscription> {
    const res = await this.q.query("select * from fn_subscription_set_plan($1,$2,$3,$4,$5,$6,$7)", [a, r, p, plan, cp, cs, cu]);
    return mapSub(res.rows[0] as Record<string, unknown>);
  }
  async setStatus(a: string, r: string, p: string, status: string, reason: string | null): Promise<PlatformSubscription> {
    const res = await this.q.query("select * from fn_subscription_set_status($1,$2,$3,$4,$5)", [a, r, p, status, reason]);
    return mapSub(res.rows[0] as Record<string, unknown>);
  }
  async recordPayment(a: string, r: string, p: string, amt: number, days: number | null): Promise<PlatformSubscription> {
    const res = await this.q.query("select * from fn_subscription_record_payment($1,$2,$3,$4,$5)", [a, r, p, amt, days]);
    return mapSub(res.rows[0] as Record<string, unknown>);
  }
  async autoAdvance(): Promise<number> {
    const res = await this.q.query("select fn_subscription_auto_advance() as n", []);
    return num(res.rows[0].n);
  }
}

/** Minimal in-memory subscription store for API tests (logic is proven against Postgres in the
 *  DB e2e). Enforces only the system-role gate + plan catalog; time/quotas live in the DB. */
export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly subs = new Map<string, PlatformSubscription>();
  private readonly plans: SubscriptionPlan[] = [
    { key: "starter", name: "Starter", maxSites: 1, maxUsers: 100, priceCents: 100000, currency: "KES", billingPeriod: "month", isCustom: false, sort: 1 },
    { key: "business", name: "Business", maxSites: 5, maxUsers: 1000, priceCents: 4000000, currency: "KES", billingPeriod: "month", isCustom: false, sort: 2 },
    { key: "enterprise", name: "Enterprise", maxSites: null, maxUsers: null, priceCents: null, currency: "KES", billingPeriod: "month", isCustom: true, sort: 3 },
  ];
  private gate(role: string) { if (role !== "platform_superadmin") throw new Error("NOT_AUTHORIZED"); }
  private ensure(p: string): PlatformSubscription {
    let s = this.subs.get(p);
    if (!s) { s = { platformId: p, planKey: "starter", status: "trial", trialEndsAt: null, currentPeriodStart: null, currentPeriodEnd: null, graceEndsAt: null, customPriceCents: null, customMaxSites: null, customMaxUsers: null, lastPaymentAt: null, notes: null }; this.subs.set(p, s); }
    return s;
  }
  async listPlans() { return this.plans.map((p) => ({ ...p })); }
  async getSubscription(p: string) { return this.subs.has(p) ? { ...this.subs.get(p)! } : null; }
  async usage(p: string) { const s = this.ensure(p); const pl = this.plans.find((x) => x.key === s.planKey)!; return { planKey: s.planKey, status: s.status, sites: 0, users: 0, maxSites: s.customMaxSites ?? pl.maxSites, maxUsers: s.customMaxUsers ?? pl.maxUsers, trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd, graceEndsAt: s.graceEndsAt }; }
  async listEvents() { return []; }
  async setPlan(_a: string, role: string, p: string, plan: string, cp: number | null, cs: number | null, cu: number | null) { this.gate(role); const s = this.ensure(p); s.planKey = plan; s.customPriceCents = cp; s.customMaxSites = cs; s.customMaxUsers = cu; return { ...s }; }
  async setStatus(_a: string, role: string, p: string, status: string, _r: string | null) { this.gate(role); const s = this.ensure(p); s.status = status; return { ...s }; }
  async recordPayment(_a: string, role: string, p: string, _amt: number, _d: number | null) { this.gate(role); const s = this.ensure(p); s.status = "active"; s.lastPaymentAt = new Date().toISOString(); return { ...s }; }
  async autoAdvance() { return 0; }
}

export class SubscriptionService {
  constructor(private readonly repo: SubscriptionRepository) {}
  listPlans() { return this.repo.listPlans(); }
  getSubscription(platformId: string) { return this.repo.getSubscription(platformId); }
  usage(platformId: string) { return this.repo.usage(platformId); }
  listEvents(platformId: string, limit = 50) { return this.repo.listEvents(platformId, Math.min(200, Math.max(1, limit))); }
  setPlan(actorId: string, actorRole: string, platformId: string, planKey: string, customPrice: number | null = null, customSites: number | null = null, customUsers: number | null = null) {
    if (!planKey) throw new Error("INVALID_PLAN");
    return this.repo.setPlan(actorId, actorRole, platformId, planKey, customPrice, customSites, customUsers);
  }
  setStatus(actorId: string, actorRole: string, platformId: string, status: string, reason: string | null = null) {
    if (!["trial", "active", "past_due", "grace_period", "suspended", "cancelled"].includes(status)) throw new Error("INVALID_STATUS");
    return this.repo.setStatus(actorId, actorRole, platformId, status, reason);
  }
  recordPayment(actorId: string, actorRole: string, platformId: string, amountCents: number, periodDays: number | null = null) {
    if (!Number.isFinite(amountCents) || amountCents < 0) throw new Error("INVALID_AMOUNT");
    return this.repo.recordPayment(actorId, actorRole, platformId, Math.round(amountCents), periodDays);
  }
  autoAdvance() { return this.repo.autoAdvance(); }
}
