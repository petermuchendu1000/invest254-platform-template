/**
 * sweeps.test.ts — the liveness registry (BUGLOG #162).
 *
 * The thing under test is a verdict about absence, so the tests are mostly about the boundaries of
 * that verdict: when "we have not heard from it" becomes an alert, when it must NOT (a young
 * process, a disabled sweep), and that a fault in here cannot propagate into the money sweep whose
 * `.then` it is called from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSweepRegistry, buildStaleSweepAlert, describeError, formatAge, type SweepState } from "./sweeps.js";

/** A controllable clock, so staleness is tested at exact boundaries rather than with sleeps. */
function clock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; } };
}

const MIN = 60_000;

test("a freshly armed sweep is `pending`, not `stale` — a young process must not page", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  r.arm("pool.health", { everyMs: 30 * MIN, firstRunMs: 45_000 });

  assert.equal(r.snapshot()[0]!.status, "pending");
  assert.deepEqual(r.stale(), []);

  // Still pending right up to its first-run tolerance (45s * 2 + 30s grace = 120s).
  c.advance(120_000);
  assert.equal(r.snapshot()[0]!.status, "pending", "at the boundary it is still merely young");
  c.advance(1);
  assert.equal(r.snapshot()[0]!.status, "stale", "one ms past it, the first run is genuinely overdue");
});

test("tolerance switches from the first-run delay to the cadence once it has run", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  // A sweep whose first run is FAST (45s) but whose cadence is SLOW (30min). Judging a running
  // sweep by its first-run delay would call a perfectly healthy 30-minute job stale after 2 minutes.
  r.arm("pool.health", { everyMs: 30 * MIN, firstRunMs: 45_000 });
  c.advance(45_000);
  r.ok("pool.health");

  assert.equal(r.snapshot()[0]!.toleranceMs, 30 * MIN * 2 + 30_000);
  c.advance(59 * MIN);
  assert.equal(r.snapshot()[0]!.status, "ok", "an hour on, a half-hourly sweep is within one missed tick");
  c.advance(2 * MIN);
  assert.equal(r.snapshot()[0]!.status, "stale");
});

test("the documented tolerances hold for the real cadences", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  for (const [name, everyMs] of [["fast", 15_000], ["reconcile", 5 * MIN], ["pool", 30 * MIN]] as const) {
    r.arm(name, { everyMs });
    r.ok(name);
  }
  const byName = new Map(r.snapshot().map((s) => [s.name, s.toleranceMs]));
  assert.equal(byName.get("fast"), 60_000, "the 15s fast re-verify lane is late at 60s");
  assert.equal(byName.get("reconcile"), 630_000, "a 5-minute reconciler is late at 10.5 min");
  assert.equal(byName.get("pool"), 3_630_000, "the 30-minute pool monitor is late at 60.5 min");
});

test("`failing` means the timer is alive and the work is not; `stale` outranks it", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  r.arm("tickets.escalate", { everyMs: 15 * MIN, firstRunMs: 30_000 });

  c.advance(30_000);
  r.fail("tickets.escalate", new Error("connection terminated"));
  let s = r.snapshot()[0]!;
  assert.equal(s.status, "failing");
  assert.equal(s.runs, 1);
  assert.equal(s.failures, 1);
  assert.equal(s.lastError, "connection terminated");
  assert.equal(s.lastOkAtMs, null);

  // A recovery clears `failing` …
  c.advance(15 * MIN);
  r.ok("tickets.escalate");
  s = r.snapshot()[0]!;
  assert.equal(s.status, "ok");
  assert.equal(s.failures, 1, "the failure COUNT is history and is kept");
  assert.equal(s.lastError, "connection terminated", "and so is the last message, for diagnosis");

  // … and then silence outranks everything: the last we heard was good news, which is no comfort.
  c.advance(31 * MIN);
  assert.equal(r.snapshot()[0]!.status, "stale");
});

test("a sweep that is disabled (interval 0) never arms, so it is never reported late", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  r.arm("pool.health", { everyMs: 0 });
  r.arm("other", { everyMs: Number.NaN });
  c.advance(30 * 24 * 60 * MIN);
  assert.deepEqual(r.snapshot(), [], "deliberately switched off is not a fault to page about");
});

test("`ok`/`fail` for a sweep that never armed are ignored rather than inventing one", () => {
  const r = makeSweepRegistry({ now: clock().now });
  r.ok("ghost");
  r.fail("ghost", new Error("x"));
  assert.deepEqual(r.snapshot(), []);
});

