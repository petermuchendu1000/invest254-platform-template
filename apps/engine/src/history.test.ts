import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGameRepository, PgGameRepository, type Querier } from "./wallet.js";
import { InMemoryPaymentRepository, PgPaymentRepository } from "./payments.js";
import { encodeCursor, decodeCursor } from "./paging.js";

// ─────────────────────────── in-memory: ledger ───────────────────────────

test("InMemory listLedger: newest-first, cursor pagination", async () => {
  const r = new InMemoryGameRepository();
  r.seed("u", 100_000);                       // ledger #1 (seed)
  const o = await r.openPosition({ userId: "u", stakeCents: 20_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 1, openedAtMs: 0 , configVersion: 1}); // #2 (stake)
  await r.settlePosition({ positionId: o.positionId, exitRate: 0.25, result: "win", multiplier: 2.5, payoutCents: 50_000 });                                       // #3 (payout)

  const p1 = await r.listLedger("u", { limit: 2 });
  assert.deepEqual(p1.items.map((l) => l.type), ["payout", "stake"]);   // newest first
  assert.equal(p1.items[0]!.amountCents, 50_000);
  assert.equal(p1.items[1]!.amountCents, -20_000);
  assert.ok(p1.nextCursor);

  const p2 = await r.listLedger("u", { limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.items.map((l) => l.type), ["seed"]);
  assert.equal(p2.nextCursor, null);

  assert.deepEqual((await r.listLedger("other", {})).items, []);        // per-user isolation
});

// ─────────────────────────── in-memory: positions ───────────────────────────

test("InMemory listPositions: status filter + newest-first", async () => {
  const r = new InMemoryGameRepository();
  r.seed("u", 1_000_000);
  const a = await r.openPosition({ userId: "u", stakeCents: 20_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 1, openedAtMs: 10 , configVersion: 1});
  const b = await r.openPosition({ userId: "u", stakeCents: 30_000, direction: "sell", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 2, openedAtMs: 20 , configVersion: 1});
  await r.settlePosition({ positionId: a.positionId, exitRate: 0.25, result: "win", multiplier: 2, payoutCents: 40_000 });

  const all = await r.listPositions("u", {});
  assert.deepEqual(all.items.map((p) => p.id), [b.positionId, a.positionId]); // newest (higher seq) first

  const open = await r.listPositions("u", { status: "open" });
  assert.deepEqual(open.items.map((p) => p.id), [b.positionId]);

  const settled = await r.listPositions("u", { status: "settled" });
  assert.equal(settled.items.length, 1);
  assert.equal(settled.items[0]!.id, a.positionId);
  assert.equal(settled.items[0]!.result, "win");
  assert.equal(settled.items[0]!.payoutCents, 40_000);
  assert.equal(settled.items[0]!.pnlCents, 20_000);
  assert.equal(settled.items[0]!.exitRate, 0.25);
});

test("InMemory getPositionDetail: includes fairness (seed hidden pre-reveal); null when unknown/unowned", async () => {
  const r = new InMemoryGameRepository();
  r.seed("u", 1_000_000);
  const dayId = await r.ensureGameDay("2026-06-17", "h17");
  const o = await r.openPosition({ userId: "u", stakeCents: 20_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: dayId, nonce: 1, openedAtMs: 0 , configVersion: 1});

  const pre = await r.getPositionDetail("u", o.positionId);
  assert.ok(pre);
  assert.equal(pre!.fairness?.serverSeedHash, "h17");
  assert.equal(pre!.fairness?.serverSeed, null);              // not revealed

  await r.revealSeed("2026-06-17", "s17");
  const post = await r.getPositionDetail("u", o.positionId);
  assert.equal(post!.fairness?.serverSeed, "s17");

  assert.equal(await r.getPositionDetail("u", "missing"), null);          // unknown
  assert.equal(await r.getPositionDetail("intruder", o.positionId), null); // not owned
});

// ─────────────────────────── in-memory: transactions ───────────────────────────

test("InMemory listTransactions: kind/status filters + newest-first + receipt", async () => {
  const r = new InMemoryPaymentRepository();
  r.seed("u", 1_000_000);
  const dep = await r.createDeposit("u", 50_000, "254712345678");
  await r.attachStk(dep, "m1", "co1");
  await r.completeDeposit("co1", 0, "ok", "RCPT1", {});
  await r.createWithdrawal("u", 30_000, "254712345678", 20_000);

  const all = await r.listTransactions("u", {});
  assert.deepEqual(all.items.map((t) => t.kind), ["withdrawal", "deposit"]); // newest first
  const deposit = all.items.find((t) => t.kind === "deposit")!;
  assert.equal(deposit.status, "success");
  assert.equal(deposit.mpesaReceipt, "RCPT1");

  assert.equal((await r.listTransactions("u", { kind: "deposit" })).items.length, 1);
  assert.equal((await r.listTransactions("u", { status: "pending" })).items.length, 1); // only the withdrawal
  const page = await r.listTransactions("u", { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
});

// ─────────────────────────── Pg: SQL + param mapping ───────────────────────────

test("Pg listLedger: keyset params + bigint/date mapping + nextCursor", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const fake: Querier = {
    async query(text, params) {
      calls.push({ text, params });
      // return limit+1 (=3) rows so a nextCursor is produced for limit=2
      return { rows: [
        { id: "30", type: "payout", amount: "50000", balance_kind: "real", ref_table: "positions", ref_id: "p3", meta: null, created_at: new Date(3000) },
        { id: "20", type: "stake", amount: "-20000", balance_kind: "real", ref_table: "positions", ref_id: "p2", meta: null, created_at: new Date(2000) },
        { id: "10", type: "seed", amount: "100000", balance_kind: "real", ref_table: null, ref_id: "seed", meta: null, created_at: new Date(1000) },
      ] };
    },
  };
  const r = new PgGameRepository(fake);
  const page = await r.listLedger("u", { limit: 2 });
  assert.ok(calls[0]!.text.includes("from ledger_entries"));
  assert.deepEqual(calls[0]!.params, ["u", null, null, 3, null]);           // cursor null → first page, limit+1; $5 site = null (no filter)
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0]!.amountCents, 50000);
  assert.equal(page.items[0]!.createdAtMs, 3000);
  // nextCursor encodes the last KEPT row (id 20 @ 2000ms)
  assert.equal(decodeCursor(page.nextCursor), "2000:20");

  // second page: cursor decodes into keyset params $2 (ISO ts) and $3 (id)
  await r.listLedger("u", { limit: 2, cursor: encodeCursor("2000:20") });
  assert.deepEqual(calls[1]!.params, ["u", new Date(2000).toISOString(), "20", 3, null]);
});

