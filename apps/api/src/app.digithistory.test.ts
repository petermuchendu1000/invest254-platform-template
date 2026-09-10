import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER } from "./testutil.js";

const baseOpen = { direction: "buy" as const, durationS: 1, gameDayId: 1, configVersion: 1 };

test("GET /digits/history → persisted receipts for the caller", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const open = await api.gameRepo.openContract({
      ...baseOpen, userId: TEST_USER, stakeCents: 50_000, entryRate: 100.05, nonce: 1, openedAtMs: Date.now(),
      kind: "digit", contract: { kind: "over", target: 3, instrumentId: "vol10", openIndex: 10, settleIndex: 11 },
    });
    await api.gameRepo.settlePosition({ positionId: open.positionId, exitRate: 100.07, result: "win", multiplier: 0, payoutCents: 79_000 });

    const res = await fetch(`${api.baseUrl}/api/v1/digits/history`, { headers: { authorization: `Bearer ${TEST_USER}` } });
    assert.equal(res.status, 200);
    const body = await res.json() as { items: any[] };
    assert.equal(body.items.length, 1);
    const r = body.items[0];
    assert.equal(r.kind, "over");
    assert.equal(r.target, 3);
    assert.equal(r.stakeCents, 50_000);
    assert.equal(r.entryRate, 100.05);
    assert.equal(r.exitRate, 100.07);
    assert.equal(r.settleDigit, 7);
    assert.equal(r.payoutCents, 79_000);
    assert.equal(r.result, "win");
    assert.equal(r.status, "settled");
    assert.equal(r.openIndex, 10);
    assert.equal(r.settleIndex, 11);
  } finally { await api.close(); }
});

test("GET /digits/history requires auth", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await fetch(`${api.baseUrl}/api/v1/digits/history`)).status, 401);
  } finally { await api.close(); }
});
