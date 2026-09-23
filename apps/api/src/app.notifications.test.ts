import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
/** A real, registered brand-A player (F-44: admin notification routes scope-check a REAL target). */
async function player(api: TestApi, phone = "0712300001"): Promise<string> {
  const r = await req(api, "POST", "/api/v1/auth/register", { body: { phone, username: `p${phone.slice(-4)}`, password: "Password1", site: "invest254" } });
  assert.equal(r.status, 201);
  return (await json(r)).userId as string;
}

test("admin raises a notification; the player reads it and dismisses it", async () => {
  const api = await startTestApi();
  try {
    const U = await player(api);
    // admin creates a dismissible bonus notice for the test player
    const created = await req(api, "POST", `/api/v1/admin/users/${U}/notifications`,
      { token: "admin-1:admin:00000000-0000-0000-0000-000000000001", body: { level: "success", title: "Bonus added", body: "KES 500 bonus added", category: "bonus" } });
    assert.equal(created.status, 201);
    const c = await json(created);
    assert.equal(c.dismissible, true);

    // a player token cannot create notifications (admin-gated)
    assert.equal((await req(api, "POST", `/api/v1/admin/users/${U}/notifications`, { token: U, body: { title: "x" } })).status, 403);

    // player sees exactly their active notification
    const list = await json(await req(api, "GET", "/api/v1/notifications", { token: U }));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].title, "Bonus added");

    // player dismisses it -> gone
    const dis = await req(api, "POST", `/api/v1/notifications/${c.id}/dismiss`, { token: U });
    assert.equal(dis.status, 200);
    assert.equal((await json(await req(api, "GET", "/api/v1/notifications", { token: U }))).items.length, 0);

    // audit trail captured the admin action
    // F-44: the audit trail is System-owner-only (a site admin is refused).
    assert.equal((await req(api, "GET", "/api/v1/admin/audit", { token: "admin-1:admin:00000000-0000-0000-0000-000000000001" })).status, 403);
    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: "owner:platform_superadmin" }));
    assert.ok(audit.items.some((a: any) => a.action === "notification.create"));
  } finally { await api.close(); }
});

test("a blocking notification cannot be dismissed by the player; admin resolve clears it", async () => {
  const api = await startTestApi();
  try {
    const U = await player(api);
    const created = await json(await req(api, "POST", `/api/v1/admin/users/${U}/notifications`,
      { token: "admin-1:admin:00000000-0000-0000-0000-000000000001", body: { level: "error", title: "Account suspended", dismissible: false, category: "account_limited" } }));
    assert.equal(created.dismissible, false);

    // player cannot dismiss a blocking notice
    assert.equal((await req(api, "POST", `/api/v1/notifications/${created.id}/dismiss`, { token: U })).status, 409);
    assert.equal((await json(await req(api, "GET", "/api/v1/notifications", { token: U }))).items.length, 1);

    // admin resolves it -> gone
    assert.equal((await req(api, "POST", `/api/v1/admin/notifications/${created.id}/resolve`, { token: "admin-1:admin:00000000-0000-0000-0000-000000000001" })).status, 200);
    assert.equal((await json(await req(api, "GET", "/api/v1/notifications", { token: U }))).items.length, 0);
  } finally { await api.close(); }
});

test("suspending a user raises a blocking notice; reactivating clears it", async () => {
  const api = await startTestApi();
  try {
    // Register a real user so admin.setUserStatus has an identity to act on.
    const reg = await fetch(`${api.baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "0712009090", username: "susp_target", password: "Password1" }),
    });
    assert.equal(reg.status, 201);
    const uid = (await json(reg)).userId as string;

    const sus = await req(api, "POST", `/api/v1/admin/users/${uid}/suspend`, { token: "admin-1:admin:00000000-0000-0000-0000-000000000001", body: { reason: "review" } });
    assert.equal(sus.status, 200);
    let items = (await json(await req(api, "GET", "/api/v1/notifications", { token: uid }))).items;
    const block = items.find((n: any) => n.category === "account_limited");
    assert.ok(block, "suspension raised a blocking notice");
    assert.equal(block.dismissible, false);

    await req(api, "POST", `/api/v1/admin/users/${uid}/reactivate`, { token: "admin-1:admin:00000000-0000-0000-0000-000000000001" });
    items = (await json(await req(api, "GET", "/api/v1/notifications", { token: uid }))).items;
    assert.equal(items.some((n: any) => n.category === "account_limited"), false, "reactivate cleared the block");
    assert.ok(items.some((n: any) => n.category === "account_reactivated"), "welcome-back notice shown");
  } finally { await api.close(); }
});

test("notifications require auth", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/notifications")).status, 401);
    assert.equal((await req(api, "POST", "/api/v1/notifications/1/dismiss")).status, 401);
  } finally { await api.close(); }
});

// ── Broadcast centre endpoints (migration 0106) ─────────────────────────────────────────────────
test("broadcast: templates list + audience-count + broadcast + resolve-category are admin-gated and validated", async () => {
  const api = await startTestApi();
  try {
    // template library (InMemory returns [] — we assert shape + 200, RPC logic is e2e-tested on DB)
    const tpl = await req(api, "GET", "/api/v1/admin/notification-templates", { token: "admin-1:admin:00000000-0000-0000-0000-000000000001" });
    assert.equal(tpl.status, 200);
    assert.ok(Array.isArray((await json(tpl)).items));

    // audience-count returns a numeric count
    const cnt = await json(await req(api, "POST", "/api/v1/admin/notifications/audience-count",
      { token: "admin-1:admin:00000000-0000-0000-0000-000000000001", body: { audience: { affected_within_hours: 24 } } }));
    assert.equal(typeof cnt.count, "number");

    // broadcast requires a templateKey
    assert.equal((await req(api, "POST", "/api/v1/admin/notifications/broadcast",
      { token: "admin-1:admin:00000000-0000-0000-0000-000000000001", body: {} })).status, 400);
    // broadcast with a key returns a recipients count
    const b = await req(api, "POST", "/api/v1/admin/notifications/broadcast",
      { token: "admin-1:admin:00000000-0000-0000-0000-000000000001", body: { templateKey: "deposits_down", audience: {} } });
    assert.equal(b.status, 200);
    assert.equal(typeof (await json(b)).recipients, "number");

    // resolve-category requires a category
    assert.equal((await req(api, "POST", "/api/v1/admin/notifications/resolve-category",
      { token: "admin-1:admin:00000000-0000-0000-0000-000000000001", body: {} })).status, 400);
    const r = await req(api, "POST", "/api/v1/admin/notifications/resolve-category",
      { token: "admin-1:admin:00000000-0000-0000-0000-000000000001", body: { category: "deposits_incident" } });
    assert.equal(r.status, 200);
    assert.equal(typeof (await json(r)).cleared, "number");
  } finally {
    await api.close();
  }
});

test("broadcast: a non-admin token is forbidden on every broadcast route", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/admin/notification-templates", { token: "u-test" })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/admin/notifications/broadcast", { token: "u-test", body: { templateKey: "x" } })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/admin/notifications/resolve-category", { token: "u-test", body: { category: "x" } })).status, 403);
  } finally {
    await api.close();
  }
});
