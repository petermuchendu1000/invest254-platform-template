import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VERSIONED_CONFIG } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { SeedManager } from "./daycontext.js";
import { StaticConfigProvider } from "./gameconfig.js";

/**
 * Rotating the platform master seed must not destroy the fairness record.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The master seed had a committed public literal as its
 * fallback, and production was running on it — so it has to be rotated. But the storage layer makes
 * that a one-way door: `fn_ensure_game_day` is `on conflict do nothing`, so a day's commitment is
 * frozen when the day is first created, and `fn_reveal_game_day` updates only
 * `where server_seed_hash = encode(digest(p_seed,'sha256'),'hex')`. A day committed under master A
 * can therefore ONLY be opened by a seed derived from master A. Change the master and every
 * already-open day is unrevealable forever — and since every brand has an open day every day, there
 * is no moment at which rotating is safe. The two obvious escapes are both worse than the disease:
 * leave the days unrevealed (a permanent hole in the published record) or rewrite their stored
 * commitment (publish a commitment that does not match the outcomes the day actually produced).
 *
 * So the reveal falls back to the previous master. These tests pin that it works, that it cannot
 * leak into anything else, and that it cannot be abused to open a day it has no claim to.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_MASTER = "old-master-seed-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_MASTER = "new-master-seed-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OPTS = { calibrationSamples: 1000 };
const SITE = "11111111-1111-1111-1111-111111111111";

/** Build a manager, run a day, then roll the clock a day and rotate — the production sequence. */
async function commitThenRotate(opts: {
  commitMaster: string; revealMaster: string; legacy?: string; siteId?: string;
}): Promise<{ revealed: string | null; committedKey: string; repo: InMemoryGameRepository }> {
  const cfg = DEFAULT_VERSIONED_CONFIG;
  const config = new StaticConfigProvider(cfg);
  const repo = new InMemoryGameRepository();
  const clock = { ms: 1_760_000_000_000 };

  // Day 1 under the committing master: this writes the commitment and nothing can change it after.
  const before = new SeedManager(opts.commitMaster, config, repo, () => clock.ms, OPTS, opts.siteId);
  const day1 = await before.init();

  // The platform rotates, the engine restarts: a NEW manager, new master, no in-memory history.
  const after = new SeedManager(
    opts.revealMaster, config, repo, () => clock.ms,
    { ...OPTS, ...(opts.legacy ? { legacyMasterSeed: opts.legacy } : {}) },
    opts.siteId,
  );
  await after.init();                       // picks up day 1 as its active day
  clock.ms += DAY_MS;                       // the UTC boundary passes
  const { revealed } = await after.rotate(); // reveals the previous day, or fails to
  return { revealed, committedKey: day1.dateKey, repo };
}

test("rotation: WITHOUT the fallback, a day committed under the old master is orphaned", async () => {
  // This is the bug, pinned. If this ever starts passing with a non-null `revealed`, the storage
  // layer changed and the fallback below may no longer be needed — check before deleting it.
  const { revealed } = await commitThenRotate({ commitMaster: OLD_MASTER, revealMaster: NEW_MASTER });
  assert.equal(revealed, null, "a day committed under a different master must not be revealable by accident");
});

test("rotation: WITH the previous master configured, the day reveals correctly", async () => {
  const { revealed, committedKey } = await commitThenRotate({
    commitMaster: OLD_MASTER, revealMaster: NEW_MASTER, legacy: OLD_MASTER,
  });
  // The reveal is genuine, not merely recorded: InMemoryGameRepository.revealSeed now enforces the
  // same `sha256(seed) == published commitment` equality that fn_reveal_game_day does, so a true
  // here means the legacy master really did reproduce the committed seed.
  assert.equal(revealed, committedKey, "the previous master must open the day it committed");
});

test("rotation: works per-brand, which is how production actually derives seeds", async () => {
  // Every live brand uses deriveSiteDaySeed (sites.master_seed_ref is null for all of them, so they
  // all hang off the one platform master). A fallback that only handled the single-tenant label
  // would have been a fallback that never fired.
  const { revealed, committedKey } = await commitThenRotate({
    commitMaster: OLD_MASTER, revealMaster: NEW_MASTER, legacy: OLD_MASTER, siteId: SITE,
  });
  assert.equal(revealed, committedKey);
});

test("rotation: a WRONG previous master opens nothing — the commitment is still the authority", async () => {
  // The fallback is a second guess, not a bypass. Supplying some other master must leave the day
  // shut rather than revealing it under a seed that does not match what was published.
  const { revealed } = await commitThenRotate({
    commitMaster: OLD_MASTER, revealMaster: NEW_MASTER, legacy: "a-third-unrelated-master-seed-cccccccccc",
  });
  assert.equal(revealed, null);
});

