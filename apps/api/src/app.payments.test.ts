import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, SITE_B, type TestApi } from "./testutil.js";

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

const PLAYER = TEST_USER;                       // role defaults to "player"
const ADMIN = `${TEST_ADMIN}:admin`;

// ─────────────────────────── wallet ───────────────────────────

test("GET /wallet → 401 without auth", async () => {
  const api = await startTestApi();
  try {
    const res = await fetch(`${api.baseUrl}/api/v1/wallet`);
    assert.equal(res.status, 401);
    assert.equal((await json(res)).error.code, "AUTH_REQUIRED");
  } finally { await api.close(); }
});

test("GET /wallet → real+bonus+currency for the authenticated player", async () => {
  const api = await startTestApi({ startingBalanceCents: 750_000 });
  try {
    const res = await req(api, "GET", "/api/v1/wallet", { token: PLAYER });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body, { real: 750_000, bonus: 0, currency: "KES" });
  } finally { await api.close(); }
});


// ─────────────────────────── deposit flow ───────────────────────────

test("deposit: POST /deposits → 202, STK callback credits the wallet", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    const dep = await req(api, "POST", "/api/v1/deposits", { token: PLAYER, body: { amount: 50_000, phone: "0712345678" } });
    assert.equal(dep.status, 202);
    const { transactionId, checkoutRequestId } = await json(dep);
    assert.ok(transactionId && checkoutRequestId);

    // Simulate Daraja STK success callback (public route, no auth).
    const cb = await req(api, "POST", "/api/v1/deposits/mpesa/callback", {
      body: { Body: { stkCallback: {
        CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: { Item: [{ Name: "Amount", Value: 500 }, { Name: "MpesaReceiptNumber", Value: "QABC123XYZ" }] },
      } } },
    });
    assert.equal(cb.status, 200);
    assert.deepEqual(await json(cb), { ResultCode: 0, ResultDesc: "Accepted" });

    const wallet = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(wallet.real, 150_000); // 100k + 50k credited
  } finally { await api.close(); }
});

test("deposit: invalid amount → 400; below-min → 400", async () => {
  const api = await startTestApi();
  try {
    const bad = await req(api, "POST", "/api/v1/deposits", { token: PLAYER, body: { amount: -5, phone: "0712345678" } });
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error.code, "VALIDATION");

    const below = await req(api, "POST", "/api/v1/deposits", { token: PLAYER, body: { amount: 5_000, phone: "0712345678" } });
    assert.equal(below.status, 400);
    assert.equal((await json(below)).error.code, "BELOW_MIN");
  } finally { await api.close(); }
});

test("deposit: invalid phone → 400 INVALID_PHONE", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/deposits", { token: PLAYER, body: { amount: 50_000, phone: "12345" } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "INVALID_PHONE");
  } finally { await api.close(); }
});

test("deposit: malformed STK callback → 400 BAD_CALLBACK", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/deposits/mpesa/callback", { body: { nope: true } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "BAD_CALLBACK");
  } finally { await api.close(); }
});

// ─────────────────────────── withdrawal flow ───────────────────────────

test("withdrawal: request holds funds, admin approves, B2C result settles", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const wd = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 300_000, phone: "0712345678" } });
    assert.equal(wd.status, 202);
    const { transactionId, newBalance } = await json(wd);
    assert.equal(newBalance, 700_000); // funds held immediately

    // Player cannot approve.
    const forbidden = await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: PLAYER });
    assert.equal(forbidden.status, 403);

    // Finance admin approves → B2C dispatched.
    const approve = await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: ADMIN });
    assert.equal(approve.status, 200);
    const ap = await json(approve);
    assert.equal(ap.approved, true);
    assert.ok(ap.conversationId);

    // Daraja B2C success result (public, txId in path).
    const result = await req(api, "POST", `/api/v1/withdrawals/mpesa/result/${transactionId}`, {
      body: { Result: { ResultCode: 0, ConversationID: ap.conversationId, TransactionID: "R555", ResultDesc: "Completed" } },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await json(result), { ResultCode: 0, ResultDesc: "Accepted" });

    // Success event fired.
    assert.deepEqual(api.withdrawalSuccesses, [{ userId: PLAYER, amountCents: 300_000 }]);

    // Balance stays debited after a successful payout.
    const wallet = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(wallet.real, 700_000);
  } finally { await api.close(); }
});

test("withdrawal: insufficient funds → 402", async () => {
  const api = await startTestApi({ startingBalanceCents: 50_000 });
  try {
    const res = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 300_000, phone: "0712345678" } });
    assert.equal(res.status, 402);
    assert.equal((await json(res)).error.code, "INSUFFICIENT_FUNDS");
  } finally { await api.close(); }
});

