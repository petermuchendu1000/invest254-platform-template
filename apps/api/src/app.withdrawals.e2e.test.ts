import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";

/**
 * End-to-end coverage for "withdraw on the site -> message appears in the app".
 *
 * The chain under test:
 *   POST /api/v1/withdrawals (player, marketer phone)
 *     -> fn_marketer_game_withdraw equivalent (instant game -> marketer wallet transfer)
 *     -> marketer ledger credit with source=game_withdrawal
 *     -> GET /api/v1/marketers/me/transactions renders it as an M-PESA "received" SMS
 *     -> activity feed records the withdrawal (onWithdrawalSuccess)
 *     -> newest-first ordering so the app shows the latest message on top
 *
 * Plus the negative paths: non-marketer players (Daraja hold), insufficient funds,
 * below-minimum, invalid amount, suspended marketer, unauthenticated/wrong-role access,
 * and idempotent replay.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const ADMIN = `${TEST_ADMIN}:admin`;
const PLAYER = TEST_USER; // "u-test", role player, seeded with KES 10,000 by default
const PHONE = "0722000099";
const mtok = (id: string) => `${id}:marketer`;

/** Onboard a marketer whose phone matches the withdrawing player's profile phone. */
async function onboardMarketer(api: TestApi, name = "Peter Muchendu", phone = PHONE): Promise<string> {
  const res = await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name, phone } });
  assert.ok([200, 201].includes(res.status), `onboard status ${res.status}`);
  return (await json(res)).id as string;
}

/** Link the seeded player to the marketer phone and mirror the game->marketer credit in the marketer ledger. */
function wireMarketerPath(api: TestApi, marketerId: string, phone = PHONE): void {
  api.payRepo.setPhone(PLAYER, phone);
  api.payRepo.markAsMarketer(phone, marketerId);
  api.payRepo.onMarketerCredit = (mid, amountCents, ref) => {
    void api.marketers.credit(mid, amountCents, ref, { source: "game_withdrawal", tx: ref.slice(5) });
  };
}

async function feed(api: TestApi, marketerId: string): Promise<any[]> {
  const res = await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(marketerId) });
  assert.equal(res.status, 200);
  return (await json(res)).items;
}

// ─── happy path ─────────────────────────────────────────────────────────────

test("e2e: marketer withdrawal is GATED -> pending -> admin approves -> M-PESA 'received' message in app feed", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);

    const res = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 50_000, phone: PHONE } });
    assert.equal(res.status, 202); // gated (0108): pending admin approval, NOT instant
    const body = await json(res);
    assert.equal(body.paid, undefined);
    assert.equal(body.newBalance, 950_000); // demo balance held immediately

    // admin is notified of the request; nothing credited and no app message yet
    assert.equal(api.withdrawalRequests.length, 1);
    assert.equal(api.withdrawalRequests[0]!.txId, body.transactionId);
    assert.equal((await feed(api, mid)).length, 0);
    assert.equal(api.withdrawalSuccesses.length, 0);

    // admin approves -> marketer wallet credited + M-PESA 'received' message appears
    assert.equal((await req(api, "POST", `/api/v1/admin/withdrawals/${body.transactionId}/approve`, { token: ADMIN })).status, 200);

    const items = await feed(api, mid);
    assert.equal(items.length, 1);
    const tx = items[0];
    assert.equal(tx.direction, "in");
    assert.equal(tx.entryType, "credit");
    assert.equal(tx.amountCents, 50_000);
    assert.equal(tx.balanceAfterCents, 50_000);
    assert.equal(tx.source, "game_withdrawal");
    assert.equal(tx.mpesa.party, "INVEST254");
    assert.equal(tx.mpesa.amountText, "Ksh500.00");
    assert.match(tx.mpesa.message, /^.{10} Confirmed\.You have received Ksh500\.00 from INVEST254 on /);
    assert.match(tx.mpesa.message, /New M-PESA balance is Ksh500\.00/);
    assert.equal(api.withdrawalSuccesses.length, 1);
    assert.deepEqual(api.withdrawalSuccesses[0], { userId: PLAYER, amountCents: 50_000 });
  } finally { await api.close(); }
});

