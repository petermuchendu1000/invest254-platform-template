import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi, SITE_A, SITE_B } from "./testutil.js";

/**
 * Regression tests for the control-plane/data-plane split fix (migration 0061).
 *
 * BUG (before): the operator "Game configuration" panel (GET/PATCH /admin/game-config) wrote the
 * LEGACY singleton `game_config`, while the multiplexed engine prices every brand from
 * `site_game_config`. So lowering the win rate / edge / cap in the panel had ZERO effect on the
 * live game — the two were divorced (proven live: API reported v254/x4, engine reported v204/x5).
 *
 * FIX: /admin/game-config is now PER-BRAND, reading/writing the SAME `site_game_config` the engine
 * consumes, scoped to the operator's site (JWT `site` claim; platform owner may target via ?site=).
 * These tests lock that contract in: per-brand isolation, cross-brand safety, and owner parity.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

function req(api: TestApi, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

// A platform_superadmin (no site claim) may target any brand via ?site=; a site-scoped superadmin
// is pinned to their JWT `site` claim. Token format: `<userId>:<role>[:<siteId>]` (stub verifier).
const OWNER = "owner:platform_superadmin";

test("game-config is per-brand and isolated (editing site A never touches site B)", async () => {
  const api = await startTestApi();
  try {
    // Edit brand A's economy; brand B must be unaffected (proves it is NOT a global singleton).
    const upA = await req(api, "PATCH", `/api/v1/admin/game-config?site=${SITE_A}`,
      { token: OWNER, body: { houseEdge: 0.7, targetWinRate: 0.1 } });
    assert.equal(upA.status, 200, "owner edits brand A");
    assert.equal((await json(upA)).houseEdge, 0.7);

    const upB = await req(api, "PATCH", `/api/v1/admin/game-config?site=${SITE_B}`,
      { token: OWNER, body: { houseEdge: 0.6, targetWinRate: 0.08 } });
    assert.equal(upB.status, 200, "owner edits brand B");
    assert.equal((await json(upB)).houseEdge, 0.6);

    const a = await json(await req(api, "GET", `/api/v1/admin/game-config?site=${SITE_A}`, { token: OWNER }));
    const b = await json(await req(api, "GET", `/api/v1/admin/game-config?site=${SITE_B}`, { token: OWNER }));
    assert.equal(a.houseEdge, 0.7, "brand A kept its own edge");
    assert.equal(b.houseEdge, 0.6, "brand B kept its own edge — isolation holds");
    assert.equal(a.targetWinRate, 0.1);
    assert.equal(b.targetWinRate, 0.08);
    assert.notEqual(a.houseEdge, b.houseEdge);
  } finally { await api.close(); }
});

test("a site-scoped superadmin is pinned to their brand and cannot cross-edit via ?site=", async () => {
  const api = await startTestApi();
  try {
    // Token is scoped to SITE_B; even though it names SITE_A in the query, the write must land on B.
    const scopedB = `boss:superadmin:${SITE_B}`;
    const up = await req(api, "PATCH", `/api/v1/admin/game-config?site=${SITE_A}`,
      { token: scopedB, body: { houseEdge: 0.55, targetWinRate: 0.09 } });
    assert.equal(up.status, 200);

    // Brand A must be untouched by the scoped-B operator's attempt.
    const a = await json(await req(api, "GET", `/api/v1/admin/game-config?site=${SITE_A}`, { token: OWNER }));
    assert.notEqual(a.houseEdge, 0.55, "scoped-B admin could NOT edit brand A");
    // Brand B received the edit (its own brand).
    const b = await json(await req(api, "GET", `/api/v1/admin/game-config`, { token: scopedB }));
    assert.equal(b.houseEdge, 0.55, "scoped-B admin edited its own brand");
  } finally { await api.close(); }
});

test("edit round-trips and bumps the config version (the engine reload signal)", async () => {
  const api = await startTestApi();
  try {
    const before = await json(await req(api, "GET", `/api/v1/admin/game-config?site=${SITE_A}`, { token: OWNER }));
    const up = await req(api, "PATCH", `/api/v1/admin/game-config?site=${SITE_A}`,
      { token: OWNER, body: { targetWinRate: 0.06, houseEdge: 0.8, maxMultiplier: 4 } });
    assert.equal(up.status, 200);
    const after = await json(up);
    assert.equal(after.targetWinRate, 0.06);
    assert.equal(after.houseEdge, 0.8);
    assert.equal(after.maxMultiplier, 4);
    assert.equal(after.version, before.version + 1, "version bumped so the engine re-prices");
    // GET reflects the same values (read path and write path share one source).
    const reread = await json(await req(api, "GET", `/api/v1/admin/game-config?site=${SITE_A}`, { token: OWNER }));
    assert.equal(reread.targetWinRate, 0.06);
    assert.equal(reread.version, after.version);
  } finally { await api.close(); }
});

test("infeasible economy is rejected (RTP/winRate must be within the multiplier cap)", async () => {
  const api = await startTestApi();
  try {
    // edge 0.80 -> RTP 0.20; win 0.01 -> required mean win multiple 20, above any sane cap -> reject.
    const bad = await req(api, "PATCH", `/api/v1/admin/game-config?site=${SITE_A}`,
      { token: OWNER, body: { houseEdge: 0.8, targetWinRate: 0.01, maxMultiplier: 4 } });
    assert.equal(bad.status, 400, "infeasible config rejected before it can mis-price the brand");
  } finally { await api.close(); }
});

test("only superadmin/platform_superadmin may edit; a plain admin is forbidden", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "PATCH", `/api/v1/admin/game-config?site=${SITE_A}`,
      { token: "someadmin:admin", body: { houseEdge: 0.7 } });
    assert.equal(res.status, 403, "day-to-day admin cannot change the economy");
  } finally { await api.close(); }
});
