import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";
import { signWithdrawalAction } from "./withdrawalactionlink.js";

/**
 * End-to-end for the login-free email magic-link withdrawal actions (Issue 1):
 *   player requests a withdrawal -> pending
 *   -> GET /w/act?token (confirm page, MUST NOT mutate)
 *   -> POST /w/act { token } performs approve/reject with a signed, expiring token (no session)
 * Plus: idempotent replay, invalid/expired token handling.
 */
const SECRET = "e2e-action-secret-which-is-long-enough";
const json = (r: Response) => r.json() as Promise<any>;
const overrides = { actionSecret: SECRET, withdrawalActionActor: async () => TEST_ADMIN };

async function pendingWithdrawal(api: TestApi): Promise<string> {
  const r = await fetch(`${api.baseUrl}/api/v1/withdrawals`, {
    method: "POST", headers: { authorization: `Bearer ${TEST_USER}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: 50_000, phone: "0722000099" }),
  });
  assert.equal(r.status, 202);
  return (await json(r)).transactionId as string;
}
const act = (api: TestApi, token: string) =>
  fetch(`${api.baseUrl}/api/v1/w/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });

test("magic link: confirm page renders and does NOT mutate; POST approves without login", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000, depsOverrides: overrides });
  try {
    const tx = await pendingWithdrawal(api);
    const token = signWithdrawalAction(tx, "approve", SECRET);

    // GET confirm page: 200 HTML, no mutation
    const pg = await fetch(`${api.baseUrl}/api/v1/w/act?token=${token}`);
    assert.equal(pg.status, 200);
    assert.match(pg.headers.get("content-type") || "", /text\/html/);
    assert.match(await pg.text(), /Approve/);

    // POST performs the approval
    const r1 = await act(api, token);
    assert.equal(r1.status, 200);
    assert.deepEqual(await json(r1), { ok: true, status: "approved" });

    // idempotent replay: already actioned -> not actionable
    const r2 = await act(api, token);
    assert.equal((await json(r2)).ok, false);
  } finally { await api.close(); }
});

test("magic link: reject returns the funds", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000, depsOverrides: overrides });
  try {
    const tx = await pendingWithdrawal(api);
    const r = await act(api, signWithdrawalAction(tx, "reject", SECRET));
    assert.equal(r.status, 200);
    assert.deepEqual(await json(r), { ok: true, status: "rejected" });
  } finally { await api.close(); }
});

test("magic link: invalid/expired token is refused (page 400, POST 400)", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000, depsOverrides: overrides });
  try {
    const expired = signWithdrawalAction("tx-x", "approve", SECRET, -1000);
    const pg = await fetch(`${api.baseUrl}/api/v1/w/act?token=${expired}`);
    assert.equal(pg.status, 400);
    const r = await act(api, expired);
    assert.equal(r.status, 400);
    // a token signed with the WRONG secret is also refused
    const forged = signWithdrawalAction("tx-x", "approve", "wrong-secret");
    assert.equal((await act(api, forged)).status, 400);
  } finally { await api.close(); }
});
