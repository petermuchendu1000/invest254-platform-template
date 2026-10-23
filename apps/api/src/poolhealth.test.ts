/**
 * The thresholds in poolhealth.ts decide whether anyone is woken up about players losing 100% of
 * their stakes, so they are pinned here rather than exercised only through a database.
 *
 * The reference values come from running the Python original (`scripts/pool_health_monitor.py`,
 * which this replaced) and are deliberate to the last digit — see `minViable` below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POOL_KNOBS } from "@invest254/shared";
import {
  DEFAULT_MIN_DECISIONS, buildStarvationAlert, evaluateBrand, minViableCents, summarise,
} from "./poolhealth.js";

const row = (o: Record<string, unknown>): Record<string, unknown> => ({
  slug: "b", min_stake: 25000, max_mult: 5, amount: 0, paid: 0, reserved: 0,
  decisions: 0, wins: 0, turnover: 0, ...o,
});
const kinds = (r: Record<string, unknown>, min = DEFAULT_MIN_DECISIONS): string[] =>
  evaluateBrand(r, min).alerts.map((a) => a.kind);

test("minViable rounds up, and the one divergence from the Python original is pinned", () => {
  // Agrees with the original wherever the division is inexact, which is every real configuration:
  assert.equal(minViableCents(25000, 5.0), 833334);   // python: 833334
  assert.equal(minViableCents(1, 1.0), 7);            // python: 7
  assert.equal(minViableCents(333, 1.7), 3775);       // python: 3775
  assert.equal(minViableCents(0, 5.0), 0, "no minimum stake means no viability floor");

  // And differs by exactly one cent where it comes out exact. The original's `-(-x // 0.15)` used
  // CPython's fmod-corrected float floor-division, which sees the true quotient of the doubles
  // (15/0.15 is 100.0000000000000037 exactly, 100.0 once rounded) and so returned 101 and 2001.
  // Python's own math.ceil(x/0.15) returns 100 and 2000, i.e. the original disagreed with itself.
  // The intent is the decimal 0.15, so we round the rounded quotient. BELOW_VIABLE is a warning
  // that never pages, so a one-cent threshold shift cannot change who gets woken up.
  assert.equal(minViableCents(15, 1.0), 100);         // python: 101
  assert.equal(minViableCents(100, 3.0), 2000);       // python: 2001
});

test("minViable is derived from the shared playerShare knob, not a local copy of 0.15", () => {
  // The Python original restated PLAYER_SHARE = 0.15 beside pool.ts's knob, and nothing would have
  // noticed the two parting company. Recompute from the knob: if someone retunes playerShare, this
  // stays true and the hardcoded-0.15 version would not.
  const ms = 7777, mm = 2.5;
  assert.equal(minViableCents(ms, mm), Math.ceil((ms * mm) / DEFAULT_POOL_KNOBS.playerShare));
});

test("bigint and numeric arrive from pg as STRINGS, and must not be compared as strings", () => {
  // available = 9000, min_stake = 25000. Numerically starved. Lexicographically "9000" > "25000",
  // so a port that passes the raw row values straight into `<` reports this brand healthy and
  // nobody is paged. This is the single most dangerous way to get this module wrong.
  const asText = row({ amount: "14000", paid: "5000", reserved: "0", min_stake: "25000",
                       max_mult: "5.0", decisions: "2", wins: "1", turnover: "60000" });
  const b = evaluateBrand(asText);
  assert.equal(b.availableCents, 9000);
  assert.equal(b.minStakeCents, 25000);
  assert.deepEqual(b.alerts.map((a) => a.kind), ["POOL_STARVED"]);
  assert.match(b.alerts[0]!.text, /available=9000 < min_stake=25000/);
});

test("POOL_STARVED needs live trades: an empty pool nobody is trading into is not an alert", () => {
  assert.deepEqual(kinds(row({ amount: 0, decisions: 0 })), []);
  assert.deepEqual(kinds(row({ amount: 10000, paid: 9000, decisions: 5, turnover: 150000 })),
    ["POOL_STARVED"]);
});

test("ALL_LOSS needs turnover and enough decisions to be a signal", () => {
  const funded = { amount: 5_000_000, turnover: 300_000, wins: 0 };
  assert.deepEqual(kinds(row({ ...funded, decisions: 7 })), [], "below the threshold");
  assert.deepEqual(kinds(row({ ...funded, decisions: 8 })), ["ALL_LOSS"], "at the threshold");
  assert.deepEqual(kinds(row({ ...funded, decisions: 20, wins: 1 })), [], "one win clears it");
  assert.deepEqual(kinds(row({ ...funded, decisions: 20, turnover: 0 })), [], "no turnover, no signal");
  assert.deepEqual(kinds(row({ ...funded, decisions: 3 }), 3), ["ALL_LOSS"], "threshold is a parameter");
});

test("BELOW_VIABLE is a warning and yields to anything worse", () => {
  // Funded above one minimum stake but below a payable maximum win, with demand: top it up.
  assert.deepEqual(kinds(row({ amount: 200_000, decisions: 3, wins: 1, turnover: 90_000 })),
    ["BELOW_VIABLE"]);
  // Starved AND winless: the operator must read starvation, not under-funding.
  assert.deepEqual(kinds(row({ amount: 10_000, paid: 9_500, decisions: 12, turnover: 360_000 })),
    ["POOL_STARVED", "ALL_LOSS"]);
});

test("available never goes negative, so an over-paid pool reads as empty rather than inverted", () => {
  const b = evaluateBrand(row({ amount: 1000, paid: 5000, decisions: 1, turnover: 30000 }));
  assert.equal(b.availableCents, 0);
  assert.deepEqual(b.alerts.map((a) => a.kind), ["POOL_STARVED"]);
});

test("summarise separates what pages from what only reports", () => {
  const brands = [
    evaluateBrand(row({ slug: "starved", amount: 10_000, paid: 9_000, decisions: 5, turnover: 150_000 })),
    evaluateBrand(row({ slug: "low", amount: 200_000, decisions: 3, wins: 1, turnover: 90_000 })),
    evaluateBrand(row({ slug: "fine", amount: 5_000_000, decisions: 10, wins: 4, turnover: 300_000 })),
  ];
  const r = summarise(brands);
  assert.equal(r.alert, true);
  assert.equal(r.hard.length, 1);
  assert.match(r.hard[0]!, /^starved: POOL_STARVED /);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /^low: BELOW_VIABLE /);
  // A healthy brand contributes nothing to either list.
  assert.equal(r.hard.concat(r.warnings).filter((s) => s.startsWith("fine:")).length, 0);
  // Warnings alone must NOT raise the alert flag, or every under-funded day would page.
  assert.equal(summarise([brands[1]!]).alert, false);
});

test("the page keeps the wording the cron used, so alert history stays greppable", () => {
  const text = buildStarvationAlert(["acme: POOL_STARVED available=0 < min_stake=25000 (x)"]);
  assert.match(text, /^🚨 <b>Invest254 pool starvation<\/b>\n/);
  assert.match(text, /acme: POOL_STARVED/);
  assert.match(text, /Players may be losing 100%\. Re-fund the pool \/ run a dynamic distribution\.$/);
});
