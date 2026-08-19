import { test } from "node:test";
import assert from "node:assert/strict";
import { SeededRng } from "./prng.js";
import { simulateActivity, simulateChat, makeUsername, activityMessage, CHAT_LINES, type ActivityKind } from "./activity.js";

const KINDS: ActivityKind[] = ["withdrawal", "win", "bonus", "signup"];

test("simulateActivity: deterministic for a given seed/label", () => {
  const a = simulateActivity(new SeededRng("seed-A", "activity"));
  const b = simulateActivity(new SeededRng("seed-A", "activity"));
  assert.deepEqual(a, b);
  const c = simulateActivity(new SeededRng("seed-B", "activity"));
  assert.notDeepEqual(a, c);
});

test("simulateActivity: valid kind, amount/message invariants across a large stream", () => {
  const rng = new SeededRng("stream", "activity");
  const seen = new Set<ActivityKind>();
  for (let i = 0; i < 2000; i++) {
    const e = simulateActivity(rng);
    seen.add(e.kind);
    assert.ok(KINDS.includes(e.kind), `bad kind ${e.kind}`);
    assert.ok(e.username.length > 0 && !e.username.includes(" "), `bad username ${e.username}`);
    assert.ok(e.message.includes(`@${e.username}`), "message must reference the handle");
    if (e.kind === "signup") {
      assert.equal(e.amountCents, null);
    } else {
      assert.ok(Number.isInteger(e.amountCents) && (e.amountCents as number) > 0, `bad amount ${e.amountCents}`);
    }
  }
  // weighted mix should produce every kind over 2000 draws
  for (const k of KINDS) assert.ok(seen.has(k), `kind ${k} never generated`);
});

test("makeUsername: synthetic, no spaces, reasonable length", () => {
  const rng = new SeededRng("u", "names");
  for (let i = 0; i < 500; i++) {
    const u = makeUsername(rng);
    assert.match(u, /^[a-z0-9._]+$/i);
    assert.ok(u.length >= 2 && u.length <= 24);
  }
});

test("activityMessage: formats KES and multiplier", () => {
  assert.match(activityMessage("withdrawal", "brian_254", 5_000_00), /@brian_254 cashed out KES 5,000 to M-Pesa/);
  assert.match(activityMessage("win", "njeri.ke", 1_250_00, 3.5), /@njeri\.ke just won KES 1,250 on a ×3\.50 trade/);
  assert.match(activityMessage("bonus", "mrkamau", 100_00), /BONUS of KES 100 issued to @mrkamau/);
  assert.equal(activityMessage("signup", "joy_7", null), "@joy_7 just joined Invest254");
});

test("simulateChat: deterministic, lines come from the pool", () => {
  const a = simulateChat(new SeededRng("c", "chat"));
  const b = simulateChat(new SeededRng("c", "chat"));
  assert.deepEqual(a, b);
  const rng = new SeededRng("c2", "chat");
  for (let i = 0; i < 1000; i++) {
    const m = simulateChat(rng);
    assert.ok(CHAT_LINES.includes(m.message), `unexpected chat line ${m.message}`);
    assert.ok(m.username.length > 0);
  }
});