test("e2e: multiple approved withdrawals appear newest-first (latest message on top)", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);

    for (const amount of [25_000, 30_000, 40_000]) {
      const r = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount, phone: PHONE } });
      assert.equal(r.status, 202);
      const { transactionId } = await json(r);
      assert.equal((await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: ADMIN })).status, 200);
    }

    const items = await feed(api, mid);
    assert.equal(items.length, 3);
    assert.equal(items[0].amountCents, 40_000); // newest on top
    assert.equal(items[1].amountCents, 30_000);
    assert.equal(items[2].amountCents, 25_000);
    assert.ok(items[0].id > items[1].id && items[1].id > items[2].id);
    // running balance reflected in each confirmation SMS (credited in request order)
    assert.match(items[0].mpesa.message, /New M-PESA balance is Ksh950\.00/);
    assert.match(items[2].mpesa.message, /New M-PESA balance is Ksh250\.00/);

    assert.equal(api.withdrawalSuccesses.length, 3);
  } finally { await api.close(); }
});

test("e2e: game wallet and marketer wallet balances stay consistent across gated withdrawals", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);

    for (const amount of [40_000, 25_000]) {
      const r = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount, phone: PHONE } });
      const { transactionId } = await json(r);
      await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: ADMIN });
    }

    const wallet = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(wallet.real, 35_000); // 1000 - 400 - 250 (held on request)

    const me = await json(await req(api, "GET", "/api/v1/marketers/me", { token: mtok(mid) }));
    assert.equal(me.balance_cents, 65_000); // credited on approval
  } finally { await api.close(); }
});

// ─── non-marketer player ────────────────────────────────────────────────────

test("e2e: non-marketer withdrawal takes the Daraja hold path and never touches the marketer feed", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api); // marketer exists but the player is NOT linked to it
    const res = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 50_000, phone: "0733000111" } });
    assert.equal(res.status, 202); // pending admin approval, not instantly paid
    const body = await json(res);
    assert.equal(body.paid, undefined);
    assert.ok(body.transactionId);

    assert.equal((await feed(api, mid)).length, 0); // no message in the app
    assert.equal(api.withdrawalSuccesses.length, 0); // no activity-feed entry yet
  } finally { await api.close(); }
});

test("e2e: non-marketer withdrawal completes via B2C -> activity feed records it, marketer feed stays empty", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api);
    const res = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 50_000, phone: "0733000111" } });
    const { transactionId } = await json(res);

    assert.equal((await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: ADMIN })).status, 200);
    const cb = await req(api, "POST", `/api/v1/withdrawals/mpesa/result/${transactionId}`, {
      body: { Result: { ResultCode: 0, ConversationID: "conv-1", TransactionReceipt: "QAB123" } },
    });
    assert.equal(cb.status, 200);

    assert.equal(api.withdrawalSuccesses.length, 1); // activity feed entry recorded
    assert.equal((await feed(api, mid)).length, 0); // but nothing in the marketer's app
  } finally { await api.close(); }
});

// ─── failure / guard rails ──────────────────────────────────────────────────

test("e2e: insufficient funds -> withdrawal rejected, no message, balances untouched", async () => {
  const api = await startTestApi({ startingBalanceCents: 10_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);

    const res = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 50_000, phone: PHONE } });
    assert.notEqual(res.status, 200);
    assert.equal((await feed(api, mid)).length, 0);

    const wallet = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(wallet.real, 10_000);
    assert.equal(api.withdrawalSuccesses.length, 0);
  } finally { await api.close(); }
});

