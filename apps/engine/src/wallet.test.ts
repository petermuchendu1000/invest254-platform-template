import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGameRepository, PgGameRepository, type Querier } from "./wallet.js";

test("InMemory repo: open debits, settle credits once (idempotent), loss credits nothing", async () => {
  const r = new InMemoryGameRepository();
  r.seed("u", 100000);
  const o = await r.openPosition({ userId: "u", stakeCents: 20000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 1, openedAtMs: 0 , configVersion: 1});
  assert.equal(o.newBalance, 80000);
  const s1 = await r.settlePosition({ positionId: o.positionId, exitRate: 0.25, result: "win", multiplier: 2.5, payoutCents: 50000 });
  assert.deepEqual(s1, { settled: true, newBalance: 130000 });
  const s2 = await r.settlePosition({ positionId: o.positionId, exitRate: 0.25, result: "win", multiplier: 2.5, payoutCents: 50000 });
  assert.equal(s2.settled, false);
  assert.equal(await r.getBalance("u"), 130000);

  r.seed("v", 30000);
  const ol = await r.openPosition({ userId: "v", stakeCents: 20000, direction: "sell", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 2, openedAtMs: 0 , configVersion: 1});
  const sl = await r.settlePosition({ positionId: ol.positionId, exitRate: 0.1, result: "loss", multiplier: 0, payoutCents: 0 });
  assert.deepEqual(sl, { settled: true, newBalance: 10000 });
});

test("InMemory repo: insufficient funds + unknown position", async () => {
  const r = new InMemoryGameRepository();
  r.seed("u", 1000);
  await assert.rejects(() => r.openPosition({ userId: "u", stakeCents: 20000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 1, openedAtMs: 0 , configVersion: 1}), /INSUFFICIENT_FUNDS/);
  await assert.rejects(() => r.settlePosition({ positionId: "nope", exitRate: 0, result: "loss", multiplier: 0, payoutCents: 0 }), /POSITION_NOT_FOUND/);
});

test("Pg repo: calls the RPCs with correct params and parses bigint strings", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const fake: Querier = {
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes("fn_open_position")) return { rows: [{ position_id: "p-1", new_balance: "80000" }] };
      if (text.includes("fn_settle_position")) return { rows: [{ settled: true, new_balance: "130000" }] };
      // getBalance now resolves the spendable bucket (demo for marketers, else real) via
      // fn_is_marketer_account and aliases it `bal` (migration 0084).
      if (text.includes("fn_is_marketer_account")) return { rows: [{ bal: "5000" }] };
      return { rows: [] };
    },
  };
  const r = new PgGameRepository(fake);
  const o = await r.openPosition({ userId: "u", stakeCents: 20000, direction: "buy", entryRate: 0.21, durationS: 10, gameDayId: null, nonce: 7, openedAtMs: 1781778933000 , configVersion: 1});
  assert.deepEqual(o, { positionId: "p-1", newBalance: 80000 });
  assert.ok(calls[0]!.text.includes("fn_open_position"));
  assert.deepEqual(calls[0]!.params, ["u", 20000, "buy", 0.21, 10, null, 7, new Date(1781778933000).toISOString(), 1, null]);
  assert.ok(calls[0]!.text.includes("$8"), "open RPC must pass opened_at as the 8th arg (migration 0012)");
  assert.ok(calls[0]!.text.includes("$9"), "open RPC must pass config_version as the 9th arg (migration 0028)");
  assert.ok(calls[0]!.text.includes("$10"), "open RPC must pass site_id as the 10th arg (migration 0047, multi-tenant)");
  const s = await r.settlePosition({ positionId: "p-1", exitRate: 0.25, result: "win", multiplier: 2.5, payoutCents: 50000 });
  assert.deepEqual(s, { settled: true, newBalance: 130000 });
  assert.equal(await r.getBalance("u"), 5000);
});