test("Pg listPositions: status filter param + numeric coercion", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const fake: Querier = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [
        { id: "p1", user_id: "u", game_day_id: "7", direction: "buy", stake: "20000", entry_rate: "0.21",
          exit_rate: "0.25", multiplier: "2.5", payout: "50000", pnl: "30000", result: "win",
          duration_s: 10, status: "settled", opened_at: new Date(5000), settled_at: new Date(6000) },
      ] };
    },
  };
  const r = new PgGameRepository(fake);
  const page = await r.listPositions("u", { status: "settled", limit: 50 });
  assert.ok(calls[0]!.text.includes("from positions"));
  assert.deepEqual(calls[0]!.params, ["u", "settled", null, null, 51, null]);  // $6 site = null (no filter)
  const p = page.items[0]!;
  assert.equal(p.gameDayId, 7);
  assert.equal(p.entryRate, 0.21);
  assert.equal(p.exitRate, 0.25);
  assert.equal(p.multiplier, 2.5);
  assert.equal(p.payoutCents, 50000);
  assert.equal(p.pnlCents, 30000);
  assert.equal(p.settledAtMs, 6000);
  assert.equal(page.nextCursor, null);
});

test("Pg getPositionDetail: joins v_fairness; null when missing", async () => {
  const fake: Querier = {
    async query(text) {
      if (text.includes("left join v_fairness")) {
        return { rows: [{
          id: "p1", user_id: "u", game_day_id: "7", direction: "buy", stake: "20000", entry_rate: "0.21",
          exit_rate: null, multiplier: null, payout: null, pnl: null, result: null,
          duration_s: 10, status: "open", opened_at: new Date(5000), settled_at: null,
          f_id: "7", f_trade_date: "2026-06-17", f_hash: "h", f_seed: null, f_revealed: null,
        }] };
      }
      return { rows: [] };
    },
  };
  const r = new PgGameRepository(fake);
  const d = await r.getPositionDetail("u", "p1");
  assert.ok(d);
  assert.equal(d!.status, "open");
  assert.equal(d!.fairness?.gameDayId, 7);
  assert.equal(d!.fairness?.serverSeedHash, "h");
  assert.equal(d!.fairness?.serverSeed, null);

  const none = new PgGameRepository({ async query() { return { rows: [] }; } });
  assert.equal(await none.getPositionDetail("u", "missing"), null);
});

test("Pg listTransactions: kind/status filter params + mapping", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const fake: Querier = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [
        { id: "t1", kind: "withdrawal", amount: "30000", status: "success", provider: "mpesa", phone: "254712345678", mpesa_receipt: "R1", created_at: new Date(9000) },
      ] };
    },
  };
  const r = new PgPaymentRepository(fake);
  const page = await r.listTransactions("u", { kind: "withdrawal", status: "success", limit: 10 });
  assert.ok(calls[0]!.text.includes("from transactions"));
  assert.deepEqual(calls[0]!.params, ["u", "withdrawal", "success", null, null, 11, null]);  // $7 site = null (no filter)
  assert.equal(page.items[0]!.amountCents, 30000);
  assert.equal(page.items[0]!.mpesaReceipt, "R1");
  assert.equal(page.items[0]!.createdAtMs, 9000);
});
