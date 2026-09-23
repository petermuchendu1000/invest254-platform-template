import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * ISSUE 1 / F-46 — the API names the TOKEN's brand on every site-tier bulk action, so the database
 * never falls back to the actor's HOME brand (for an impersonator: the wrong brand, possibly on another
 * platform). The DB half (migration 0156) is proven by e2e_actor_scope_impersonation.py; this suite
 * proves the API passes exactly the right scope, by spying on the dependencies:
 *   - site-tier tokens (genuine site admin AND impersonation, both role='admin' + site=X) -> sites=[X],
 *     the template's default audience preserved, any client-sent `sites` OVERRIDDEN (not widened);
 *   - platform admins and the system owner -> passed through unchanged (their DB scope applies);
 *   - category clear -> the 4-arg brand-bounded form for site-tier tokens;
 *   - tickets are filed under the token's brand; add-ons refuse any other brand for a site-tier token.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const P1 = "10000000-0000-0000-0000-000000000001";
const IMPERSONATION_B = `pa-home-a:admin:${SITE_B}`;        // a platform admin impersonating brand B
const SITE_ADMIN_A = `sa:admin:${SITE_A}`;
const PLATFORM_ADMIN = `pa:platform_admin:${SITE_A}:${P1}`;
const OWNER = "owner:platform_superadmin";

interface Calls { audienceCount: unknown[][]; broadcast: unknown[][]; resolveCategory: unknown[][]; ticketCreate: unknown[][]; addon: unknown[][] }

async function harness(): Promise<{ api: TestApi; calls: Calls }> {
  const calls: Calls = { audienceCount: [], broadcast: [], resolveCategory: [], ticketCreate: [], addon: [] };
  const base = await startTestApi();
  const realNotif = base.deps.notifications;
  await base.close();
  const notifications = {
    ...Object.fromEntries(["create", "listActive", "adminList", "dismiss", "resolve", "resolveByCategory", "ownerOf"]
      .map((k) => [k, (realNotif as any)[k].bind(realNotif)])),
    listTemplates: async () => [{ key: "deposits_down", level: "warning", title: "t", body: "b", dismissible: true,
      category: "deposits_incident", resolvesCategory: null, defaultAudience: { status: "active", affected_within_hours: 24 }, description: null }],
    audienceCount: async (...a: unknown[]) => { calls.audienceCount.push(a); return 7; },
    broadcast: async (...a: unknown[]) => { calls.broadcast.push(a); return 3; },
    resolveCategory: async (...a: unknown[]) => { calls.resolveCategory.push(a); return 2; },
  };
  const tickets = { create: async (...a: unknown[]) => { calls.ticketCreate.push(a); return { id: "t1" }; },
    list: async () => [], get: async () => ({}), addComment: async () => ({}), setStatus: async () => ({}), escalate: async () => ({}) };
  const addons = { catalog: async () => [], brandView: async (...a: unknown[]) => { calls.addon.push(a); return []; },
    request: async (...a: unknown[]) => { calls.addon.push(a); return {}; }, listRequests: async () => [],
    decideRequest: async () => ({}), setPrice: async () => ({}), grant: async () => ({}), revoke: async () => ({}) };
  const api = await startTestApi({ depsOverrides: { notifications: notifications as any, tickets: tickets as any, addons: addons as any } });
  return { api, calls };
}

test("F-46: an impersonation session's broadcast is narrowed to ITS brand; template default kept; client sites overridden", async () => {
  const { api, calls } = await harness();
  try {
    assert.equal((await req(api, "POST", "/api/v1/admin/notifications/broadcast", IMPERSONATION_B, { templateKey: "deposits_down" })).status, 200);
    assert.deepEqual(calls.broadcast.at(-1)![3], { status: "active", affected_within_hours: 24, sites: [SITE_B] });
    // A client trying to WIDEN to another brand is overridden, other filters kept.
    await req(api, "POST", "/api/v1/admin/notifications/broadcast", IMPERSONATION_B, { templateKey: "deposits_down", audience: { sites: [SITE_A], roles: ["player"] } });
    assert.deepEqual(calls.broadcast.at(-1)![3], { sites: [SITE_B], roles: ["player"] });
    await req(api, "POST", "/api/v1/admin/notifications/audience-count", IMPERSONATION_B, { audience: { sites: [SITE_A] } });
    assert.deepEqual(calls.audienceCount.at(-1)![2], { sites: [SITE_B] });
  } finally { await api.close(); }
});

