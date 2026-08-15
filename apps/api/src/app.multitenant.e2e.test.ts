import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * Aggressive multi-tenant END-TO-END coverage (docs/22 Task E) driven entirely through the real
 * HTTP API (createApp + real engine services over in-memory repos). Every scenario asserts one of
 * the two multi-tenant invariants:
 *
 *   ISOLATION  — a brand-scoped token sees/affects ONLY its own brand's rows.
 *   ROUTING    — host/slug resolves to the right brand (brand route + /s/<slug> callback prefix),
 *                and a token can never operate on a brand it is not scoped to.
 *
 * The in-memory wallet balance is intentionally site-agnostic (per-site balance isolation is a Pg
 * `wallets.site_id` concern, proven by the getBalance unit filter + the DB testkit); here we prove
 * everything the app layer is responsible for: transaction/position/ledger scoping, callback
 * brand resolution, JWT-claim enforcement, and legacy-token default-site fallback.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, o: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const get = (api: TestApi, path: string, token?: string) => req(api, "GET", path, token ? { token } : {});

// Tokens: legacy (no site claim -> default brand A), brand-B scoped, admin.
const A = TEST_USER;                                  // legacy => site A (default)
const B = `${TEST_USER}:player:${SITE_B}`;            // 3rd segment = site claim
const ADMIN = `${TEST_ADMIN}:admin`;

const stkOk = (checkoutRequestId: string, receipt: string) => ({
  Body: { stkCallback: {
    CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: "ok",
    CallbackMetadata: { Item: [{ Name: "Amount", Value: 1 }, { Name: "MpesaReceiptNumber", Value: receipt }] },
  } },
});

/** Drive a full deposit: POST /deposits (brand token) -> STK callback via that brand's /s/<slug>. */
async function deposit(api: TestApi, token: string, slug: string, amount: number, receipt: string) {
  const dep = await req(api, "POST", "/api/v1/deposits", { token, body: { amount, phone: "0712345678" } });
  assert.equal(dep.status, 202, "deposit accepted");
  const { checkoutRequestId } = await json(dep);
  const cb = await req(api, "POST", `/api/v1/s/${slug}/deposits/mpesa/callback`, { body: stkOk(checkoutRequestId, receipt) });
  assert.equal(cb.status, 200, "slug-prefixed STK callback acked");
  return checkoutRequestId;
}

// ───────────────────────────── 1. transaction isolation across brands ─────────────────────────

test("E2E isolation: deposits are visible only to the brand that made them", async () => {
  const api = await startTestApi({ startingBalanceCents: 500_000 });
  try {
    await deposit(api, A, "invest254", 40_000, "RA-DEP");
    await deposit(api, B, "brandb", 25_000, "RB-DEP");

    const txA = await json(await get(api, "/api/v1/transactions", A));
    const txB = await json(await get(api, "/api/v1/transactions", B));
    assert.deepEqual(txA.items.map((t: any) => t.amountCents), [40_000], "brand A sees only its deposit");
    assert.deepEqual(txB.items.map((t: any) => t.amountCents), [25_000], "brand B sees only its deposit");
    // ...and neither sees the other's receipt anywhere in its list.
    assert.ok(!JSON.stringify(txA.items).includes("RB"), "no brand-B data leaks into A");
    assert.ok(!JSON.stringify(txB.items).includes("RA"), "no brand-A data leaks into B");
  } finally { await api.close(); }
});

