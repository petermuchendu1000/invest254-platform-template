import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PgPaymentRepository } from "./payments.js";

/**
 * `PgPaymentRepository.resolveDepositRefs` against REAL SQL (BUGLOG #163 part 2).
 *
 * The in-memory double is covered by paymentservice.payheroledger.test.ts, but mutation testing
 * showed that proves nothing about the query that actually runs in production: deleting the id-key
 * resolution from the Pg implementation killed no test at all. This closes that gap.
 *
 * What the query must get right:
 *   - a PayHero STK deposit resolves by `transactions.id` (its external_reference) to the DIFFERENT
 *     `checkout_request_id` that fn_complete_deposit looks up — the bug that minted 452 shadow rows;
 *   - Lipwa and Daraja still resolve by `checkout_request_id` (there it equals the id, or is a
 *     provider reference);
 *   - a foreign reference resolves to nothing;
 *   - a NON-UUID reference does not raise. PayHero's ledger is a shared account whose references
 *     include typed account numbers, so `id::text = any($1)` is deliberate and `any($1::uuid[])`
 *     would throw on the first such row and abort the whole sweep.
 *
 * E2E_PG_DSN only; everything is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;

test("resolveDepositRefs (real SQL): resolves both keys, ignores everything else", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const repo = new PgPaymentRepository({ query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) } as never);

    const STK = "44444444-0000-0000-0000-000000000001";      // external_reference = this id
    const LIPWA = "44444444-0000-0000-0000-000000000002";     // checkout_request_id = this id
    const WD = "44444444-0000-0000-0000-000000000003";
    const NOCO = "44444444-0000-0000-0000-000000000004";      // deposit with NO checkout id yet
    const U = "55555555-0000-0000-0000-000000000001";
    await c.query("insert into profiles (id, phone, username) values ($1,'254700000009','rr') on conflict do nothing", [U]);

    await c.query(
      // $2 is both the uuid id and the text checkout_request_id (that is exactly what Lipwa does),
      // so each use is cast explicitly — Postgres cannot deduce one type for both.
      `insert into transactions (id,user_id,kind,amount,status,provider,phone,checkout_request_id) values
         ($1::uuid,$5::uuid,'deposit',20000,'processing','payhero','254700000009','PAYHERO-REF-STK'),
         ($2::uuid,$5::uuid,'deposit',50000,'processing','payhero','',$2::text),
         ($3::uuid,$5::uuid,'withdrawal',10000,'pending','mpesa','254700000009','WITHDRAW-CO-REF'),
         ($4::uuid,$5::uuid,'deposit',30000,'pending','payhero','254700000009',null)`,
      [STK, LIPWA, WD, NOCO, U]);

    // ── Query ONE: ids only. Deliberately excludes every provider reference, so the SQL's id match
    // is the only thing that can resolve the STK deposit. Including 'PAYHERO-REF-STK' here would
    // return the same row via the checkout match and mask a broken id match entirely.
    const byId = await repo.resolveDepositRefs([STK, LIPWA, WD, NOCO, "someone-elses-ref", "johndoe", "LD-not-a-uuid"]);
    assert.equal(byId.get(STK), "PAYHERO-REF-STK",
      "an STK deposit must resolve by its ID to the DIFFERENT checkout_request_id — this is the whole bug");
    assert.equal(byId.get(LIPWA), LIPWA, "Lipwa: reference IS the checkout_request_id");
    assert.equal(byId.has(WD), false, "a withdrawal is never a deposit reference");
    assert.equal(byId.has(NOCO), false, "a deposit with no checkout_request_id cannot be completed by one");
    assert.equal(byId.has("someone-elses-ref"), false);
    assert.equal(byId.has("johndoe"), false);
    assert.equal(byId.has("LD-not-a-uuid"), false);
    assert.equal(byId.size, 2, "exactly the two deposits we own");

    // ── Query TWO: provider references only, so the checkout match is the only thing that can
    // resolve them. This is the Daraja/MegaPay/STK shape, where the reference is NOT the id.
    const byCheckout = await repo.resolveDepositRefs(["PAYHERO-REF-STK", "WITHDRAW-CO-REF", "no-such-ref"]);
    assert.equal(byCheckout.get("PAYHERO-REF-STK"), "PAYHERO-REF-STK", "a provider reference resolves to itself");
    assert.equal(byCheckout.has("WITHDRAW-CO-REF"), false,
      "a withdrawal's checkout reference is excluded by kind='deposit', not by the null check");
    assert.equal(byCheckout.size, 1);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
});

test("resolveDepositRefs (real SQL): a non-UUID reference cannot abort the sweep", { skip: !DSN }, async () => {
  /**
   * The failure this pins is catastrophic rather than subtle: casting the INPUT (`any($1::uuid[])`)
   * raises `invalid input syntax for type uuid` on the first typed account number, which would take
   * down the whole ledger sweep for every payment in the page, not just that row.
   */
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const repo = new PgPaymentRepository({ query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) } as never);
    const got = await repo.resolveDepositRefs(["johndoe", "", "LD-xx", "7719580265", "not-a-uuid-at-all"]);
    assert.equal(got.size, 0);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
});

test("resolveDepositRefs (real SQL): an empty batch does not query at all", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    const repo = new PgPaymentRepository({ query: async () => { throw new Error("must not query"); } } as never);
    assert.equal((await repo.resolveDepositRefs([])).size, 0);
  } finally { c.release(); await pool.end(); }
});