test("re-arming keeps the run history but resets the clock (a deploy is not a lapse)", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  r.arm("billing.reconcile", { everyMs: 2 * MIN });
  r.ok("billing.reconcile");
  r.fail("billing.reconcile", new Error("boom"));

  c.advance(10 * MIN);
  assert.equal(r.snapshot()[0]!.status, "stale");
  r.arm("billing.reconcile", { everyMs: 2 * MIN });
  const s = r.snapshot()[0]!;
  assert.equal(s.runs, 2, "counters survive");
  assert.equal(s.failures, 1);
  assert.equal(s.status, "stale", "but a re-arm alone is not evidence it ran: the last run is still old");
});

// ── paging ──────────────────────────────────────────────────────────────────────────────────────

test("a page goes out for a late sweep, driven by a DIFFERENT sweep still running", () => {
  const c = clock();
  const pages: string[] = [];
  const r = makeSweepRegistry({ now: c.now, page: (t) => pages.push(t) });
  r.arm("fast", { everyMs: 15_000 });
  r.arm("pool.health", { everyMs: 30 * MIN, firstRunMs: 45_000 });

  // The fast lane keeps running; the pool monitor dies after one run.
  c.advance(45_000);
  r.ok("pool.health");
  for (let i = 0; i < 10; i++) { c.advance(15_000); r.ok("fast"); }
  assert.deepEqual(pages, [], "nothing is late yet");

  // Push past the pool monitor's 60.5-minute tolerance, with ONLY the fast lane reporting. 244
  // ticks of 15s is 61 minutes, so the lapse is detected without any timer of the registry's own.
  for (let i = 0; i < 244; i++) { c.advance(15_000); r.ok("fast"); }
  assert.equal(pages.length, 1, "the surviving sweep is what noticed");
  assert.match(pages[0]!, /BACKGROUND JOB STOPPED/);
  assert.match(pages[0]!, /pool\.health/);
  assert.doesNotMatch(pages[0]!, /\bfast\b/, "the healthy sweep is not named in the alert");
});

test("the same set of late sweeps is not re-paged until the cooldown, but a NEW one pages at once", () => {
  const c = clock();
  const pages: string[] = [];
  const r = makeSweepRegistry({ now: c.now, page: (t) => pages.push(t), alertCooldownMs: 60 * MIN });
  r.arm("driver", { everyMs: 1_000 });
  r.arm("a", { everyMs: 10_000 });
  r.arm("b", { everyMs: 10_000 });
  r.ok("a"); r.ok("b");

  const beat = (n: number) => { for (let i = 0; i < n; i++) { c.advance(1_000); r.ok("driver"); } };

  beat(51);                                   // past a+b's tolerance (10s * 2 + 30s grace = 50s)
  assert.equal(pages.length, 1);
  assert.match(pages[0]!, /2 jobs overdue/);

  beat(60);                                   // still inside the cooldown, same two names
  assert.equal(pages.length, 1, "an unchanged outage does not re-page every tick");

  // `b` comes back; `a` is still down. The set changed, so the next evaluation pages again.
  r.ok("b");
  beat(1);
  assert.equal(pages.length, 2);
  assert.match(pages[1]!, /1 job overdue/);
  assert.doesNotMatch(pages[1]!, /• b:/);
});

test("a full recovery re-arms the alarm: the NEXT lapse pages immediately, not after a cooldown", () => {
  const c = clock();
  const pages: string[] = [];
  const r = makeSweepRegistry({ now: c.now, page: (t) => pages.push(t), alertCooldownMs: 24 * 60 * MIN });
  r.arm("driver", { everyMs: 1_000 });
  r.arm("a", { everyMs: 10_000 });
  r.ok("a");
  for (let i = 0; i < 51; i++) { c.advance(1_000); r.ok("driver"); }
  assert.equal(pages.length, 1);

  r.ok("a");                                  // recovered
  c.advance(1_000); r.ok("driver");
  assert.equal(r.stale().length, 0);

  for (let i = 0; i < 51; i++) { c.advance(1_000); r.ok("driver"); }
  assert.equal(pages.length, 2, "a second, separate outage is news even inside the cooldown window");
});

test("with no `page` injected the registry still tracks state (the CLI/test path)", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  r.arm("a", { everyMs: 1_000 });
  c.advance(40_000);                          // 1s * 2 + 30s grace = 32s tolerance
  assert.equal(r.stale().length, 1);
});

// ── durable record ──────────────────────────────────────────────────────────────────────────────

test("arming writes through at once — 'armed at boot' is the signal that was missing", () => {
  const c = clock();
  const wrote: SweepState[] = [];
  const r = makeSweepRegistry({ now: c.now, persist: (s) => wrote.push(s) });
  r.arm("pool.health", { everyMs: 30 * MIN, firstRunMs: 45_000 });
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0]!.status, "pending");
  assert.equal(wrote[0]!.runs, 0);
});

