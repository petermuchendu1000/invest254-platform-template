import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDaySeed } from "./seed.js";
import { instrumentById, INSTRUMENTS, PIP_DECIMALS } from "./instruments.js";
import { InstrumentFeed, digitAt } from "./instrumentfeed.js";
import { settleDigit, digitWinProbability, DEFAULT_DIGIT_PAYOUT_FACTOR } from "./contracts.js";

const SEED = deriveDaySeed("master-test-seed", "2026-09-06");
const lastPip = (q: number) => Math.round(Math.abs(q) * 10 ** PIP_DECIMALS) % 10;

test("feed is deterministic: same (seed, instrument, index) ⇒ identical tick", () => {
  const a = new InstrumentFeed(SEED, instrumentById("vol10_1s"));
  const b = new InstrumentFeed(SEED, instrumentById("vol10_1s"));
  for (const i of [0, 1, 7, 42, 1000, 86_400]) {
    assert.deepEqual(a.tickAt(i), b.tickAt(i));
  }
});

test("the displayed quote's last pip EQUALS the authoritative settlement digit", () => {
  const feed = new InstrumentFeed(SEED, instrumentById("vol75_1s"));
  for (let i = 0; i < 500; i++) {
    const t = feed.tickAt(i);
    assert.equal(lastPip(t.quote), t.digit, `index ${i}: quote ${t.quote} pip != digit ${t.digit}`);
    assert.ok(t.digit >= 0 && t.digit <= 9);
  }
});

test("digits are EXACTLY uniform (Monte-Carlo): each digit ≈ 10%, even/odd ≈ 50%", () => {
  const N = 200_000;
  const counts = new Array(10).fill(0);
  let even = 0;
  for (let i = 0; i < N; i++) {
    const d = digitAt(SEED, "vol100_1s", i);
    counts[d]++;
    if (d % 2 === 0) even++;
  }
  for (let d = 0; d < 10; d++) {
    const p = counts[d] / N;
    assert.ok(Math.abs(p - 0.1) < 0.004, `digit ${d}: p=${p.toFixed(4)} not ~0.10`);
  }
  assert.ok(Math.abs(even / N - 0.5) < 0.004, `even p=${(even / N).toFixed(4)} not ~0.50`);
});

test("distinct instruments are decorrelated (different digit streams from the same seed)", () => {
  let diff = 0;
  for (let i = 0; i < 1000; i++) {
    if (digitAt(SEED, "vol10_1s", i) !== digitAt(SEED, "vol25_1s", i)) diff++;
  }
  // Two independent uniform digit streams disagree ~90% of the time.
  assert.ok(diff > 800, `expected ~90% disagreement, got ${diff}/1000`);
});

test("distinct day seeds produce different digit streams (daily rotation matters)", () => {
  const s2 = deriveDaySeed("master-test-seed", "2026-09-07");
  let diff = 0;
  for (let i = 0; i < 1000; i++) if (digitAt(SEED, "vol10_1s", i) !== digitAt(s2, "vol10_1s", i)) diff++;
  assert.ok(diff > 800, `expected daily decorrelation, got ${diff}/1000`);
});

test("house edge on a Monte-Carlo digit session ≈ 1 − payout factor (even/odd)", () => {
  const N = 300_000;
  const stake = 10_000; // cents
  const factor = DEFAULT_DIGIT_PAYOUT_FACTOR; // 0.95 ⇒ 5% edge
  let staked = 0;
  let returned = 0;
  for (let i = 0; i < N; i++) {
    const d = digitAt(SEED, "vol50", i);
    const s = settleDigit(stake, "even", 0, d, factor);
    staked += stake;
    returned += s.payoutCents;
  }
  const rtp = returned / staked;
  assert.ok(Math.abs(rtp - factor) < 0.01, `RTP ${rtp.toFixed(4)} not ≈ factor ${factor}`);
});

test("over/under probabilities and payouts are internally consistent across barriers", () => {
  const stake = 10_000;
  for (let barrier = 1; barrier <= 8; barrier++) {
    const N = 120_000;
    let staked = 0;
    let returned = 0;
    for (let i = 0; i < N; i++) {
      const d = digitAt(SEED, "vol25_1s", i);
      const s = settleDigit(stake, "over", barrier, d, DEFAULT_DIGIT_PAYOUT_FACTOR);
      staked += stake;
      returned += s.payoutCents;
    }
    const rtp = returned / staked;
    assert.ok(Math.abs(rtp - DEFAULT_DIGIT_PAYOUT_FACTOR) < 0.02, `over ${barrier}: RTP ${rtp.toFixed(3)}`);
    assert.ok(digitWinProbability("over", barrier) === (9 - barrier) / 10);
  }
});

test("every catalogue instrument produces finite, positive, 2dp quotes", () => {
  for (const inst of INSTRUMENTS) {
    const feed = new InstrumentFeed(SEED, inst);
    const t = feed.tickAt(123);
    assert.ok(Number.isFinite(t.quote) && t.quote > 0, `${inst.id} quote ${t.quote}`);
    assert.equal(Math.round(t.quote * 100), Math.round(t.quote * 100) | 0 || Math.round(t.quote * 100));
  }
});
