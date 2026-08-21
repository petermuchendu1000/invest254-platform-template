import { test } from "node:test";
import assert from "node:assert/strict";
import {
  variableRatioMultiplier, winMultiplier, solveTruncExpBeta, isNearMiss, isLossDisguisedAsWin, presentOutcome,
  DEFAULT_WIN_SPREAD,
} from "./engagement.js";
import { SeededRng } from "./prng.js";

function sampleMean(meanMult: number, cap: number, n = 200_000): { mean: number; min: number; max: number; overCap: number; below: number } {
  let sum = 0, mn = Infinity, mx = -Infinity, over = 0, below = 0;
  for (let i = 0; i < n; i++) {
    const m = winMultiplier(new SeededRng("me-seed", `engage:${i}`), meanMult, cap);
    sum += m; mn = Math.min(mn, m); mx = Math.max(mx, m);
    if (m > cap + 1e-9) over++;
    if (m < 1.01 - 1e-9) below++;
  }
  return { mean: sum / n, min: mn, max: mx, overCap: over, below };
}

test("winMultiplier: mean is pinned to meanMult (RTP-exact) across configs", () => {
  for (const [mu, cap] of [[2, 5], [3, 30], [1.2, 5], [4.9, 5], [15.5, 30]] as [number, number][]) {
    const { mean } = sampleMean(mu, cap);
    assert.ok(Math.abs(mean - mu) / mu < 0.01, `mean ${mean} drifted from ${mu} (cap ${cap})`);
  }
});

test("winMultiplier: RTP is preserved (winRate × mean == RTP)", () => {
  // Live-like: house edge 0.85 (RTP 0.15), win rate 0.05 ⇒ meanMult 3.0.
  const winRate = 0.05, rtpTarget = 0.15, meanMult = rtpTarget / winRate; // 3.0
  const { mean } = sampleMean(meanMult, 30);
  const realizedRtp = winRate * mean;
  assert.ok(Math.abs(realizedRtp - rtpTarget) / rtpTarget < 0.01, `realized RTP ${realizedRtp} vs ${rtpTarget}`);
});

test("winMultiplier: uses the FULL configured range — rare wins approach the cap", () => {
  // With mean 3 and cap 30, a genuine heavy tail exists (old two-band mixture capped near ×5.7).
  const cap = 30;
  let overTen = 0, overTwenty = 0, mx = 0;
  const N = 200_000;
  for (let i = 0; i < N; i++) {
    const m = winMultiplier(new SeededRng("tail", `engage:${i}`), 3, cap);
    if (m > 10) overTen++;
    if (m > 20) overTwenty++;
    mx = Math.max(mx, m);
  }
  assert.ok(overTen / N > 0.003, `expected a tail past ×10, got ${(overTen / N).toFixed(4)}`);
  assert.ok(overTwenty > 0, "expected at least one win past ×20");
  assert.ok(mx > 15, `expected the max observed win to approach the cap, got ${mx.toFixed(2)}`);
  assert.ok(mx <= cap + 1e-9, `never exceeds the cap, got ${mx}`);
});

test("winMultiplier: bounds, determinism, and degenerate ends", () => {
  // bounds + determinism
  const a = winMultiplier(new SeededRng("s", "engage:7"), 3, 30);
  const b = winMultiplier(new SeededRng("s", "engage:7"), 3, 30);
  assert.equal(a, b);
  for (let i = 0; i < 2000; i++) {
    const m = winMultiplier(new SeededRng("s", `engage:${i}`), 3, 30);
    assert.ok(m >= 1.01 - 1e-9 && m <= 30 + 1e-9, `out of bounds: ${m}`);
  }
  // mean at/above cap ⇒ point mass at the cap
  assert.equal(winMultiplier(new SeededRng("s", "engage:1"), 30, 30), 30);
  assert.equal(winMultiplier(new SeededRng("s", "engage:1"), 40, 30), 30);
  // mean at/below the floor ⇒ near break-even pass-through
  assert.ok(winMultiplier(new SeededRng("s", "engage:1"), 1.0, 30) <= 1.01);
});

test("winMultiplier: most wins are small when the mean sits low in the range", () => {
  const N = 100_000; let small = 0, big = 0;
  for (let i = 0; i < N; i++) {
    const m = winMultiplier(new SeededRng("sm", `engage:${i}`), 3, 30);
    if (m < 3) small++;
    if (m > 6) big++;
  }
  assert.ok(small / N > 0.5, `expected majority small wins, got ${small / N}`);
  assert.ok(big / N > 0.01, `expected a meaningful big-win tail, got ${big / N}`);
});