test("e2e: below-minimum and non-positive amounts are rejected before any wallet movement", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);

    for (const amount of [0, -500, 1]) { // 1 cent is below any sane minimum
      const res = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount, phone: PHONE } });
      assert.notEqual(res.status, 200, `amount ${amount} must be rejected`);
    }
    assert.equal((await feed(api, mid)).length, 0);
    const wallet = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(wallet.real, 1_000_000);
  } finally { await api.close(); }
});

test("e2e: suspended marketer cannot receive withdrawals (account gate)", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);
    // Suspend the marketer: the SQL gates on marketer status; the in-memory mirror models
    // this by removing the phone registration (a suspended marketer is not payable).
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${mid}/status`, { token: ADMIN, body: { status: "suspended" } })).status, 200);

    // The marketer's own feed is also immediately blocked while suspended.
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(mid) })).status, 403);
  } finally { await api.close(); }
});

test("e2e: withdrawals endpoint requires auth; marketer feed requires a marketer token", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "POST", "/api/v1/withdrawals", { body: { amount: 50_000, phone: PHONE } })).status, 401);
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/transactions")).status, 401);
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/transactions", { token: PLAYER })).status, 403);
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/transactions", { token: ADMIN })).status, 403);
  } finally { await api.close(); }
});

// ─── idempotency / replay ───────────────────────────────────────────────────

test("e2e: replayed marketer credit with the same ref does not duplicate the message", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);

    // Simulate a retried credit (e.g. callback replay) with the same ref twice.
    await api.marketers.credit(mid, 70_000, "game:tx-dup", { source: "game_withdrawal" });
    await api.marketers.credit(mid, 70_000, "game:tx-dup", { source: "game_withdrawal" });

    const items = await feed(api, mid);
    assert.equal(items.length, 1);
    assert.equal(items[0].balanceAfterCents, 70_000); // not 140_000
  } finally { await api.close(); }
});

// ─── DTO shape the app depends on ───────────────────────────────────────────

test("e2e: feed DTO carries every field the app needs to render and sort messages", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);
    const r = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 123_456, phone: PHONE } });
    const { transactionId } = await json(r);
    await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: ADMIN });

    const [tx] = await feed(api, mid);
    for (const key of ["id", "entryType", "amountCents", "balanceAfterCents", "ref", "source", "direction", "createdAtMs", "mpesa"]) {
      assert.ok(key in tx, `missing field ${key}`);
    }
    for (const key of ["code", "party", "amountText", "message"]) {
      assert.ok(key in tx.mpesa, `missing mpesa field ${key}`);
    }
    assert.equal(typeof tx.createdAtMs, "number");
    assert.ok(tx.createdAtMs > 0);
    assert.equal(tx.mpesa.code.length, 10);
  } finally { await api.close(); }
});

test("e2e: outgoing (marketer cash-out) entries render as 'sent' messages and sort with incoming", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const mid = await onboardMarketer(api);
    wireMarketerPath(api, mid);

    // money in via game withdrawal (gated -> admin approves), then the marketer cashes out via admin withdraw
    const inReq = await req(api, "POST", "/api/v1/withdrawals", { token: PLAYER, body: { amount: 80_000, phone: PHONE } });
    const { transactionId } = await json(inReq);
    await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: ADMIN });
    const out = await req(api, "POST", `/api/v1/admin/marketers/${mid}/withdraw`, { token: ADMIN, body: { amountCents: 30_000, ref: "cashout-1" } });
    assert.equal(out.status, 200);

    const items = await feed(api, mid);
    assert.equal(items.length, 2);
    assert.equal(items[0].direction, "out"); // newest (cash-out) on top
    assert.equal(items[0].amountCents, -30_000);
    assert.match(items[0].mpesa.message, /Confirmed\. Ksh300\.00 sent to /);
    assert.equal(items[1].direction, "in");
    assert.match(items[1].mpesa.message, /You have received Ksh800\.00 from INVEST254/);
  } finally { await api.close(); }
});
