import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

/**
 * 0216's trigger against REAL SQL.
 *
 * This is SQL-only behaviour — there is no TypeScript to unit-test. The in-memory repository does
 * not mirror it and deliberately so: the whole point of promoting the code is that it happens on
 * whichever of the two writes lands second, and the in-memory double has no such race to model.
 * Following the precedent in payments.resolverefs.pg.test.ts, a double here would prove nothing
 * about what runs in production.
 *
 * THE REAL PAYLOAD. Captured in production on 2026-10-24 — the codes nest under "response", not at
 * the top level, which is why a first attempt at reading provider_callback->>'ResultCode' saw only
 * nulls:
 *   {"status":true,"response":{"ResultCode":2035,"ResultDesc":"The customer does not exist.", ...}}
 *
 * What the trigger must get right:
 *   - promote under BOTH orderings (callback-then-settle, and settle-then-callback), because
 *     fn_complete_deposit overwrites result_desc wholesale and would otherwise erase it;
 *   - append exactly once, however many times the row is updated afterwards;
 *   - read the top-level shape too, which is how the provider's dashboard renders it;
 *   - never touch a withdrawal, a deposit with no callback, or any money column.
 *
 * E2E_PG_DSN only; everything is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;

/** The exact production payload shape, trimmed to the fields the trigger reads. */
const NESTED = {
  status: true,
  response: {
    Phone: "0749314456", Status: "Failed", ChannelID: 12226,
    ResultCode: 2035, ResultDesc: "The customer does not exist.",
    CheckoutRequestID: "ws_CO_PROMOTE_A", ExternalReference: "ext-A", MpesaReceiptNumber: "",
  },
};
/** The shape the provider dashboard shows, with the codes at the top level. */
const FLAT = { CheckoutRequestID: "ws_CO_PROMOTE_D", ResultCode: "2028", ResultDesc: "The request is not permitted according to product assignment." };

test("0216 (real SQL): the provider's reason is promoted into result_desc, once, under both orderings",
  { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const U = "55555555-0000-0000-0000-000000000002";
    await c.query("insert into profiles (id, phone, username) values ($1,'254700000008','pr') on conflict do nothing", [U]);

    const mk = async (id: string, co: string, cb: unknown | null) =>
      c.query(`insert into transactions (id,user_id,kind,amount,status,provider,phone,checkout_request_id,provider_callback)
                 values ($1::uuid,$2::uuid,'deposit',31100,'processing','payhero','0749314456',$3,$4::jsonb)`,
        [id, U, co, cb === null ? null : JSON.stringify(cb)]);
    const settle = async (id: string) =>
      c.query("update transactions set status='failed', result_code=1, result_desc='reconciled:payhero:1 FAILED' where id=$1::uuid", [id]);
    const desc = async (id: string): Promise<string> =>
      (await c.query("select result_desc from transactions where id=$1::uuid", [id])).rows[0].result_desc;

    const A = "66666666-0000-0000-0000-000000000001";   // callback first, then settle
    const B = "66666666-0000-0000-0000-000000000002";   // settle first, then callback
    const C = "66666666-0000-0000-0000-000000000003";   // no callback at all
    const D = "66666666-0000-0000-0000-000000000004";   // top-level (dashboard) shape
    const W = "66666666-0000-0000-0000-000000000005";   // a withdrawal

    // ── ORDER 1: the clobber-prone one. fn_complete_deposit rewrites result_desc wholesale, so a
    // value written at callback time would be lost without the trigger firing on the settle.
    await mk(A, "refA", NESTED);
    await settle(A);
    assert.match(await desc(A), /saf=2035 The customer does not exist\./,
      "callback-then-settle: the settle must carry the code through, not erase it");

    // ── ORDER 2: the callback lands after the row is already terminal.
    await mk(B, "refB", null);
    await settle(B);
    assert.equal(await desc(B), "reconciled:payhero:1 FAILED", "nothing to promote yet");
    await c.query("select fn_record_provider_callback('refB', $1::jsonb)", [JSON.stringify(NESTED)]);
    assert.match(await desc(B), /saf=2035/, "settle-then-callback: the callback write must promote it");

    // ── IDEMPOTENCE. The guard is load-bearing: without it a row accumulates the code on every
    // update, and this table is updated often.
    const once = await desc(A);
    await c.query("update transactions set result_code=1 where id=$1::uuid", [A]);
    await c.query("update transactions set status='failed' where id=$1::uuid", [A]);
    assert.equal(await desc(A), once, "appended exactly once, however many updates follow");
    assert.equal((once.match(/saf=/g) ?? []).length, 1);

    // ── The dashboard shape, where the codes sit at the top level.
    await mk(D, "refD", FLAT);
    await settle(D);
    assert.match(await desc(D), /saf=2028 The request is not permitted according to product assignment\./,
      "a top-level ResultCode must be read too — this is the 2028 that started the investigation");

    // ── A deposit with no callback is left exactly as it was.
    await mk(C, "refC", null);
    await settle(C);
    assert.equal(await desc(C), "reconciled:payhero:1 FAILED", "no callback => no change");

    // ── MONEY SAFETY. The trigger assigns to result_desc and nothing else.
    const row = (await c.query(
      "select status, amount, result_code, mpesa_receipt, raw_callback from transactions where id=$1::uuid", [A])).rows[0];
    assert.equal(row.status, "failed");
    assert.equal(String(row.amount), "31100");
    assert.equal(row.result_code, 1);
    assert.equal(row.mpesa_receipt, null);

    // ── A withdrawal is never touched, even carrying an identical payload.
    await c.query(`insert into transactions (id,user_id,kind,amount,status,provider,phone,provider_callback)
                     values ($1::uuid,$2::uuid,'withdrawal',10000,'pending','payhero','0749314456',$3::jsonb)`,
      [W, U, JSON.stringify(NESTED)]);
    await c.query("update transactions set status='failed', result_desc='b2c failed' where id=$1::uuid", [W]);
    assert.equal(await desc(W), "b2c failed", "kind='deposit' in the WHEN clause must exclude payouts");

    // ── The cap. result_desc is unbounded text and fn_complete_deposit does not truncate.
    const LONG = "66666666-0000-0000-0000-000000000006";
    await mk(LONG, "refLong", { response: { ResultCode: 9, ResultDesc: "x".repeat(500) } });
    await settle(LONG);
    assert.equal((await desc(LONG)).length, 200, "capped at 200 chars");
  } finally {
    await c.query("rollback");
    c.release();
    await pool.end();
  }
});
