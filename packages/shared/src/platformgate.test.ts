import { test } from "node:test";
import assert from "node:assert/strict";
import { PlatformGate } from "./platformgate.js";

const row = (o: Record<string, unknown>) => ({ rows: [o] });
const ALL = { deposits_enabled: true, withdrawals_enabled: true, play_enabled: true, marketers_enabled: true, registrations_enabled: true, maintenance_message: null, version: 3 };

test("PlatformGate: reads flags and gates each system", async () => {
  let calls = 0;
  const g = new PlatformGate(async () => { calls++; return row({ ...ALL, withdrawals_enabled: false, play_enabled: false, maintenance_message: "back at 2am" }); }, 5000);
  assert.equal(await g.allows("deposits"), true);
  assert.equal(await g.allows("withdrawals"), false);
  assert.equal(await g.allows("play"), false);
  assert.equal(await g.allows("marketers"), true);
  assert.equal(await g.allows("registrations"), true);
  const f = await g.flags();
  assert.equal(f.maintenanceMessage, "back at 2am");
  assert.equal(f.version, 3);
  assert.equal(calls, 1, "cached within TTL — one read for all queries");
});

test("PlatformGate: TTL expiry triggers a re-read", async () => {
  let calls = 0;
  const g = new PlatformGate(async () => { calls++; return row(ALL); }, 0); // ttl 0 => always stale
  await g.flags(); await g.flags();
  assert.ok(calls >= 2, "ttl=0 re-reads every call");
});

test("PlatformGate: FAIL-OPEN on read error (never self-block)", async () => {
  const g = new PlatformGate(async () => { throw new Error("db down"); }, 0);
  assert.equal(await g.allows("deposits"), true);
  assert.equal(await g.allows("withdrawals"), true);
  assert.equal(await g.allows("play"), true);
});

test("PlatformGate: null query (dev/no-DB) => everything ON", async () => {
  const g = new PlatformGate(null);
  for (const s of ["deposits", "withdrawals", "play", "marketers", "registrations"] as const)
    assert.equal(await g.allows(s), true);
});

test("PlatformGate: missing/undefined booleans treated as ON (fail-open shape)", async () => {
  const g = new PlatformGate(async () => row({ version: 1 }), 0);
  assert.equal(await g.allows("deposits"), true);
  assert.equal(await g.allows("marketers"), true);
});
