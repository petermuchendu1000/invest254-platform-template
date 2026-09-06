import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePoolOutcomeFixed, DEFAULT_POOL_KNOBS, type PoolKnobs, type PlayerSession, EMPTY_SESSION,
  decisionDigit, digitsForOutcome, evaluateDigit, type DigitKind, withLastPip,
} from "./index.js";

/**
 * Fixed-odds pool brain (digits under pool mode) — the SAME invariants as the variable-amount brain,
 * with the fixed-odds adaptation: a win pays EXACTLY the contract payout or the trade loses.
 */
const SEED = "pool-fixed-seed";
const STAKE = 25_000;
const PAYOUT = 47_500; // even/odd at factor 0.95: round(25000*0.95/0.5) => m = 1.9
const TARGET_RTP = 0.25; // house_edge 0.75 — the central dial
const knobs: PoolKnobs = {
  ...DEFAULT_POOL_KNOBS,
  meanMultiplier: PAYOUT / STAKE, maxMultiplier: PAYOUT / STAKE,
  targetSessionRtp: TARGET_RTP, pCap: TARGET_RTP / (PAYOUT / STAKE),
};
const bigPool = { amountCents: 100_000_000, paidCents: 0, reservedCents: 0 };

test("fixed odds: every win pays EXACTLY the contract payout — never a shrunk win", () => {
  for (let nonce = 0; nonce < 3000; nonce++) {
    const d = decidePoolOutcomeFixed({
      stakeCents: STAKE, payoutCents: PAYOUT, pool: { ...bigPool, turnoverCents: 50_000_000 },
      dayFraction: 0.5, knobs, serverSeed: SEED, nonce, session: { ...EMPTY_SESSION },
    });
    if (d.result === "win") {
      assert.equal(d.payoutCents, PAYOUT, `nonce ${nonce}: win must pay the fixed return`);
      assert.equal(d.multiplier, PAYOUT / STAKE);
    } else {
      assert.equal(d.payoutCents, 0);
    }
  }
});

test("EDGE INVARIANT: sequential session keeps cumulative paid ≤ targetRtp × turnover at ALL times", () => {
  const pool = { amountCents: 100_000_000, paidCents: 0, reservedCents: 0 };
  const session: PlayerSession = { ...EMPTY_SESSION };
  let turnover = 0;
  for (let i = 0; i < 4000; i++) {
    turnover += STAKE;
    const d = decidePoolOutcomeFixed({
      stakeCents: STAKE, payoutCents: PAYOUT, pool: { ...pool, turnoverCents: turnover },
      dayFraction: (i % 1000) / 1000, knobs, serverSeed: SEED, nonce: 10_000 + i, session,
    });
    session.trades++; session.stakedCents += STAKE;
    if (d.result === "win") {
      pool.paidCents += d.payoutCents;
      session.returnedCents += d.payoutCents; session.wins++; session.lossStreak = 0;
    } else session.lossStreak++;
    assert.ok(pool.paidCents <= Math.floor(knobs.targetSessionRtp * turnover),
      `i=${i}: paid ${pool.paidCents} breaches RTP budget ${Math.floor(knobs.targetSessionRtp * turnover)}`);
  }
  const rtp = pool.paidCents / turnover;
  assert.ok(rtp > 0.05 && rtp <= TARGET_RTP, `realized RTP ${rtp.toFixed(4)} in (0.05, ${TARGET_RTP}]`);
});

test("cash fuse: zero/exhausted pool or payout > available ⇒ always a LOSS", () => {
  for (let nonce = 0; nonce < 300; nonce++) {
    const dead = decidePoolOutcomeFixed({
      stakeCents: STAKE, payoutCents: PAYOUT, pool: { amountCents: 0, paidCents: 0, reservedCents: 0, turnoverCents: STAKE },
      dayFraction: 0.5, knobs, serverSeed: SEED, nonce, session: { ...EMPTY_SESSION },
    });
    assert.equal(dead.result, "loss");
    const tight = decidePoolOutcomeFixed({
      stakeCents: STAKE, payoutCents: PAYOUT, pool: { amountCents: PAYOUT - 1, paidCents: 0, reservedCents: 0, turnoverCents: 100_000_000 },
      dayFraction: 0.5, knobs, serverSeed: SEED, nonce, session: { ...EMPTY_SESSION },
    });
    assert.equal(tight.result, "loss", "a fixed payout that does not fit available cash is a loss, never partial");
  }
});

test("degenerate contract (payout ≤ stake) can never 'win'", () => {
  for (let nonce = 0; nonce < 200; nonce++) {
    const d = decidePoolOutcomeFixed({
      stakeCents: STAKE, payoutCents: STAKE, pool: { ...bigPool, turnoverCents: 10_000_000 },
      dayFraction: 0.5, knobs, serverSeed: SEED, nonce, session: { ...EMPTY_SESSION },
    });
    assert.equal(d.result, "loss");
  }
});

test("determinism: same (seed, nonce, state) ⇒ identical decision", () => {
  const mk = () => decidePoolOutcomeFixed({
    stakeCents: STAKE, payoutCents: PAYOUT, pool: { ...bigPool, turnoverCents: 1_000_000 },
    dayFraction: 0.33, knobs, serverSeed: SEED, nonce: 77, session: { ...EMPTY_SESSION },
  });
  assert.deepEqual(mk(), mk());
});

test("decisionDigit: always lands in the outcome's digit set, for every kind/target; deterministic", () => {
  const kinds: DigitKind[] = ["even", "odd", "over", "under", "matches", "differs"];
  for (const kind of kinds) {
    for (let target = 0; target <= 9; target++) {
      for (const won of [true, false]) {
        const set = digitsForOutcome(kind, target, won);
        for (let nonce = 0; nonce < 40; nonce++) {
          const d = decisionDigit("decision-seed", nonce, kind, target, won);
          if (set.length === 0) { assert.equal(d, null); continue; }
          assert.ok(d !== null && set.includes(d), `${kind}/${target}/${won}: digit ${d} not in [${set}]`);
          assert.equal(evaluateDigit(kind, target, d!), won, "digit must reproduce the decided outcome");
          assert.equal(decisionDigit("decision-seed", nonce, kind, target, won), d, "deterministic");
        }
      }
    }
  }
});

test("withLastPip: replaces only the last pip; digit round-trips", () => {
  for (const q of [9301.65, 1000.0, 4523.09, 777.77]) {
    for (let d = 0; d <= 9; d++) {
      const out = withLastPip(q, d);
      assert.equal(Math.round(Math.abs(out) * 100) % 10, d);
      assert.ok(Math.abs(out - q) <= 0.09 + 1e-9, `quote moved too far: ${q} -> ${out}`);
    }
  }
});