test("solveTruncExpBeta: recovers the requested mean on the interval", () => {
  // truncExpMean(beta) must equal the target mean; verify via a direct Monte-Carlo of the sampler.
  for (const [mu, a, b] of [[3, 1.01, 30], [2, 1.01, 5], [15.5, 1.01, 30]] as [number, number, number][]) {
    const beta = solveTruncExpBeta(mu, a, b);
    // midpoint target ⇒ ~uniform ⇒ beta ~ 0
    if (Math.abs(mu - (a + b) / 2) < 1e-6) assert.ok(Math.abs(beta) < 1e-6, `expected beta~0, got ${beta}`);
    let sum = 0; const n = 100_000;
    for (let i = 0; i < n; i++) sum += winMultiplier(new SeededRng("beta", `engage:${i}`), mu, b);
    assert.ok(Math.abs(sum / n - mu) / mu < 0.01, `sampler mean ${sum / n} vs ${mu}`);
  }
});

test("variableRatioMultiplier: back-compat wrapper still preserves the mean", () => {
  const meanMult = 2.0, maxMult = 5.0, N = 100_000; let sum = 0;
  for (let i = 0; i < N; i++) sum += variableRatioMultiplier(new SeededRng("bc", `engage:${i}`), meanMult, maxMult);
  assert.ok(Math.abs(sum / N - meanMult) / meanMult < 0.01, `mean ${sum / N} drifted from ${meanMult}`);
});

test("variableRatioMultiplier: preserves the calibrated mean (RTP-neutral)", () => {
  const meanMult = 2.0, maxMult = 5.0;
  const N = 200_000;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const rng = new SeededRng("test-seed", `engage:${i}`);
    sum += variableRatioMultiplier(rng, meanMult, maxMult);
  }
  const empirical = sum / N;
  // symmetric spread -> mean within 2% of the calibrated value
  assert.ok(Math.abs(empirical - meanMult) / meanMult < 0.02, `mean ${empirical} drifted from ${meanMult}`);
});

test("variableRatioMultiplier: most wins are small, some are bigger (variable ratio)", () => {
  const meanMult = 2.0, maxMult = 5.0;
  const N = 100_000;
  let small = 0, big = 0;
  for (let i = 0; i < N; i++) {
    const rng = new SeededRng("s", `engage:${i}`);
    const m = variableRatioMultiplier(rng, meanMult, maxMult);
    if (m < meanMult * 0.95) small++;
    if (m > meanMult * 1.2) big++;
  }
  assert.ok(small / N > 0.5, `expected majority small wins, got ${small / N}`);
  assert.ok(big / N > 0.05, `expected a meaningful tail of bigger wins, got ${big / N}`);
});

test("variableRatioMultiplier: deterministic per (seed, nonce) and within bounds", () => {
  const a = variableRatioMultiplier(new SeededRng("seed", "engage:7"), 2, 5);
  const b = variableRatioMultiplier(new SeededRng("seed", "engage:7"), 2, 5);
  assert.equal(a, b);
  for (let i = 0; i < 1000; i++) {
    const m = variableRatioMultiplier(new SeededRng("seed", `engage:${i}`), 2, 5);
    assert.ok(m >= 1.01 && m <= 5, `out of bounds: ${m}`);
  }
});

test("variableRatioMultiplier: degenerate mean <= 1 passes through", () => {
  assert.equal(variableRatioMultiplier(new SeededRng("s", "engage:1"), 1, 5), 1);
});

test("isNearMiss: loss just below tau flagged, wins and blowouts not", () => {
  const tau = 0.1;
  assert.equal(isNearMiss(0.095, tau), true);   // within 15% band
  assert.equal(isNearMiss(0.11, tau), false);   // that's a win
  assert.equal(isNearMiss(-0.5, tau), false);   // blowout loss
  assert.equal(isNearMiss(0.084, tau), false);  // just outside band
});

test("isLossDisguisedAsWin: small multipliers flagged, real wins not", () => {
  assert.equal(isLossDisguisedAsWin(1.1), true);
  assert.equal(isLossDisguisedAsWin(1.24), true);
  assert.equal(isLossDisguisedAsWin(1.25), false);
  assert.equal(isLossDisguisedAsWin(3.0), false);
  assert.equal(isLossDisguisedAsWin(0), false);
});

test("presentOutcome: headlines are truthful about money", () => {
  assert.equal(presentOutcome({ result: "win", multiplier: 3.0, signedMove: 0.5, tau: 0.1 }).headline, "big_win");
  assert.equal(presentOutcome({ result: "win", multiplier: 1.5, signedMove: 0.5, tau: 0.1 }).headline, "win");
  assert.equal(presentOutcome({ result: "win", multiplier: 1.1, signedMove: 0.5, tau: 0.1 }).headline, "small_win");
  assert.equal(presentOutcome({ result: "loss", multiplier: 0, signedMove: 0.095, tau: 0.1 }).headline, "near_miss");
  assert.equal(presentOutcome({ result: "loss", multiplier: 0, signedMove: -0.4, tau: 0.1 }).headline, "loss");
});

test("win spread defaults: small share is the majority", () => {
  assert.ok(DEFAULT_WIN_SPREAD.smallShare >= 0.5 && DEFAULT_WIN_SPREAD.smallShare < 1);
  assert.ok(DEFAULT_WIN_SPREAD.smallBand[0] > 0 && DEFAULT_WIN_SPREAD.smallBand[1] <= 1);
});