test("rotation: the legacy master never commits a new day, so it cannot extend its own life", async () => {
  /**
   * The load-bearing containment property. The legacy value is public (it is the leaked literal in
   * production), so if it could ever derive a seed for a NEW day, configuring it would reintroduce
   * exactly the vulnerability the rotation exists to close.
   */
  const cfg = DEFAULT_VERSIONED_CONFIG;
  const repo = new InMemoryGameRepository();
  const clock = { ms: 1_760_000_000_000 };
  const mgr = new SeedManager(
    NEW_MASTER, new StaticConfigProvider(cfg), repo, () => clock.ms,
    { ...OPTS, legacyMasterSeed: OLD_MASTER }, SITE,
  );
  const ctx = await mgr.init();

  // The active day's seed must come from the NEW master and from nothing else.
  const underNew = new SeedManager(NEW_MASTER, new StaticConfigProvider(cfg), repo, () => clock.ms, OPTS, SITE);
  const expected = await underNew.init();
  assert.equal(ctx.seed, expected.seed, "a new day must be derived from the current master");
  assert.equal(ctx.seedHash, expected.seedHash);

  const underOld = new SeedManager(OLD_MASTER, new StaticConfigProvider(cfg), new InMemoryGameRepository(), () => clock.ms, OPTS, SITE);
  const leaked = await underOld.init();
  assert.notEqual(ctx.seed, leaked.seed, "a new day must NOT be derivable from the legacy master");
});

test("rotation mid-day: the day keeps the curve and seed it PUBLISHED, not a new one", async () => {
  /**
   * The failure this rules out is the quiet one. Rotate the master, restart the engine mid-day, and
   * without this the engine derives a different seed for the same day while `fn_ensure_game_day`
   * (`on conflict do nothing`) keeps the old commitment: the brand's entire price curve changes
   * under live positions, and the commitment on display stops describing the day being traded.
   * Nothing errors. The fairness guarantee is simply no longer true for that day.
   */
  const cfg = DEFAULT_VERSIONED_CONFIG;
  const repo = new InMemoryGameRepository();
  const clock = { ms: 1_760_000_000_000 };

  // Day committed under the OLD master.
  const before = new SeedManager(OLD_MASTER, new StaticConfigProvider(cfg), repo, () => clock.ms, OPTS, SITE);
  const published = await before.init();

  // Master rotated, engine restarted, SAME day still in progress.
  const after = new SeedManager(
    NEW_MASTER, new StaticConfigProvider(cfg), repo, () => clock.ms,
    { ...OPTS, legacyMasterSeed: OLD_MASTER }, SITE,
  );
  const resumed = await after.init();

  assert.equal(resumed.dateKey, published.dateKey, "same trade day");
  assert.equal(resumed.seed, published.seed, "the day must keep the seed it was committed with");
  assert.equal(resumed.seedHash, published.seedHash, "and therefore the commitment on display stays true");
  // The curve is what players actually see; prove it is the same axis, not merely the same seed.
  assert.equal(resumed.curve.rate(60_000), published.curve.rate(60_000), "no price discontinuity mid-day");
  assert.equal(resumed.curve.rate(3_600_000), published.curve.rate(3_600_000));
});

test("rotation: the NEXT day is derived from the new master, so the rotation completes itself", async () => {
  const cfg = DEFAULT_VERSIONED_CONFIG;
  const repo = new InMemoryGameRepository();
  const clock = { ms: 1_760_000_000_000 };

  const before = new SeedManager(OLD_MASTER, new StaticConfigProvider(cfg), repo, () => clock.ms, OPTS, SITE);
  await before.init();

  const after = new SeedManager(
    NEW_MASTER, new StaticConfigProvider(cfg), repo, () => clock.ms,
    { ...OPTS, legacyMasterSeed: OLD_MASTER }, SITE,
  );
  await after.init();
  clock.ms += DAY_MS;
  const { active, revealed } = await after.rotate();

  // Yesterday opened via the legacy fallback...
  assert.ok(revealed, "the previously committed day must still be revealable");
  // ...and today is the new master's, with the legacy seed nowhere near it.
  const underNew = new SeedManager(NEW_MASTER, new StaticConfigProvider(cfg), new InMemoryGameRepository(), () => clock.ms, OPTS, SITE);
  const expected = await underNew.init();
  assert.equal(active.seed, expected.seed, "a fresh day is derived from the CURRENT master");
  const underOld = new SeedManager(OLD_MASTER, new StaticConfigProvider(cfg), new InMemoryGameRepository(), () => clock.ms, OPTS, SITE);
  const leaked = await underOld.init();
  assert.notEqual(active.seed, leaked.seed, "and never from the legacy one");
});
