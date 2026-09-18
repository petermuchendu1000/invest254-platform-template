import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, TEST_USER, SITE_A, type TestApi } from "./testutil.js";

/**
 * Tickets + Subscriptions API (Issue 2): auth gating, scope, and routing over the real HTTP app.
 * Deep lifecycle/quota logic is proven against Postgres in e2e_subscriptions_tickets.py; here we
 * assert the transport + guards. Token scheme (stub verifier): `<userId>:<role>:<site>:<platform>`.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, m: string, p: string, token?: string, body?: unknown): Promise<Response> {
  const h: Record<string, string> = {}; if (token) h["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method: m, headers: h };
  if (body !== undefined) { h["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${p}`, init);
}
const DP = "10000000-0000-0000-0000-000000000001";           // default platform
const OTHER = "20000000-0000-0000-0000-000000000002";
const SYSTEM = `${TEST_ADMIN}:platform_superadmin`;
const PLAYER = TEST_USER;

test("tickets API: create, scope, comment, escalate", async () => {
  const api = await startTestApi();
  try {
    const SA = `siteadmin1:admin:${SITE_A}`;
    const PA_same = `pasame:platform_admin:${SITE_A}:${DP}`;
    const PA_other = `paother:platform_admin:${SITE_A}:${OTHER}`;
    api.ticketRepo.setActorPlatform("pasame", DP);
    api.ticketRepo.setActorPlatform("paother", OTHER);

    // player cannot raise a ticket
    assert.equal((await req(api, "POST", "/api/v1/tickets", PLAYER, { subject: "x", urgency: "low" })).status, 403);
    // site admin raises -> 201, level 0 (platform admin)
    const cr = await req(api, "POST", "/api/v1/tickets", SA, { subject: "Payouts stuck", body: "B2C failing", urgency: "high" });
    assert.equal(cr.status, 201);
    const tk = await json(cr); assert.equal(tk.escalationLevel, 0); assert.equal(tk.assigneeRole, "platform_admin");

    // another platform's admin cannot read it; the owning platform admin can
    assert.equal((await req(api, "GET", `/api/v1/tickets/${tk.id}`, PA_other)).status, 403);
    assert.equal((await req(api, "GET", `/api/v1/tickets/${tk.id}`, PA_same)).status, 200);
    // owning platform admin comments + escalates
    assert.equal((await req(api, "POST", `/api/v1/tickets/${tk.id}/comments`, PA_same, { body: "on it" })).status, 201);
    const esc = await req(api, "POST", `/api/v1/tickets/${tk.id}/escalate`, PA_same, { note: "need system" });
    assert.equal(esc.status, 200); assert.equal((await json(esc)).ticket.escalationLevel, 1);
    // site admin sees their own ticket in the list
    const list = await json(await req(api, "GET", "/api/v1/tickets", SA));
    assert.ok(list.tickets.some((x: any) => x.id === tk.id));
    // platform-admin-issued ticket starts at level 1 (System)
    const pcr = await json(await req(api, "POST", "/api/v1/tickets", PA_same, { subject: "infra", urgency: "critical" }));
    assert.equal(pcr.escalationLevel, 1); assert.equal(pcr.assigneeRole, "platform_superadmin");
  } finally { await api.close(); }
});

test("subscriptions API: plan catalog, system-only mutations, platform-scoped reads", async () => {
  const api = await startTestApi();
  try {
    const PA = `pa9:platform_admin:${SITE_A}:${DP}`;
    // plan catalog: platform admin + system yes; player no
    assert.equal((await req(api, "GET", "/api/v1/platform/subscription-plans", PLAYER)).status, 403);
    const plans = await json(await req(api, "GET", "/api/v1/platform/subscription-plans", SYSTEM));
    assert.equal(plans.plans.length, 3);
    assert.ok(plans.plans.find((p: any) => p.key === "enterprise" && p.maxSites === null));
    // mutation is system-only
    assert.equal((await req(api, "POST", `/api/v1/platform/subscriptions/${DP}/status`, PA, { status: "active" })).status, 403);
    assert.equal((await req(api, "POST", `/api/v1/platform/subscriptions/${DP}/status`, SYSTEM, { status: "active" })).status, 200);
    assert.equal((await req(api, "POST", `/api/v1/platform/subscriptions/${DP}/payment`, SYSTEM, { amountCents: 100000 })).status, 200);
    // platform-scoped read: PA sees own platform, not another
    assert.equal((await req(api, "GET", `/api/v1/platform/subscriptions/${DP}`, PA)).status, 200);
    assert.equal((await req(api, "GET", `/api/v1/platform/subscriptions/${OTHER}`, PA)).status, 403);
    // system sees any
    assert.equal((await req(api, "GET", `/api/v1/platform/subscriptions/${OTHER}`, SYSTEM)).status, 200);
  } finally { await api.close(); }
});
