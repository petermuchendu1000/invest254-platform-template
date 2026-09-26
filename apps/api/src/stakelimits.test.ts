import { test } from "node:test";
import assert from "node:assert/strict";
import { enforcedCents, validateNative } from "./stakelimits.js";

test("validate: multiples of 5, min >= 5, max >= min", () => {
  assert.deepEqual(validateNative(5, 1000), { min: 5, max: 1000 });
  assert.deepEqual(validateNative("250", "50000"), { min: 250, max: 50000 });
  for (const [a, b] of [[4, 100], [7, 100], [5, 12], [50, 45], ["x", 10], [5, 2e9]] as const) assert.equal(typeof validateNative(a, b), "string", `${a}/${b}`);
});

test("KES brands: exact cents", () => {
  assert.deepEqual(enforcedCents(250, 50000, "KES", 1), { minCents: 25000, maxCents: 5000000 });
});

test("USD: 10% FX margin; $5 stays accepted after a 9% move either way", () => {
  const rate = 0.0077226;
  const c = enforcedCents(5, 1000, "USD", rate)!;
  assert.equal(c.minCents, Math.floor((5 / rate) * 100 * 0.9));
  for (const r of [rate * 0.91, rate * 1.09]) {
    const fiveDollars = Math.round((5 / r) * 100);
    const thousand = Math.round((1000 / r) * 100);
    assert.ok(fiveDollars >= c.minCents && thousand <= c.maxCents, `rate ${r}`);
  }
  assert.equal(enforcedCents(5, 10, "USD", 0), null);
});
