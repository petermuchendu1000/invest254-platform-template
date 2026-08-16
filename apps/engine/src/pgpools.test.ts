import { test } from "node:test";
import assert from "node:assert/strict";
import { toTransactionPooler } from "./pgpools.js";

// The split-pool fix (docs/25 Phase 5) hinges on rewriting the Supabase SESSION pooler URL (:5432)
// to the TRANSACTION pooler (:6543). These guard that rewrite — and that non-Supabase / direct
// connections are left untouched (no safe port to infer).

test("toTransactionPooler swaps :5432 to :6543 on the Supabase pooler host", () => {
  const session = "postgresql://user.ref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
  const out = toTransactionPooler(session);
  assert.ok(out.includes(":6543/"), `expected :6543 in ${out}`);
  assert.ok(!out.includes(":5432/"), `expected no :5432 in ${out}`);
  assert.ok(out.includes("aws-0-eu-west-1.pooler.supabase.com"), "host preserved");
});

test("toTransactionPooler is a no-op for a non-pooler (direct) host", () => {
  const direct = "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres";
  assert.equal(toTransactionPooler(direct), direct);
});

test("toTransactionPooler leaves an already-6543 pooler URL on 6543", () => {
  const txn = "postgresql://user.ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
  assert.ok(toTransactionPooler(txn).includes(":6543/"));
});

test("toTransactionPooler tolerates a malformed URL by returning it unchanged", () => {
  const bad = "not a url";
  assert.equal(toTransactionPooler(bad), bad);
});
