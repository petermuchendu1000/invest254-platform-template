import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, CATALOG, type Snapshot } from "./schema_drift.mts";

const empty = (): Snapshot => Object.fromEntries(Object.keys(CATALOG).map((k) => [k, {}]));

test("schema drift: identical catalogs -> no drift", () => {
  const a = empty(); a.function!["fn_x(uuid)"] = "h1"; a.policy!["wallets.sel_own"] = "p1";
  const b = empty(); b.function!["fn_x(uuid)"] = "h1"; b.policy!["wallets.sel_own"] = "p1";
  assert.deepEqual(diffSnapshots(a, b, {}), []);
});

test("schema drift: reports production-only, migrations-only and changed objects", () => {
  const prod = empty(), ref = empty();
  prod.function!["fn_old(uuid,bigint,text)"] = "h";                 // stale overload left in production
  ref.function!["fn_new(uuid)"] = "h";                              // migration never applied
  prod.policy!["wallets.sel_own"] = "no-site"; ref.policy!["wallets.sel_own"] = "with-site";   // clobbered
  prod["function-exec"]!["fn_x(uuid)"] = "true/true"; ref["function-exec"]!["fn_x(uuid)"] = "false/false";
  const items = diffSnapshots(prod, ref, {});
  assert.deepEqual(items.map((i) => `${i.change}:${i.kind}:${i.key}`).sort(), [
    "differs:function-exec:fn_x(uuid)",
    "differs:policy:wallets.sel_own",
    "only-migrations:function:fn_new(uuid)",
    "only-production:function:fn_old(uuid,bigint,text)",
  ]);
});

test("schema drift: justified known differences are not reported", () => {
  const prod = empty(), ref = empty();
  prod.function!["rls_auto_enable()"] = "h"; prod["function-exec"]!["rls_auto_enable()"] = "false/false";
  assert.deepEqual(diffSnapshots(prod, ref, { "function:rls_auto_enable()": "platform helper" }), []);
});
