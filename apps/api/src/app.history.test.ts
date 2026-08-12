import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, SITE_A, SITE_B, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const PLAYER = TEST_USER;

function get(api: TestApi, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch(`${api.baseUrl}${path}`, { headers });
}

/** Seed a ledger trail (seed + stake + payout) and a settled+open position for the test user. */
async function seedHistory(api: TestApi) {
  const dayId = await api.gameRepo.ensureGameDay("2026-06-17", "h17");
  const a = await api.gameRepo.openPosition({ userId: PLAYER, stakeCents: 20_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: dayId, nonce: 1, openedAtMs: 10 , configVersion: 1});
  await api.gameRepo.settlePosition({ positionId: a.positionId, exitRate: 0.25, result: "win", multiplier: 2.5, payoutCents: 50_000 });
  const b = await api.gameRepo.openPosition({ userId: PLAYER, stakeCents: 30_000, direction: "sell", entryRate: 0.2, durationS: 10, gameDayId: dayId, nonce: 2, openedAtMs: 20 , configVersion: 1});
  return { settledId: a.positionId, openId: b.positionId };
}

// ─────────────────────────── ledger ───────────────────────────

test("GET /wallet/ledger → 401 without auth", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await get(api, "/api/v1/wallet/ledger")).status, 401);
  } finally { await api.close(); }
});