test("E2E isolation: position + ledger history is scoped to the token's brand", async () => {
  const api = await startTestApi();
  try {
    const dayA = await api.gameRepo.ensureGameDay("2026-08-12", "hA", SITE_A);
    const dayB = await api.gameRepo.ensureGameDay("2026-08-12", "hB", SITE_B);
    const pA = await api.gameRepo.openPosition({ userId: TEST_USER, stakeCents: 10_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: dayA, nonce: 1, openedAtMs: 10, configVersion: 1, siteId: SITE_A });
    const pB = await api.gameRepo.openPosition({ userId: TEST_USER, stakeCents: 20_000, direction: "sell", entryRate: 0.2, durationS: 10, gameDayId: dayB, nonce: 2, openedAtMs: 20, configVersion: 1, siteId: SITE_B });

    const posA = await json(await get(api, "/api/v1/positions", A));
    const posB = await json(await get(api, "/api/v1/positions", B));
    assert.deepEqual(posA.items.map((p: any) => p.id), [pA.positionId]);
    assert.deepEqual(posB.items.map((p: any) => p.id), [pB.positionId]);

    // Ledger: A shows the 10k stake, B shows the 20k stake — never both.
    const ledA = await json(await get(api, "/api/v1/wallet/ledger", A));
    const ledB = await json(await get(api, "/api/v1/wallet/ledger", B));
    assert.deepEqual(ledA.items.filter((e: any) => e.type === "stake").map((e: any) => e.amountCents), [-10_000]);
    assert.deepEqual(ledB.items.filter((e: any) => e.type === "stake").map((e: any) => e.amountCents), [-20_000]);
  } finally { await api.close(); }
});

// ───────────────────────────── 2. adversarial cross-brand access ──────────────────────────────

test("E2E attack: a brand-B token cannot read a brand-A position by id (404)", async () => {
  const api = await startTestApi();
  try {
    const dayA = await api.gameRepo.ensureGameDay("2026-08-12", "hA", SITE_A);
    const pA = await api.gameRepo.openPosition({ userId: TEST_USER, stakeCents: 10_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: dayA, nonce: 1, openedAtMs: 10, configVersion: 1, siteId: SITE_A });
    assert.equal((await get(api, `/api/v1/positions/${pA.positionId}`, B)).status, 404, "B cannot see A's position");
    assert.equal((await get(api, `/api/v1/positions/${pA.positionId}`, A)).status, 200, "A can see its own position");
  } finally { await api.close(); }
});

test("E2E attack: token scoped to B naming ?site=A is rejected (AUTH_SITE_MISMATCH)", async () => {
  const api = await startTestApi();
  try {
    for (const path of ["/api/v1/wallet", "/api/v1/positions", "/api/v1/transactions", "/api/v1/wallet/ledger"]) {
      const res = await get(api, `${path}?site=${SITE_A}`, B);
      assert.equal(res.status, 403, `${path} rejects cross-brand ?site`);
      assert.equal((await json(res)).error.code, "AUTH_SITE_MISMATCH");
    }
    // The token's OWN brand is accepted.
    assert.equal((await get(api, `/api/v1/wallet?site=${SITE_B}`, B)).status, 200);
  } finally { await api.close(); }
});

test("E2E: a legacy token (no site claim) defaults to brand A and sees only A rows", async () => {
  const api = await startTestApi();
  try {
    const dayA = await api.gameRepo.ensureGameDay("2026-08-12", "hA", SITE_A);
    const dayB = await api.gameRepo.ensureGameDay("2026-08-12", "hB", SITE_B);
    await api.gameRepo.openPosition({ userId: TEST_USER, stakeCents: 10_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: dayA, nonce: 1, openedAtMs: 10, configVersion: 1, siteId: SITE_A });
    await api.gameRepo.openPosition({ userId: TEST_USER, stakeCents: 20_000, direction: "sell", entryRate: 0.2, durationS: 10, gameDayId: dayB, nonce: 2, openedAtMs: 20, configVersion: 1, siteId: SITE_B });
    const pos = await json(await get(api, "/api/v1/positions", A));
    assert.equal(pos.items.length, 1, "legacy token sees only the default brand's position");
    assert.equal(pos.items[0].stakeCents, 10_000);
  } finally { await api.close(); }
});

// ───────────────────────────── 3. callback-prefix brand routing ───────────────────────────────

test("E2E routing: STK callback resolves the brand from /s/<slug>; unknown slug 404s", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    // A legit prefixed deposit credits (verified via the wallet delta on the shared balance).
    const before = (await json(await get(api, "/api/v1/wallet", B))).real;
    await deposit(api, B, "brandb", 30_000, "RB-1");
    const after = (await json(await get(api, "/api/v1/wallet", B))).real;
    assert.equal(after - before, 30_000, "prefixed callback credited the deposit");

    // Unknown slug → 404 SITE_NOT_FOUND, nothing credited.
    const bad = await req(api, "POST", "/api/v1/s/ghostbrand/deposits/mpesa/callback", { body: stkOk("ws_CO_x", "R") });
    assert.equal(bad.status, 404);
    assert.equal((await json(bad)).error.code, "SITE_NOT_FOUND");
  } finally { await api.close(); }
});

