import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";

/**
 * Superadmin password gate (Issue 1): approving a real-money withdrawal from the dashboard/API requires
 * the superadmin password; a wrong/absent password is refused (403). Reject is NOT gated.
 */
const json = (r: Response) => r.json() as Promise<any>;
const ADMIN = `${TEST_ADMIN}:admin`;
const PASSWORD = "sup3r-secret";

async function harness(): Promise<TestApi> {
  return startTestApi({
    startingBalanceCents: 1_000_000,
    depsOverrides: { verifyApprovalPassword: async (pw) => pw === PASSWORD },
  });
}
async function pending(api: TestApi): Promise<string> {
  // TEST_USER is a plain player (not linked to a marketer) -> real M-Pesa pending withdrawal (202).
  const r = await fetch(`${api.baseUrl}/api/v1/withdrawals`, {
    method: "POST", headers: { authorization: `Bearer ${TEST_USER}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: 50_000, phone: "0733000111" }),
  });
  assert.equal(r.status, 202);
  return (await json(r)).transactionId as string;
}
const approve = (api: TestApi, id: string, body?: unknown) => {
  const init: RequestInit = { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${api.baseUrl}/api/v1/admin/withdrawals/${id}/approve`, init);
};

test("dashboard approve: missing password -> 403 (gate enforced when configured)", async () => {
  const api = await harness();
  try {
    const tx = await pending(api);
    assert.equal((await approve(api, tx)).status, 403);
    assert.equal((await approve(api, tx, { password: "wrong" })).status, 403);
  } finally { await api.close(); }
});

test("dashboard approve: correct password -> 200 and the withdrawal proceeds", async () => {
  const api = await harness();
  try {
    const tx = await pending(api);
    const r = await approve(api, tx, { password: PASSWORD });
    assert.equal(r.status, 200);
  } finally { await api.close(); }
});

test("dashboard reject: NOT gated by password", async () => {
  const api = await harness();
  try {
    const tx = await pending(api);
    const r = await fetch(`${api.baseUrl}/api/v1/admin/withdrawals/${tx}/reject`, {
      method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(r.status, 200);
  } finally { await api.close(); }
});
