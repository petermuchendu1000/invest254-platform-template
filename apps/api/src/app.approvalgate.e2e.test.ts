import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, SITE_B, type TestApi } from "./testutil.js";

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
const markPaid = (api: TestApi, id: string, body?: unknown, token: string = ADMIN) => {
  const init: RequestInit = { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${api.baseUrl}/api/v1/admin/withdrawals/${id}/mark-paid`, init);
};
/** Approve a pending withdrawal so it sits in 'processing' (the stub Daraja never calls back). */
async function processing(api: TestApi): Promise<string> {
  const tx = await pending(api);
  assert.equal((await approve(api, tx, { password: PASSWORD })).status, 200);
  return tx;
}

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

// ── Manual mark-paid (BUGLOG #32): finalize a stuck processing withdrawal when the B2C callback never came ──
test("mark-paid: password-gated like approve (missing/wrong -> 403)", async () => {
  const api = await harness();
  try {
    const tx = await processing(api);
    assert.equal((await markPaid(api, tx)).status, 403);
    assert.equal((await markPaid(api, tx, { password: "wrong" })).status, 403);
    // Still processing (nothing changed).
    const ok = await markPaid(api, tx, { password: PASSWORD });
    assert.equal(ok.status, 200);
  } finally { await api.close(); }
});

test("mark-paid: processing -> success (paid), idempotent on re-click", async () => {
  const api = await harness();
  try {
    const tx = await processing(api);
    const r = await markPaid(api, tx, { password: PASSWORD, receipt: "QGH7XYZ12" });
    assert.equal(r.status, 200);
    const b = await json(r);
    assert.equal(b.applied, true);
    assert.equal(b.status, "success", "withdrawal now reflects as paid to the client");
    // Idempotent: a second mark-paid is a safe no-op, still success.
    const b2 = await json(await markPaid(api, tx, { password: PASSWORD }));
    assert.equal(b2.applied, false);
    assert.equal(b2.status, "success");
  } finally { await api.close(); }
});

test("mark-paid: brand-scoped — a brand-B admin cannot finalize a brand-A withdrawal", async () => {
  const api = await harness();
  try {
    const tx = await processing(api);                              // brand-A (default) withdrawal
    const r = await markPaid(api, tx, { password: PASSWORD }, `${TEST_ADMIN}:admin:${SITE_B}`);
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error.code, "SITE_SCOPE_FORBIDDEN");
  } finally { await api.close(); }
});

test("mark-paid: a REVERSED withdrawal is refused (no double-pay)", async () => {
  const api = await harness();
  try {
    const tx = await pending(api);
    // Reject -> reversed (wallet re-credited).
    assert.equal((await fetch(`${api.baseUrl}/api/v1/admin/withdrawals/${tx}/reject`, {
      method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{}",
    })).status, 200);
    const r = await markPaid(api, tx, { password: PASSWORD });
    assert.equal(r.status, 409);
    assert.equal((await json(r)).error.code, "WITHDRAWAL_ALREADY_REVERSED");
  } finally { await api.close(); }
});
