/**
 * seed.test.mjs — tests for the pure helpers behind the two seeding scripts.
 *
 * Nothing here touches a database: every helper under test is a pure function of a seed string, so
 * the properties that matter (handles are safe and short, the arrival pattern really is
 * evening-heavy, every board window gets a bucket) are checkable offline. That is deliberate — the
 * scripts are run once per brand launch by a person, and a bad batch is only visible to the public
 * feed, so the time to catch it is here.
 *
 * Run: node --test scripts/
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SeedRng, makeHandle, makeHandles, isSafeHandle, rejectTaken, parseCli, DENY, MAX_LEN } from "./seed-names.mjs";
import { HOUR_WEIGHTS, spreadSeconds, amountCents } from "./seed-activity.mjs";
import { windows, buildBuckets } from "./seed-leaderboard.mjs";

const EAT = 3 * 3_600_000;
const eatHour = (ms) => new Date(ms + EAT).getUTCHours();

test("SeedRng is deterministic per seed and differs across seeds", () => {
  const r1 = new SeedRng("abc", "x"), r2 = new SeedRng("abc", "x"), r3 = new SeedRng("abd", "x");
  const s1 = Array.from({ length: 20 }, () => r1.next());
  assert.deepEqual(s1, Array.from({ length: 20 }, () => r2.next()));
  assert.notDeepEqual(s1, Array.from({ length: 20 }, () => r3.next()));
  for (const v of s1) assert.ok(v >= 0 && v < 1);
});

test("every generated handle is safe, lowercase and short enough for a 320px row", () => {
  const rng = new SeedRng("handle-shape", "h");
  for (let i = 0; i < 5_000; i++) {
    const h = makeHandle(rng);
    assert.ok(isSafeHandle(h), `unsafe handle: ${h}`);
    assert.equal(h, h.toLowerCase());
    assert.ok(h.length <= MAX_LEN, `too long: ${h}`);
    // leaderboard_seed.name CHECK: length(btrim(name)) between 1 and 40
    assert.ok(h.trim().length >= 1 && h.trim().length <= 40);
    // No denied token, even as a substring with separators removed.
    const flat = h.replace(/[^a-z0-9]/g, "");
    for (const bad of DENY) assert.ok(!flat.includes(bad), `${h} contains ${bad}`);
  }
});

test("isSafeHandle rejects the things it is there to reject", () => {
  for (const bad of ["", "ab", "a".repeat(17), "Wanjiku", "mpesa_254", "mr__joy", "_joy", "joy_", "admin254", "a b", "ruto.ke"]) {
    assert.equal(isSafeHandle(bad), false, `should be rejected: ${bad}`);
  }
  for (const ok of ["pfx", "dollybaib", "wanjiku_254", "otieno.ke", "mrotieno", "mercy254"]) {
    assert.equal(isSafeHandle(ok), true, `should be allowed: ${ok}`);
  }
});

test("makeHandles yields distinct handles and is reproducible", () => {
  const first = makeHandles(new SeedRng("pool", "handles"), 300);
  assert.equal(new Set(first).size, 300);
  assert.deepEqual(first, makeHandles(new SeedRng("pool", "handles"), 300));
});

test("rejectTaken drops case-insensitive collisions with a real username", () => {
  const { kept, dropped } = rejectTaken(["pfx", "mercy254", "thejoy"], ["MERCY254", " other "]);
  assert.deepEqual(kept, ["pfx", "thejoy"]);
  assert.deepEqual(dropped, ["mercy254"]);
});

test("parseCli separates positionals, valued flags and boolean flags", () => {
  assert.deepEqual(parseCli(["cpfmarket", "3000", "--days=14", "--seed", "x", "--dry-run"]),
    { pos: ["cpfmarket", "3000"], flags: { days: "14", seed: "x", "dry-run": true } });
  // --dry-run must not swallow the slug that follows it.
  assert.deepEqual(parseCli(["--dry-run", "cpfmarket", "60"]).pos, ["cpfmarket", "60"]);
});

test("spreadSeconds covers the window, is sorted, and spans back and forward", () => {
  const nowMs = Date.UTC(2026, 9, 11, 9, 20, 0);
  const offs = spreadSeconds({ rng: new SeedRng("spread", "t"), count: 3_000, nowMs, backDays: 1, forwardDays: 14 });
  assert.equal(offs.length, 3_000);
  for (let i = 1; i < offs.length; i++) assert.ok(offs[i] >= offs[i - 1], "must be sorted oldest first");
  assert.ok(offs[0] >= -2 * 86_400, "nothing older than the backfill tail");
  assert.ok(offs[offs.length - 1] <= 14 * 86_400 + 3_600, "nothing beyond the forward window");
  assert.ok(offs[0] < 0, "some rows must already be visible");
  assert.ok(offs.filter((o) => o >= 0).length > 2_500, "most rows must be post-dated");
  assert.deepEqual(offs, spreadSeconds({ rng: new SeedRng("spread", "t"), count: 3_000, nowMs, backDays: 1, forwardDays: 14 }));
});

test("arrivals are evening-heavy and quiet at 4am, not uniform", () => {
  const nowMs = Date.UTC(2026, 9, 11, 9, 20, 0);
  const offs = spreadSeconds({ rng: new SeedRng("diurnal", "t"), count: 20_000, nowMs, backDays: 1, forwardDays: 14 });
  const perHour = new Array(24).fill(0);
  for (const o of offs) perHour[eatHour(nowMs + o * 1000)]++;
  const peak = perHour.indexOf(Math.max(...perHour));
  assert.ok(peak >= 19 && peak <= 22, `peak hour should be the evening, got ${peak}`);
  assert.ok(perHour[4] * 8 < perHour[21], "4am must be far quieter than 9pm");
  // Rate must track the declared curve: every hour's share within 25% of its weight's share.
  const wTotal = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  for (let h = 0; h < 24; h++) {
    const expected = (HOUR_WEIGHTS[h] / wTotal) * offs.length;
    assert.ok(Math.abs(perHour[h] - expected) < Math.max(40, expected * 0.25), `hour ${h}: ${perHour[h]} vs ~${expected.toFixed(0)}`);
  }
});

test("every day of the forward window gets rows, so the feed never goes dark", () => {
  const nowMs = Date.UTC(2026, 9, 11, 9, 20, 0);
  const offs = spreadSeconds({ rng: new SeedRng("days", "t"), count: 3_000, nowMs, backDays: 1, forwardDays: 14 });
  for (let d = 0; d < 14; d++) {
    const n = offs.filter((o) => o >= d * 86_400 && o < (d + 1) * 86_400).length;
    assert.ok(n > 80, `day ${d} has only ${n} rows`);
  }
});

test("amounts are tidy KES figures inside the declared band", () => {
  const rng = new SeedRng("amt", "a");
  for (let i = 0; i < 2_000; i++) {
    const c = amountCents(rng);
    assert.equal(c % 100, 0, "whole KES");
    const kes = c / 100;
    assert.ok(kes >= 500 && kes <= 25_000, `${kes} out of band`);
    const step = kes < 2_000 ? 50 : kes < 10_000 ? 100 : 500;
    assert.ok(kes % step === 0 || kes % 50 === 0, `${kes} is not a tidy figure (step ${step})`);
  }
});

test("windows() finds the right day, week and month starts, and copes with edges", () => {
  // 2026-10-11 is a Sunday; ISO week started Monday 2026-10-05.
  const w = windows(Date.UTC(2026, 9, 11, 9, 0), 30);
  const day = (ms) => new Date(ms + EAT).toISOString().slice(0, 10);
  assert.equal(day(w.today), "2026-10-11");
  assert.equal(day(w.yesterday), "2026-10-10");
  assert.equal(day(w.weekStart), "2026-10-05");
  assert.equal(day(w.monthStart), "2026-10-01");
  assert.ok(w.monthEarly && w.weekEarly);
  // First of the month, a Monday (2026-06-01): no "earlier this month" and no "earlier this week".
  const edge = windows(Date.UTC(2026, 5, 1, 9, 0), 30);
  assert.equal(edge.monthEarly, null);
  assert.equal(edge.weekEarly, null);
});

test("leaderboard buckets respect 0194's CHECKs and the day-safe hour band", () => {
  const nowMs = Date.UTC(2026, 9, 11, 9, 20, 0);
  const { rows, traders } = buildBuckets({ seed: "lb", traders: 60, forwardDays: 30, nowMs });
  assert.equal(traders, 60);
  assert.ok(rows.length >= 60 * 4);
  for (const r of rows) {
    assert.ok(r.name.trim().length >= 1 && r.name.trim().length <= 40);
    assert.ok(Number.isInteger(r.trades) && r.trades >= 1 && r.trades <= 500);
    assert.ok(Number.isInteger(r.winningsCents) && r.winningsCents >= 0);
    const at = nowMs + r.offsetSeconds * 1000;
    // Trading-hours band (03:00-23:59 EAT) is what makes UTC and EAT agree on the calendar day.
    const h = eatHour(at);
    if (r.offsetSeconds > 0) {
      assert.ok(h >= 3, `post-dated bucket at ${h}:00 EAT falls in the dead-of-night band`);
      // The band's whole purpose: the instant is on the same calendar day in UTC and in EAT, so
      // date_trunc('day'|'week'|'month') puts it in the same window whichever the session zone is.
      assert.equal(new Date(at).getUTCDate(), new Date(at + EAT).getUTCDate(),
        `bucket at ${new Date(at).toISOString()} straddles the UTC/EAT day boundary`);
    }
  }
});

test("every board window is populated at the moment of seeding, and the periods differ", () => {
  const nowMs = Date.UTC(2026, 9, 11, 19, 40, 0);
  const { rows } = buildBuckets({ seed: "lb-windows", traders: 40, forwardDays: 30, nowMs });
  const w = windows(nowMs, 30);
  const visible = rows.filter((r) => r.offsetSeconds <= 0).map((r) => ({ ...r, at: nowMs + r.offsetSeconds * 1000 }));
  const board = (from, to) => {
    const by = new Map();
    for (const r of visible) if (r.at >= from && r.at < to) by.set(r.name, (by.get(r.name) ?? 0) + r.winningsCents);
    return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  };
  const today = board(w.today, nowMs + 1);
  const yesterday = board(w.yesterday, w.today);
  const week = board(w.weekStart, nowMs + 1);
  const month = board(w.monthStart, nowMs + 1);
  for (const [label, b] of [["today", today], ["yesterday", yesterday], ["week", week], ["month", month]]) {
    assert.ok(b.length >= 10, `${label} board has only ${b.length} names`);
  }
  assert.notDeepEqual(today.slice(0, 5), month.slice(0, 5), "Today and This Month must not be the same board");
  assert.ok(month.length >= week.length, "a wider window cannot have fewer names");
});

test("standings are top-heavy but not a smooth curve", () => {
  const nowMs = Date.UTC(2026, 9, 25, 19, 0, 0);
  const { rows } = buildBuckets({ seed: "lb-shape", traders: 80, forwardDays: 30, nowMs });
  const by = new Map();
  for (const r of rows) by.set(r.name, (by.get(r.name) ?? 0) + r.winningsCents);
  const totals = [...by.values()].sort((a, b) => b - a);
  const all = totals.reduce((a, b) => a + b, 0);
  const top5 = totals.slice(0, 5).reduce((a, b) => a + b, 0);
  assert.ok(top5 / all > 0.1, "a few big names should carry a visible share of the board");
  assert.ok(top5 / all < 0.75, "but not the whole board");
  // Gaps between neighbours must vary — a smooth curve is the tell of generated data.
  const gaps = totals.slice(0, 20).map((v, i, a) => (i ? a[i - 1] - v : 0)).slice(1);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  assert.ok(sd / mean > 0.5, `rank gaps are too even (cv ${(sd / mean).toFixed(2)})`);
  // Winnings track trades per trader, roughly.
  const tradesBy = new Map();
  for (const r of rows) tradesBy.set(r.name, (tradesBy.get(r.name) ?? 0) + r.trades);
  for (const [name, cents] of by) assert.ok(cents > 0 && tradesBy.get(name) > 0, `${name} has winnings without trades`);
});

test("buildBuckets is reproducible and honours the collision drop", () => {
  const nowMs = Date.UTC(2026, 9, 11, 9, 20, 0);
  const a = buildBuckets({ seed: "repro", traders: 25, forwardDays: 30, nowMs });
  const b = buildBuckets({ seed: "repro", traders: 25, forwardDays: 30, nowMs });
  assert.deepEqual(a.rows, b.rows);
  const taken = [a.rows[0].name];
  const c = buildBuckets({ seed: "repro", traders: 25, forwardDays: 30, nowMs, taken });
  assert.deepEqual(c.dropped, taken);
  assert.ok(!c.rows.some((r) => r.name === taken[0]));
});
