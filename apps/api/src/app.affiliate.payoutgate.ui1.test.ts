import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

/**
 * docs/42 UI-1 — affiliate payout approval dispatches REAL M-Pesa B2C, so it takes the system owner
 * password exactly like withdrawals and commission payouts (every real-money rail, one rule). Before
 * the fix a site-admin session alone could send affiliate money. Reject stays ungated (it only releases
 * the reservation back to the affiliate).
 */
const PASSWORD = "0wner-approval-pw";
const ADMIN = "admin-9:admin:00000000-0000-0000-0000-000000000001";
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
async function requestedPayout(api: TestApi, n: number): Promise<string> {
  const reg = async (phone: string, username: string, body: Record<string, unknown> = {}) => {
    const r = await req(api, "POST", "/api/v1/auth/register", { body: { phone, username, password: "Password1", ...body } });
    assert.equal(r.status, 201); return (await json(r)).userId as string;
  };
  const affId = await reg(`07123450${n}0`, `mkt${n}`);
  const code: string = (await json(await req(api, "POST", "/api/v1/affiliate/enroll", { token: affId }))).referralCode;
  const refId = await reg(`07223330${n}0`, `ref${n}`, { referral_code: code });
  api.identity.recordSettledPlay(refId, "2026-06-10", 10000, 2500);
  await req(api, "POST", "/api/v1/admin/affiliate/accrue", { token: `${affId}:admin:00000000-0000-0000-0000-000000000001`, body: { date: "2026-06-10" } });
  const payout = await json(await req(api, "POST", "/api/v1/affiliate/payouts", { token: `${affId}:marketer` }));
  assert.ok(payout.payoutId, "payout requested");
  return payout.payoutId as string;
}
const harness = () => startTestApi({ depsOverrides: { verifyApprovalPassword: async (pw: string) => pw === PASSWORD } });

test("UI-1: affiliate payout approve requires the system owner password (missing/wrong -> 403, nothing dispatched)", async () => {
  const api = await harness();
  try {
    const id = await requestedPayout(api, 1);
    for (const body of [undefined, {}, { password: "wrong" }]) {
      const r = await req(api, "POST", `/api/v1/admin/affiliate/payouts/${id}/approve`, { token: ADMIN, ...(body !== undefined ? { body } : {}) });
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.equal((await json(r)).error.code, "PASSWORD_REQUIRED");
    }
    const queue = await json(await req(api, "GET", "/api/v1/admin/affiliate/payouts?status=requested", { token: ADMIN }));
    assert.ok(queue.items.some((p: any) => p.payoutId === id), "still requested — no B2C was dispatched");
    const ok = await req(api, "POST", `/api/v1/admin/affiliate/payouts/${id}/approve`, { token: ADMIN, body: { password: PASSWORD } });
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).approved, true);
  } finally { await api.close(); }
});

test("UI-1: bulk approve requires the password once per batch; bulk reject does not", async () => {
  const api = await harness();
  try {
    const a = await requestedPayout(api, 2), b = await requestedPayout(api, 3);
    const bad = await req(api, "POST", "/api/v1/admin/affiliate/payouts/bulk", { token: ADMIN, body: { action: "approve", payoutIds: [a, b] } });
    assert.equal(bad.status, 403);
    const good = await json(await req(api, "POST", "/api/v1/admin/affiliate/payouts/bulk", { token: ADMIN, body: { action: "approve", payoutIds: [a], password: PASSWORD } }));
    assert.equal(good.okCount, 1);
    const rej = await req(api, "POST", "/api/v1/admin/affiliate/payouts/bulk", { token: ADMIN, body: { action: "reject", payoutIds: [b] } });
    assert.equal(rej.status, 200, "reject is not gated");
  } finally { await api.close(); }
});

test("UI-1: single reject stays ungated (it only releases the reservation)", async () => {
  const api = await harness();
  try {
    const id = await requestedPayout(api, 4);
    assert.equal((await req(api, "POST", `/api/v1/admin/affiliate/payouts/${id}/reject`, { token: ADMIN, body: {} })).status, 200);
  } finally { await api.close(); }
});