test("InMemory repo: game-day commit is idempotent; reveal once; fairness hides seed pre-reveal", async () => {
  const r = new InMemoryGameRepository();
  const id1 = await r.ensureGameDay("2026-06-17", "hash17");
  const id2 = await r.ensureGameDay("2026-06-17", "hash17"); // idempotent — same id, hash unchanged
  assert.equal(id1, id2);

  // before reveal: commitment present, seed hidden
  const pre = await r.getFairness("2026-06-17");
  assert.ok(pre && pre.serverSeedHash === "hash17" && pre.serverSeed === null && pre.revealedAt === null);

  assert.equal(await r.revealSeed("2026-06-17", "seed17"), true);
  assert.equal(await r.revealSeed("2026-06-17", "seed17"), false); // already revealed -> no-op
  assert.equal(await r.revealSeed("2099-01-01", "x"), false);      // unknown day -> no-op

  // after reveal: seed exposed
  const post = await r.getFairness("2026-06-17");
  assert.ok(post && post.serverSeed === "seed17" && post.revealedAt !== null);
  assert.equal(await r.getFairness("2050-01-01"), null);           // unknown day
});

test("InMemory repo: listOpenPositions returns recovery metadata; excludes settled", async () => {
  const r = new InMemoryGameRepository();
  r.seed("u", 100000);
  const o = await r.openPosition({ userId: "u", stakeCents: 20000, direction: "sell", entryRate: 0.21, durationS: 10, gameDayId: 5, nonce: 3, openedAtMs: 1781778933000 , configVersion: 1});
  let open = await r.listOpenPositions();
  assert.equal(open.length, 1);
  assert.deepEqual(open[0], { id: o.positionId, userId: "u", stakeCents: 20000, direction: "sell", durationS: 10, openedAtMs: 1781778933000, entryRate: 0.21, gameDayId: 5, nonce: 3, configVersion: 1, siteId: null });
  await r.settlePosition({ positionId: o.positionId, exitRate: 0.1, result: "loss", multiplier: 0, payoutCents: 0 });
  open = await r.listOpenPositions();
  assert.equal(open.length, 0); // settled positions are not in the recovery work list
});

test("Pg repo: ensureGameDay/revealSeed/listOpenPositions/getFairness map to RPCs and v_fairness", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const fake: Querier = {
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes("fn_ensure_game_day")) return { rows: [{ id: "42" }] };
      if (text.includes("fn_reveal_game_day")) return { rows: [{ ok: true }] };
      if (text.includes("from positions")) return { rows: [{ id: "p-9", user_id: "u", stake: "20000", direction: "buy", duration_s: 10, opened_at: new Date(1781778933000), entry_rate: "0.21", game_day_id: "42", nonce: "3", config_version: "7" }] };
      if (text.includes("v_fairness")) return { rows: [{ id: "42", trade_date: "2026-06-17", server_seed_hash: "h", server_seed: null, revealed_at: null }] };
      return { rows: [] };
    },
  };
  const r = new PgGameRepository(fake);
  assert.equal(await r.ensureGameDay("2026-06-18", "h"), 42);
  assert.deepEqual(calls.at(-1)!.params, ["2026-06-18", "h", null]); // 3rd arg = site_id (0048)
  assert.equal(await r.revealSeed("2026-06-17", "seed"), true);
  assert.deepEqual(calls.at(-1)!.params, ["2026-06-17", "seed", null]); // 3rd arg = site_id (0048)
  const open = await r.listOpenPositions();
  assert.deepEqual(open[0], { id: "p-9", userId: "u", stakeCents: 20000, direction: "buy", durationS: 10, openedAtMs: 1781778933000, entryRate: 0.21, gameDayId: 42, nonce: 3, configVersion: 7, siteId: null });
  const f = await r.getFairness("2026-06-17");
  assert.ok(f && f.serverSeedHash === "h" && f.serverSeed === null && f.revealedAt === null);
});