test("writes are throttled per sweep, but a status CHANGE always writes", () => {
  const c = clock();
  const wrote: SweepState[] = [];
  const r = makeSweepRegistry({ now: c.now, persist: (s) => wrote.push(s), minPersistMs: 60_000 });
  r.arm("fast", { everyMs: 15_000 });
  assert.equal(wrote.length, 1, "the arm");

  c.advance(15_000); r.ok("fast");
  assert.equal(wrote.length, 2, "pending -> ok is a transition, so it writes");

  // 15s cadence, 60s throttle: three more runs inside the window must collapse to no writes.
  for (let i = 0; i < 3; i++) { c.advance(15_000); r.ok("fast"); }
  assert.equal(wrote.length, 2, "a healthy high-frequency sweep does not write four times a minute");

  c.advance(15_000); r.ok("fast");
  assert.equal(wrote.length, 3, "once the throttle window passes, the heartbeat lands");

  c.advance(15_000); r.fail("fast", new Error("db down"));
  assert.equal(wrote.length, 4, "ok -> failing is news and bypasses the throttle");
  assert.equal(wrote[3]!.status, "failing");
  assert.equal(wrote[3]!.lastError, "db down");
});

// ── the never-throw contract ────────────────────────────────────────────────────────────────────

test("a throwing `persist` or `page` cannot propagate into the sweep that called us", () => {
  const c = clock();
  const r = makeSweepRegistry({
    now: c.now,
    persist: () => { throw new Error("DB exploded"); },
    page: () => { throw new Error("Telegram exploded"); },
  });
  assert.doesNotThrow(() => r.arm("a", { everyMs: 1_000 }));
  assert.doesNotThrow(() => r.ok("a"));
  c.advance(10_000);
  assert.doesNotThrow(() => r.fail("a", new Error("x")));
  // And state is still correct despite both collaborators failing.
  assert.equal(r.snapshot()[0]!.runs, 2);
});

test("a throwing clock cannot take the process down", () => {
  const r = makeSweepRegistry({ now: () => { throw new Error("no clock"); } });
  assert.doesNotThrow(() => r.arm("a", { everyMs: 1_000 }));
  assert.doesNotThrow(() => r.ok("a"));
  assert.doesNotThrow(() => r.fail("a", "x"));
  assert.deepEqual(r.snapshot(), [], "nothing armed, nothing claimed");
});

test("a clock that jumps backwards reports age 0, never a negative age", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  r.arm("a", { everyMs: 1_000 });
  r.ok("a");
  c.advance(-5_000);
  const s = r.snapshot()[0]!;
  assert.equal(s.ageMs, 0);
  assert.equal(s.status, "ok");
});

// ── formatting ──────────────────────────────────────────────────────────────────────────────────

test("describeError keeps one bounded line out of anything thrown", () => {
  assert.equal(describeError(new Error("boom\nat foo()\nat bar()")), "boom");
  assert.equal(describeError("plain string"), "plain string");
  assert.equal(describeError(null), "");
  assert.equal(describeError(new Error("")), "Error", "an empty message falls back to the name");
  const long = describeError(new Error("x".repeat(500)));
  assert.equal(long.length, 301, "bounded: this lands in a text column and a Telegram message");
  assert.ok(long.endsWith("…"));
});

test("formatAge is compact at every scale", () => {
  assert.equal(formatAge(0), "0s");
  assert.equal(formatAge(45_000), "45s");
  assert.equal(formatAge(5 * MIN), "5m");
  assert.equal(formatAge(3 * 60 * MIN), "3h");
  assert.equal(formatAge(5 * 24 * 60 * MIN), "5d");
  assert.equal(formatAge(Number.NaN), "?");
});

test("the alert leads with the consequence and names what is overdue", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  r.arm("payments.reconcile", { everyMs: 5 * MIN });
  r.fail("payments.reconcile", new Error("ECONNREFUSED 10.0.0.1:6543"));
  c.advance(60 * MIN);
  const text = buildStaleSweepAlert(r.stale(), { app: "api", machine: "1781e3" });

  assert.match(text, /^⚠️ BACKGROUND JOB STOPPED \(api 1781e3\) — 1 job overdue\./);
  assert.match(text, /payments\.reconcile: last ran 60m ago \(expected every 5m\)/);
  assert.match(text, /last error: ECONNREFUSED 10\.0\.0\.1:6543/);
  assert.match(text, /not happening/, "it says what the operator loses, not just that a timer stopped");
});

test("a sweep that has NEVER run says so, rather than reporting an age since boot as a run", () => {
  const c = clock();
  const r = makeSweepRegistry({ now: c.now });
  r.arm("pool.health", { everyMs: 30 * MIN, firstRunMs: 45_000 });
  c.advance(10 * 60 * MIN);
  const text = buildStaleSweepAlert(r.stale());
  assert.match(text, /pool\.health: has NEVER run/);
  assert.doesNotMatch(text, /last error/, "no run means no error to blame");
});