test("withdrawal: admin reject reverses the hold", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const wd = await json(await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 400_000, phone: "0712345678" } }));
    assert.equal(wd.newBalance, 600_000);

    const reject = await req(api, "POST", `/api/v1/admin/withdrawals/${wd.transactionId}/reject`, { token: ADMIN });
    assert.equal(reject.status, 200);
    const rj = await json(reject);
    assert.equal(rj.reversed, true);
    assert.equal(rj.newBalance, 1_000_000); // hold reversed

    const wallet = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(wallet.real, 1_000_000);
  } finally { await api.close(); }
});

test("withdrawal B2C result for unknown tx → 404 TX_NOT_FOUND", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/withdrawals/mpesa/result/00000000-0000-0000-0000-000000000000", {
      body: { Result: { ResultCode: 0, ConversationID: "x" } },
    });
    assert.equal(res.status, 404);
    assert.equal((await json(res)).error.code, "TX_NOT_FOUND");
  } finally { await api.close(); }
});

test("admin approve requires admin (marketer is insufficient)", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "POST", "/api/v1/admin/withdrawals/some-id/approve", { token: `${TEST_ADMIN}:marketer` });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "FORBIDDEN");
  } finally { await api.close(); }
});

// ───────────────────────────── multi-tenant callback prefix (docs/22 Task E) ─────────────

test("STK callback via /s/<slug> prefix resolves the brand and credits the deposit", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    const dep = await req(api, "POST", "/api/v1/deposits", { token: PLAYER, body: { amount: 25_000, phone: "0712345678" } });
    assert.equal(dep.status, 202);
    const { checkoutRequestId } = await json(dep);

    // Brand B's shortcode posts to its own slug-prefixed callback URL.
    const cb = await req(api, "POST", "/api/v1/s/brandb/deposits/mpesa/callback", {
      body: { Body: { stkCallback: {
        CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: { Item: [{ Name: "Amount", Value: 250 }, { Name: "MpesaReceiptNumber", Value: "QBRANDB001" }] },
      } } },
    });
    assert.equal(cb.status, 200);
    assert.deepEqual(await json(cb), { ResultCode: 0, ResultDesc: "Accepted" });

    const wallet = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(wallet.real, 125_000, "deposit credited through the slug-prefixed route");
  } finally { await api.close(); }
});

test("STK callback via /s/<slug> with an unknown slug → 404 SITE_NOT_FOUND, no credit", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    const cb = await req(api, "POST", "/api/v1/s/nosuchbrand/deposits/mpesa/callback", {
      body: { Body: { stkCallback: {
        CheckoutRequestID: "ws_CO_whatever", ResultCode: 0, ResultDesc: "ok",
      } } },
    });
    assert.equal(cb.status, 404);
    assert.equal((await json(cb)).error.code, "SITE_NOT_FOUND");
  } finally { await api.close(); }
});

test("B2C result via /s/<slug> prefix resolves the brand and settles the withdrawal", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const wd = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 100_000, phone: "0712345678" } });
    assert.equal(wd.status, 202);
    const { transactionId } = await json(wd);
    await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: ADMIN });

    const res = await req(api, "POST", `/api/v1/s/invest254/withdrawals/mpesa/result/${transactionId}`, {
      body: { Result: { ResultCode: 0, ConversationID: "AG_20260812_x", TransactionReceipt: "QB2C001" } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { ResultCode: 0, ResultDesc: "Accepted" });
  } finally { await api.close(); }
});

// ───────────────────────── money routes are site-scoped (docs/22 Task E) ─────────────────────

test("deposit made under a brand-B token is stamped to brand B and only visible under brand B", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    const playerB = `${PLAYER}:player:${SITE_B}`;               // token carries site=B (3rd segment)

    const dep = await req(api, "POST", "/api/v1/deposits", { token: playerB, body: { amount: 40_000, phone: "0712345678" } });
    assert.equal(dep.status, 202);

    // Brand-B token sees the withdrawal-less deposit tx; the default-brand token does not.
    const txB = await json(await req(api, "GET", "/api/v1/transactions", { token: playerB }));
    assert.equal(txB.items.length, 1, "brand-B token sees its own deposit");
    assert.equal(txB.items[0].kind, "deposit");
    assert.equal(txB.items[0].amountCents, 40_000);

    const txDefault = await json(await req(api, "GET", "/api/v1/transactions", { token: PLAYER }));
    assert.equal(txDefault.items.length, 0, "default-brand token cannot see the brand-B deposit");
  } finally { await api.close(); }
});
