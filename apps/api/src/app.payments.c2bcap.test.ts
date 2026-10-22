import { test } from "node:test";
import assert from "node:assert/strict";
import { parseC2bConfirmation } from "./app.payments.js";

/**
 * C-1: the C2B Pay Bill confirmation rail has no provider re-query, so a forged confirmation that
 * slips the source-IP lock could store an unbounded amount for a player to claim. The parse layer
 * now caps it at the same ceiling as an authenticated deposit (KES 250,000 = 25,000,000 cents).
 */

test("parseC2bConfirmation accepts a normal deposit amount", () => {
  const c = parseC2bConfirmation({ TransID: "ABC123", TransAmount: 1500, MSISDN: "254700000000", BusinessShortCode: "625625" });
  assert.equal(c.transId, "ABC123");
  assert.equal(c.amountCents, 150000);
});

test("parseC2bConfirmation rejects an amount above the deposit cap", () => {
  // The exploit used KES 500,000 (50,000,000 cents); the historical "55.8M" attempt is far above.
  assert.throws(() => parseC2bConfirmation({ TransID: "HACK1", TransAmount: 500000, MSISDN: "254700000000" }),
    /maximum/i);
  assert.throws(() => parseC2bConfirmation({ TransID: "HACK2", TransAmount: 99999999 }), /maximum/i);
});

test("parseC2bConfirmation still rejects missing / non-positive amounts", () => {
  assert.throws(() => parseC2bConfirmation({ TransID: "X" }), /TransID\/TransAmount|missing/i);
  assert.throws(() => parseC2bConfirmation({ TransID: "X", TransAmount: 0 }), /invalid/i);
  assert.throws(() => parseC2bConfirmation({ TransID: "X", TransAmount: -5 }), /invalid/i);
});

test("the cap is exactly the authenticated-deposit ceiling (boundary)", () => {
  // 25,000,000 cents = KES 250,000 passes; one shilling more is rejected.
  assert.equal(parseC2bConfirmation({ TransID: "OK", TransAmount: 250000 }).amountCents, 25_000_000);
  assert.throws(() => parseC2bConfirmation({ TransID: "NO", TransAmount: 250000.01 }), /maximum/i);
});
