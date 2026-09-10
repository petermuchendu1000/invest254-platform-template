import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGameRepository } from "./wallet.js";

const baseOpen = { direction: "buy" as const, durationS: 1, gameDayId: 1, configVersion: 1 };

test("listDigitHistory: settled digit receipt with the digit derived from the exit spot", async () => {
  const repo = new InMemoryGameRepository();
  repo.seed("u", 1_000_000);
  const open = await repo.openContract({
    ...baseOpen, userId: "u", stakeCents: 50_000, entryRate: 100.05, nonce: 1, openedAtMs: 1_000,
    kind: "digit", contract: { kind: "even", target: 0, instrumentId: "vol10", openIndex: 10, settleIndex: 11 },
  });
  await repo.settlePosition({ positionId: open.positionId, exitRate: 100.08, result: "win", multiplier: 0, payoutCents: 95_000 });
  // A rise/fall position must NOT show up in digit history.
  await repo.openPosition({ ...baseOpen, userId: "u", stakeCents: 5_000, entryRate: 100, durationS: 60, nonce: 2, openedAtMs: 2_000 });

  const page = await repo.listDigitHistory("u", { limit: 10 });
  assert.equal(page.items.length, 1);
  const r = page.items[0]!;
  assert.deepEqual(
    { kind: r.kind, target: r.target, instrumentId: r.instrumentId, openIndex: r.openIndex, settleIndex: r.settleIndex },
    { kind: "even", target: 0, instrumentId: "vol10", openIndex: 10, settleIndex: 11 },
  );
  assert.equal(r.stakeCents, 50_000);
  assert.equal(r.entryRate, 100.05);
  assert.equal(r.exitRate, 100.08);
  assert.equal(r.settleDigit, 8);        // last pip of the exit spot — correct for pool AND statistical
  assert.equal(r.payoutCents, 95_000);
  assert.equal(r.pnlCents, 45_000);
  assert.equal(r.result, "win");
  assert.equal(r.status, "settled");
});

test("listDigitHistory: an OPEN contract has null settle fields", async () => {
  const repo = new InMemoryGameRepository();
  repo.seed("u", 1_000_000);
  await repo.openContract({
    ...baseOpen, userId: "u", stakeCents: 20_000, entryRate: 50.03, nonce: 1, openedAtMs: 1_000,
    kind: "digit", contract: { kind: "matches", target: 7, instrumentId: "vol25", openIndex: 5, settleIndex: 6 },
  });
  const r = (await repo.listDigitHistory("u", { limit: 10 })).items[0]!;
  assert.equal(r.status, "open");
  assert.equal(r.exitRate, null);
  assert.equal(r.settleDigit, null);
  assert.equal(r.pnlCents, null);
  assert.equal(r.kind, "matches");
  assert.equal(r.target, 7);
});
