import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return fetch(`${api.baseUrl}${path}`, init);
}

async function register(api: TestApi, phone: string, username: string): Promise<string> {
  const res = await req(api, "POST", "/api/v1/auth/register", { body: { phone, username, password: "Password1" } });
  assert.equal(res.status, 201, `register ${username} -> ${res.status}`);
  return (await json(res)).userId as string;
}

test("marketer advances (0122): request -> admin approve logs an 'advance' expense + notifies the marketer; full lifecycle + guards", async () => {
  const api = await startTestApi();
  try {
    const uid = await register(api, "0712500001", "advmkt");
    const mk = `${uid}:marketer`;

    // ── Request ────────────────────────────────────────────────────────────────────────────────
    const r1 = await req(api, "POST", "/api/v1/affiliate/advances", { token: mk, body: { amountCents: 30_000, reason: "Airtime for TikTok push" } });
    assert.equal(r1.status, 200);
    const adv = await json(r1);
    assert.equal(adv.status, "requested");
    assert.equal(adv.amountCents, 30_000);
    assert.equal(adv.reason, "Airtime for TikTok push");

    // One open request at a time (409) + amount validation (400).
    assert.equal((await req(api, "POST", "/api/v1/affiliate/advances", { token: mk, body: { amountCents: 5_000 } })).status, 409);
    assert.equal((await req(api, "POST", "/api/v1/affiliate/advances", { token: mk, body: { amountCents: 0 } })).status, 400);

    // The marketer sees their own request; the admin queue lists it.
    const mine = await json(await req(api, "GET", "/api/v1/affiliate/advances", { token: mk }));
    assert.equal(mine.items.length, 1);
    const queue = await json(await req(api, "GET", "/api/v1/admin/affiliate/advances?status=requested", { token: "admin-1:admin" }));
    assert.ok(queue.items.some((x: any) => x.id === adv.id), "admin queue shows the pending request");

    // A marketer token cannot decide (admin-gated).
    assert.equal((await req(api, "POST", `/api/v1/admin/affiliate/advances/${adv.id}/approve`, { token: mk })).status, 403);

    // ── Approve -> status approved, an 'advance' expense is logged (nets withdrawable), marketer notified ─
    const appr = await req(api, "POST", `/api/v1/admin/affiliate/advances/${adv.id}/approve`, { token: "admin-1:admin", body: { note: "Recover from November commission" } });
    assert.equal(appr.status, 200);
    assert.equal((await json(appr)).status, "approved");

    const exp = await json(await req(api, "GET", "/api/v1/affiliate/expenses", { token: mk }));
    assert.equal(exp.totalCents, 30_000, "approved advance is logged as an expense (reduces withdrawable)");
    assert.ok(exp.items.some((e: any) => e.category === "advance" && e.amountCents === 30_000));

    // The system communicated the outcome to the marketer (in-app notification).
    const notifs = await json(await req(api, "GET", "/api/v1/notifications", { token: mk }));
    assert.ok(notifs.items.some((n: any) => n.category === "advance" && /approved/i.test(n.title)), "marketer notified of approval");

    // Re-deciding a settled request is rejected (409).
    assert.equal((await req(api, "POST", `/api/v1/admin/affiliate/advances/${adv.id}/approve`, { token: "admin-1:admin" })).status, 409);

    // ── Reject a fresh request -> no expense logged; marketer notified with the reason ───────────
    const r2 = await json(await req(api, "POST", "/api/v1/affiliate/advances", { token: mk, body: { amountCents: 12_000 } }));
    const rej = await req(api, "POST", `/api/v1/admin/affiliate/advances/${r2.id}/reject`, { token: "admin-1:admin", body: { note: "Not this month" } });
    assert.equal(rej.status, 200);
    assert.equal((await json(rej)).status, "rejected");
    assert.equal((await json(await req(api, "GET", "/api/v1/affiliate/expenses", { token: mk }))).totalCents, 30_000, "reject logs no expense");
    const notifs2 = await json(await req(api, "GET", "/api/v1/notifications", { token: mk }));
    assert.ok(notifs2.items.some((n: any) => n.category === "advance" && /declined/i.test(n.title)), "marketer notified of decline");

    // ── Marketer cancels their own pending request ──────────────────────────────────────────────
    const r3 = await json(await req(api, "POST", "/api/v1/affiliate/advances", { token: mk, body: { amountCents: 4_000 } }));
    const can = await req(api, "POST", `/api/v1/affiliate/advances/${r3.id}/cancel`, { token: mk });
    assert.equal(can.status, 200);
    assert.equal((await json(can)).status, "cancelled");
  } finally { await api.close(); }
});