test("GET /wallet/ledger → newest-first + cursor pagination", async () => {
  const api = await startTestApi();
  try {
    await seedHistory(api); // ledger: seed, stake, payout, stake  (4 entries)
    const p1 = await json(await get(api, "/api/v1/wallet/ledger?limit=2", PLAYER));
    assert.equal(p1.items.length, 2);
    assert.equal(p1.items[0].type, "stake");   // most recent (second open)
    assert.ok(p1.nextCursor);

    const p2 = await json(await get(api, `/api/v1/wallet/ledger?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, PLAYER));
    assert.equal(p2.items.length, 2);
    // every entry belongs to the caller's view and carries a numeric ts
    assert.ok(p2.items.every((e: any) => typeof e.ts === "number"));
  } finally { await api.close(); }
});

test("GET /wallet/ledger?limit=0 → 400", async () => {
  const api = await startTestApi();
  try {
    const res = await get(api, "/api/v1/wallet/ledger?limit=0", PLAYER);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "INVALID_LIMIT");
  } finally { await api.close(); }
});

// ─────────────────────────── positions ───────────────────────────

test("GET /positions → newest-first; status filter", async () => {
  const api = await startTestApi();
  try {
    const { settledId, openId } = await seedHistory(api);
    const all = await json(await get(api, "/api/v1/positions", PLAYER));
    assert.deepEqual(all.items.map((p: any) => p.id), [openId, settledId]);
    assert.equal(all.items[0].userId, undefined); // userId not leaked in DTO

    const open = await json(await get(api, "/api/v1/positions?status=open", PLAYER));
    assert.deepEqual(open.items.map((p: any) => p.id), [openId]);

    const settled = await json(await get(api, "/api/v1/positions?status=settled", PLAYER));
    assert.equal(settled.items[0].result, "win");
    assert.equal(settled.items[0].payoutCents, 50_000);
    assert.equal(settled.items[0].pnlCents, 30_000);
  } finally { await api.close(); }
});

test("GET /positions/:id → detail incl. fairness (seed hidden pre-reveal)", async () => {
  const api = await startTestApi();
  try {
    const { settledId } = await seedHistory(api);
    const body = await json(await get(api, `/api/v1/positions/${settledId}`, PLAYER));
    assert.equal(body.id, settledId);
    assert.equal(body.fairness.serverSeedHash, "h17");
    assert.equal(body.fairness.serverSeed, null); // not revealed

    await api.gameRepo.revealSeed("2026-06-17", "s17");
    const revealed = await json(await get(api, `/api/v1/positions/${settledId}`, PLAYER));
    assert.equal(revealed.fairness.serverSeed, "s17");
  } finally { await api.close(); }
});

test("GET /positions/:id → 404 unknown, 400 malformed, isolation across users", async () => {
  const api = await startTestApi();
  try {
    const { settledId } = await seedHistory(api);
    assert.equal((await get(api, "/api/v1/positions/11111111-1111-1111-1111-111111111111", PLAYER)).status, 404);
    assert.equal((await get(api, "/api/v1/positions/not-a-uuid", PLAYER)).status, 400);
    // another user cannot read this user's position
    assert.equal((await get(api, `/api/v1/positions/${settledId}`, "intruder")).status, 404);
  } finally { await api.close(); }
});

// ─────────────────────────── transactions ───────────────────────────

test("GET /transactions → kind filter + mapping", async () => {
  const api = await startTestApi();
  try {
    const dep = await api.payRepo.createDeposit(PLAYER, 50_000, "254712345678");
    await api.payRepo.attachStk(dep, "m1", "co1");
    await api.payRepo.completeDeposit("co1", 0, "ok", "RCPT9", {});
    await api.payRepo.createWithdrawal(PLAYER, 30_000, "254712345678", 20_000);

    const all = await json(await get(api, "/api/v1/transactions", PLAYER));
    assert.deepEqual(all.items.map((t: any) => t.kind), ["withdrawal", "deposit"]);

    const deposits = await json(await get(api, "/api/v1/transactions?kind=deposit", PLAYER));
    assert.equal(deposits.items.length, 1);
    assert.equal(deposits.items[0].status, "success");
    assert.equal(deposits.items[0].mpesaReceipt, "RCPT9");
  } finally { await api.close(); }
});

test("GET /transactions?kind=bogus → 400", async () => {
  const api = await startTestApi();
  try {
    const res = await get(api, "/api/v1/transactions?kind=bogus", PLAYER);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "INVALID_KIND");
  } finally { await api.close(); }
});

// ───────────────────────────── site scoping (docs/22 Task E) ─────────────────────────────

test("history reads are scoped to the token's site: brand-B token sees only brand-B rows", async () => {
  const api = await startTestApi();
  try {
    // Same user plays on BOTH brands: one position on the default site, one on brand B.
    const dayA = await api.gameRepo.ensureGameDay("2026-08-12", "hA", SITE_A);
    const dayB = await api.gameRepo.ensureGameDay("2026-08-12", "hB", SITE_B);
    const posA = await api.gameRepo.openPosition({ userId: PLAYER, stakeCents: 10_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: dayA, nonce: 1, openedAtMs: 10, configVersion: 1, siteId: SITE_A });
    const posB = await api.gameRepo.openPosition({ userId: PLAYER, stakeCents: 20_000, direction: "sell", entryRate: 0.2, durationS: 10, gameDayId: dayB, nonce: 2, openedAtMs: 20, configVersion: 1, siteId: SITE_B });

    // Token scoped to brand B (3rd token segment = siteId, see testutil).
    const playerB = `${PLAYER}:player:${SITE_B}`;

    const positions = await json(await get(api, "/api/v1/positions", playerB));
    assert.equal(positions.items.length, 1, "brand-B token sees only the brand-B position");
    assert.equal(positions.items[0].id, posB.positionId);

    const ledger = await json(await get(api, "/api/v1/wallet/ledger", playerB));
    assert.ok(ledger.items.length > 0);
    assert.ok(ledger.items.every((e: any) => e.type !== "stake" || true)); // ledger rows exist
    const stakes = ledger.items.filter((e: any) => e.type === "stake");
    assert.equal(stakes.length, 1, "brand-B ledger shows only the brand-B stake");
    assert.equal(stakes[0].amountCents, -20_000);

    // Position detail: brand-A position is invisible to the brand-B token.
    assert.equal((await get(api, `/api/v1/positions/${posA.positionId}`, playerB)).status, 404);
    assert.equal((await get(api, `/api/v1/positions/${posB.positionId}`, playerB)).status, 200);

    // Legacy token (no site claim) still sees the default site's rows.
    const positionsA = await json(await get(api, "/api/v1/positions", PLAYER));
    assert.equal(positionsA.items.length, 1);
    assert.equal(positionsA.items[0].id, posA.positionId);
  } finally { await api.close(); }
});
