import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPaymentRepository, PgPaymentRepository } from "./payments.js";
import type { Querier } from "./wallet.js";

test("InMemory payments: deposit credits once; callback is idempotent", async () => {
  const r = new InMemoryPaymentRepository();
  r.seed("u", 100_000);
  const tx = await r.createDeposit("u", 5_000, "254712345678");
  assert.equal(await r.attachStk(tx, "mr", "co-1"), true);
  const c1 = await r.completeDeposit("co-1", 0, "OK", "RCPT", {});
  assert.deepEqual(c1, { applied: true, status: "success", newBalance: 105_000 });
  const c2 = await r.completeDeposit("co-1", 0, "OK", "RCPT", {});
  assert.equal(c2.applied, false); // idempotent
  assert.equal(await r.getBalance("u"), 105_000);
});

test("InMemory payments: failed deposit never credits", async () => {
  const r = new InMemoryPaymentRepository();
  r.seed("u", 100_000);
  const tx = await r.createDeposit("u", 5_000, "254712345678");
  await r.attachStk(tx, "mr", "co-2");
  const c = await r.completeDeposit("co-2", 1, "Cancelled", null, {});
  assert.deepEqual(c, { applied: true, status: "failed", newBalance: 100_000 });
});

test("InMemory payments: withdrawal hold -> approve -> success keeps debit", async () => {
  const r = new InMemoryPaymentRepository();
  r.seed("u", 100_000);
  const w = await r.createWithdrawal("u", 20_000, "254712345678", 20_000);
  assert.equal(w.newBalance, 80_000); // held
  const ap = await r.approveWithdrawal(w.txId, "admin");
  assert.deepEqual(ap, { approved: true, amountCents: 20_000, phone: "254712345678" });
  const c = await r.completeWithdrawal(w.txId, 0, "conv", "rcpt", {});
  assert.deepEqual(c, { applied: true, status: "success", newBalance: 80_000 });
  const c2 = await r.completeWithdrawal(w.txId, 0, "conv", "rcpt", {});
  assert.equal(c2.applied, false); // idempotent
});

test("InMemory payments: reject reverses the hold; double-reject is a no-op", async () => {
  const r = new InMemoryPaymentRepository();
  r.seed("u", 100_000);
  const w = await r.createWithdrawal("u", 30_000, "254712345678", 20_000);
  assert.equal(w.newBalance, 70_000);
  const rj = await r.rejectWithdrawal(w.txId, "admin");
  assert.deepEqual(rj, { reversed: true, newBalance: 100_000 });
  assert.equal((await r.rejectWithdrawal(w.txId, "admin")).reversed, false);
  // cannot approve a reversed withdrawal
  assert.equal((await r.approveWithdrawal(w.txId, "admin")).approved, false);
});

test("InMemory payments: B2C failure reverses the hold", async () => {
  const r = new InMemoryPaymentRepository();
  r.seed("u", 100_000);
  const w = await r.createWithdrawal("u", 25_000, "254712345678", 20_000);
  await r.approveWithdrawal(w.txId, "admin");
  const c = await r.completeWithdrawal(w.txId, 1, "conv", null, {});
  assert.deepEqual(c, { applied: true, status: "failed", newBalance: 100_000 });
});

test("InMemory payments: guards (insufficient funds, below min, no wallet)", async () => {
  const r = new InMemoryPaymentRepository();
  r.seed("u", 10_000);
  await assert.rejects(() => r.createWithdrawal("u", 20_000, "p", 20_000), /INSUFFICIENT_FUNDS/);
  await assert.rejects(() => r.createWithdrawal("u", 5_000, "p", 20_000), /BELOW_MIN/);
  await assert.rejects(() => r.createDeposit("ghost", 5_000, "p"), /WALLET_NOT_FOUND/);
  assert.equal(await r.getBalance("u"), 10_000); // unchanged
});

test("Pg payments: maps each method to the right RPC + params", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const fake: Querier = {
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes("fn_create_deposit")) return { rows: [{ id: "tx-d" }] };
      if (text.includes("fn_attach_stk")) return { rows: [{ ok: true }] };
      if (text.includes("fn_complete_deposit")) return { rows: [{ applied: true, status: "success", new_balance: "105000" }] };
      if (text.includes("fn_create_withdrawal")) return { rows: [{ tx_id: "tx-w", new_balance: "80000" }] };
      if (text.includes("fn_approve_withdrawal")) return { rows: [{ ok: true }] };
      if (text.includes("from transactions where id")) return { rows: [{ id: "tx-w", user_id: "u", kind: "withdrawal", amount: "20000", status: "processing", phone: "254712345678" }] };
      if (text.includes("fn_reject_withdrawal")) return { rows: [{ reversed: true, new_balance: "100000" }] };
      if (text.includes("fn_complete_withdrawal")) return { rows: [{ applied: true, status: "success", new_balance: "80000" }] };
      return { rows: [] };
    },
  };
  const r = new PgPaymentRepository(fake);
  assert.equal(await r.createDeposit("u", 5000, "254712345678"), "tx-d");
  assert.deepEqual(calls.at(-1)!.params, ["u", 5000, "254712345678", "00000000-0000-0000-0000-000000000001"]);
  await r.completeDeposit("co-1", 0, "OK", "RCPT", { a: 1 });
  assert.deepEqual(calls.at(-1)!.params, ["co-1", 0, "OK", "RCPT", JSON.stringify({ a: 1 })]);
  const w = await r.createWithdrawal("u", 20000, "254712345678", 20000);
  assert.deepEqual(w, { txId: "tx-w", newBalance: 80000 });
  const ap = await r.approveWithdrawal("tx-w", "admin");
  assert.deepEqual(ap, { approved: true, amountCents: 20000, phone: "254712345678" });
  const rj = await r.rejectWithdrawal("tx-w", "admin");
  assert.deepEqual(rj, { reversed: true, newBalance: 100000 });
});
