/**
 * server.sweeps.guard.test.ts — a static guard that every background sweep stays observable
 * (BUGLOG #162).
 *
 * The bug this file exists to prevent recurring is not a logic error, it is an OMISSION: eleven
 * sweeps accumulated in server.ts over time, each reporting only when it had something to say, and
 * nobody noticed that the sum of them was a layer whose death was silent. Wiring the registry fixes
 * today's eleven. Nothing stops the twelfth from being added the old way — and it would be invisible
 * in exactly the same manner, with the board above it showing "All 10 jobs running" to boot, which
 * is worse than no board at all.
 *
 * So this reads server.ts and insists on the pairing. Static parsing, like
 * scripts/workflows.guard.test.mts: it cannot prove the sweep works, only that somebody remembered
 * it exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");

/**
 * Only the MODULE-SCOPE sweeps, i.e. everything after `buildDeps()` returns. The timers inside
 * buildDeps are the two retention prunes, which are deliberately untracked (they are armed before
 * the registry exists, and a prune that stops costs disk, not money) and the config/scope pollers,
 * whose failure is visible in the thing they feed.
 */
const SWEEP_REGION = SRC.slice(SRC.indexOf("const deps = await buildDeps();"));

const names = (re: RegExp): Set<string> =>
  new Set([...SWEEP_REGION.matchAll(re)].map((m) => m[1]!));

const ARMED = names(/\btrack\.arm\("([^"]+)"/g);
const OK = names(/\btrack\.ok\("([^"]+)"/g);
const FAILED = names(/\btrack\.fail\("([^"]+)"/g);

test("the sweep region actually arms sweeps (the guard is not reading an empty string)", () => {
  assert.ok(SWEEP_REGION.length > 1000, "failed to locate the sweep region in server.ts");
  assert.ok(ARMED.size >= 10, `expected at least the ten known sweeps, found ${ARMED.size}`);
});

test("every armed sweep records BOTH outcomes, so neither verdict can be the one that is missing", () => {
  /**
   * A sweep with `arm` + `ok` but no `fail` looks healthy while failing on every tick. One with
   * `arm` + `fail` but no `ok` goes 'stale' the moment it starts succeeding and pages the operator
   * for a working system — the fastest possible way to teach somebody to ignore the alert.
   */
  const missingOk = [...ARMED].filter((n) => !OK.has(n)).sort();
  const missingFail = [...ARMED].filter((n) => !FAILED.has(n)).sort();
  assert.deepEqual(missingOk, [], `armed but never records success: ${missingOk.join(", ")}`);
  assert.deepEqual(missingFail, [], `armed but never records failure: ${missingFail.join(", ")}`);
});

test("nothing records an outcome for a sweep that was never armed", () => {
  // `ok`/`fail` on an unarmed name is silently dropped by the registry (by design — a typo must not
  // invent a sweep), which would make the typo invisible. This is where it becomes visible.
  const strays = [...new Set([...OK, ...FAILED])].filter((n) => !ARMED.has(n)).sort();
  assert.deepEqual(strays, [], `outcome recorded for an unarmed sweep (typo?): ${strays.join(", ")}`);
});

test("every module-scope setInterval belongs to a tracked sweep", () => {
  /**
   * The count check, which is what actually catches a NEW untracked sweep. One timer may serve more
   * than one tracked sweep (the fast re-verify lane runs two payment providers in one tick, and is
   * tracked as two, because "PayX stopped settling while Mega Pay kept going" is the fact worth
   * having), so arms >= timers rather than equality.
   */
  const timers = [...SWEEP_REGION.matchAll(/\bsetInterval\(/g)].length;
  assert.ok(timers >= 9, `expected the known timers, found ${timers}`);
  assert.ok(
    ARMED.size >= timers,
    `${timers} module-scope setInterval(s) but only ${ARMED.size} tracked sweep(s) — a new sweep was added without track.arm/ok/fail, so its death would be silent`,
  );
});

test("the 'armed' lines go through the PERSISTED logger, not the stdout-only one", () => {
  /**
   * The original defect in miniature: three sweeps DID log "armed", through the module-scoped `log`,
   * whose sink is process.stdout. `system_logs` — the only durable, queryable record, and the one
   * the owner's System logs page reads — never saw them. Fly's log retention is short and not
   * queryable historically, so "has this sweep ever armed on this release?" had no answer.
   *
   * `log.info("… armed")` must therefore not come back. The persisted loggers are the per-module
   * children of `deps.logger` (recLog / billLog / tkLog / phLog).
   */
  const stdoutArms = [...SWEEP_REGION.matchAll(/\blog\.info\("([^"]*\barmed\b[^"]*)"/g)].map((m) => m[1]!);
  assert.deepEqual(
    stdoutArms, [],
    `these 'armed' lines go to stdout only and will never reach system_logs: ${stdoutArms.join(" | ")}`,
  );
  // And at least the four sweeps that announce themselves still do, through a persisted child.
  const persistedArms = [...SWEEP_REGION.matchAll(/\b(recLog|billLog|tkLog|phLog)\.info\("[^"]*\barmed\b/g)].length;
  assert.ok(persistedArms >= 4, `expected the arm lines on persisted loggers, found ${persistedArms}`);
});

test("the heartbeat write and the page are both fire-and-forget", () => {
  /**
   * These run inside the `.then` of sweeps that settle money. The registry swallows throws from
   * either callback, but a REJECTED promise escapes that: `void q.query(...)` without a `.catch`
   * is an unhandled rejection, and an API that exits on one would be brought down by the thing
   * watching it. Both callbacks must therefore catch their own.
   */
  const start = SRC.indexOf("const sweeps = makeSweepRegistry(");
  const pageAt = SRC.indexOf("page: (text)", start);
  const end = SRC.indexOf("  return {", start);
  assert.ok(start > 0 && pageAt > start && end > pageAt, "failed to locate the registry construction");

  // Each callback is checked against ITS OWN block. Searching the whole construction would let one
  // callback's `.catch` satisfy the other's assertion — which it did, until a mutation said so.
  const persistBlock = SRC.slice(start, pageAt);
  const pageBlock = SRC.slice(pageAt, end);

  assert.ok(persistBlock.includes("fn_sweep_heartbeat"), "the persist callback should write the heartbeat");
  assert.match(
    persistBlock, /\.catch\(/,
    "the heartbeat write must swallow its own rejection — it runs inside a money sweep's .then",
  );
  assert.ok(pageBlock.includes("sendMessage"), "the page callback should send the alert");
  assert.match(pageBlock, /\.catch\(/, "the stale-sweep page must swallow its own rejection");
});