test("E2E routing: full withdrawal lifecycle settles via the brand-prefixed B2C result", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const wd = await req(api, "POST", "/api/v1/withdrawals", { token: B, body: { amount: 100_000, phone: "0712345678" } });
    assert.equal(wd.status, 202, "withdrawal held (pending)");
    const { transactionId } = await json(wd);

    // Only the brand-B token sees the pending withdrawal in its history.
    const txB = await json(await get(api, "/api/v1/transactions?kind=withdrawal", B));
    assert.deepEqual(txB.items.map((t: any) => t.id), [transactionId]);
    const txA = await json(await get(api, "/api/v1/transactions?kind=withdrawal", A));
    assert.equal(txA.items.length, 0, "brand A cannot see brand B's withdrawal");

    // Finance admin approves, then Safaricom posts the B2C result to the brand-prefixed URL.
    assert.equal((await req(api, "POST", `/api/v1/admin/withdrawals/${transactionId}/approve`, { token: ADMIN })).status, 200);
    const res = await req(api, "POST", `/api/v1/s/brandb/withdrawals/mpesa/result/${transactionId}`, {
      body: { Result: { ResultCode: 0, ConversationID: "AG_x", TransactionReceipt: "RB-W" } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { ResultCode: 0, ResultDesc: "Accepted" });
    assert.equal(api.withdrawalSuccesses.at(-1)?.amountCents, 100_000, "success event fired for the settled payout");
  } finally { await api.close(); }
});

// ───────────────────────────── 4. public brand resolution ─────────────────────────────────────

test("E2E routing: GET /site/brand resolves by host and by slug, case-insensitively", async () => {
  const api = await startTestApi();
  try {
    const byHost = await json(await get(api, "/api/v1/site/brand?host=brandb.example"));
    assert.equal(byHost.siteId, SITE_B);
    assert.equal(byHost.name, "Brand B");

    const bySlugUpper = await json(await get(api, "/api/v1/site/brand?host=INVEST254"));
    assert.equal(bySlugUpper.siteId, SITE_A, "slug match is case-insensitive");
    assert.equal(bySlugUpper.colorPrimary, "#22c55e");

    assert.equal((await get(api, "/api/v1/site/brand")).status, 400, "missing host → 400");
    assert.equal((await get(api, "/api/v1/site/brand?host=nope.example")).status, 404, "unknown host → 404");
  } finally { await api.close(); }
});

// ── GAP 4: www. resolves to the same brand (both the public brand route and the auth path) ───────
test("E2E routing: www.<domain> resolves to the same brand as the apex (public brand route)", async () => {
  const api = await startTestApi();
  try {
    const apex = await json(await get(api, "/api/v1/site/brand?host=brandb.example"));
    const www = await json(await get(api, "/api/v1/site/brand?host=www.brandb.example"));
    assert.equal(apex.siteId, SITE_B);
    assert.equal(www.siteId, SITE_B, "www.brandb.example resolves to Brand B, not the default");
    assert.equal(www.name, "Brand B");

    const mixed = await json(await get(api, "/api/v1/site/brand?host=WWW.BrandB.Example"));
    assert.equal(mixed.siteId, SITE_B, "www + mixed case still resolves");
  } finally { await api.close(); }
});

test("E2E auth: registering on www.<domain> scopes the account to the apex brand", async () => {
  const api = await startTestApi();
  try {
    // The web sends `site`, but the legacy `host` fallback must also fold www so a www visitor is
    // never silently pooled into the default brand.
    const r = await req(api, "POST", "/api/v1/auth/register",
      { body: { phone: "0712009001", username: "wwwuser", password: "Password1", host: "www.brandb.example" } });
    assert.equal(r.status, 201);
    const b = await json(r);
    assert.equal(b.site, SITE_B, "www host resolves to Brand B on register");
  } finally { await api.close(); }
});