test("F-46: a genuine site admin is narrowed to its brand the same way", async () => {
  const { api, calls } = await harness();
  try {
    await req(api, "POST", "/api/v1/admin/notifications/broadcast", SITE_ADMIN_A, { templateKey: "deposits_down" });
    assert.deepEqual((calls.broadcast.at(-1)![3] as any).sites, [SITE_A]);
    await req(api, "POST", "/api/v1/admin/notifications/resolve-category", SITE_ADMIN_A, { category: "deposits_incident" });
    assert.deepEqual(calls.resolveCategory.at(-1), ["sa", "admin", "deposits_incident", SITE_A]);
  } finally { await api.close(); }
});

test("F-46: category clear from an impersonation session is bounded to the impersonated brand (4-arg form)", async () => {
  const { api, calls } = await harness();
  try {
    assert.equal((await req(api, "POST", "/api/v1/admin/notifications/resolve-category", IMPERSONATION_B, { category: "deposits_incident" })).status, 200);
    assert.deepEqual(calls.resolveCategory.at(-1), ["pa-home-a", "admin", "deposits_incident", SITE_B]);
  } finally { await api.close(); }
});

test("F-46 regression guard: platform admin and system owner semantics are unchanged (passed through)", async () => {
  const { api, calls } = await harness();
  try {
    await req(api, "POST", "/api/v1/admin/notifications/broadcast", OWNER, { templateKey: "deposits_down" });
    assert.equal(calls.broadcast.at(-1)![3], null, "owner: no narrowing (template default applies in the DB)");
    await req(api, "POST", "/api/v1/admin/notifications/broadcast", PLATFORM_ADMIN, { templateKey: "deposits_down", audience: { sites: [SITE_A] } });
    assert.deepEqual(calls.broadcast.at(-1)![3], { sites: [SITE_A] }, "platform admin: its explicit narrowing passes through");
    await req(api, "POST", "/api/v1/admin/notifications/resolve-category", OWNER, { category: "c" });
    assert.deepEqual(calls.resolveCategory.at(-1)!.slice(0, 3), ["owner", "platform_superadmin", "c"]);
    assert.equal(calls.resolveCategory.at(-1)![3], undefined, "owner: no brand narrowing");
  } finally { await api.close(); }
});

test("F-46: tickets from a site-tier token are filed under the token's brand (body brand ignored)", async () => {
  const { api, calls } = await harness();
  try {
    assert.equal((await req(api, "POST", "/api/v1/tickets", IMPERSONATION_B, { subject: "s", urgency: "low", siteId: SITE_A })).status, 201);
    assert.equal(calls.ticketCreate.at(-1)![3], SITE_B);
    await req(api, "POST", "/api/v1/tickets", PLATFORM_ADMIN, { subject: "s", urgency: "low", siteId: SITE_A });
    assert.equal(calls.ticketCreate.at(-1)![3], SITE_A, "platform admin names a brand explicitly (DB checks its platform)");
  } finally { await api.close(); }
});

test("F-46: add-ons — a site-tier token may only address its own brand", async () => {
  const { api, calls } = await harness();
  try {
    const bad = await req(api, "GET", `/api/v1/addons/brand?site=${SITE_A}`, IMPERSONATION_B);
    assert.equal(bad.status, 403);
    assert.equal((await json(bad)).error.code, "SITE_SCOPE_FORBIDDEN");
    assert.equal((await req(api, "POST", "/api/v1/addons/request", IMPERSONATION_B, { category: "chart", key: "area", site: SITE_A })).status, 403);
    assert.equal(calls.addon.length, 0, "nothing reached the add-on service");
    assert.equal((await req(api, "GET", "/api/v1/addons/brand", IMPERSONATION_B)).status, 200);
    assert.equal(calls.addon.at(-1)![2], SITE_B);
  } finally { await api.close(); }
});
