import { test } from "node:test";
import assert from "node:assert/strict";
import { PoolOpsService, type PoolAutoSettings, type PoolOpsRepository } from "./poolops.js";
import type { PlatformService } from "./platform.js";

class Repo implements PoolOpsRepository {
  s: PoolAutoSettings = { platformId: "p1", mode: "dynamic", dailyTotalCents: null, lookbackDays: 14, isDefault: true, lastRunAtMs: null, lastRunOk: null, lastRunMessage: null, updatedAtMs: null };
  runs: Array<[boolean, string]> = []; marks: string[] = [];
  async overview() { return []; }
  async getSettings() { return { ...this.s }; }
  async setSettings(_a: string, _r: string, _p: string, v: { mode: PoolAutoSettings["mode"]; dailyTotalCents: number | null; lookbackDays: number }) { Object.assign(this.s, v, { isDefault: false }); }
  async recordRun(_p: string, ok: boolean, m: string) { this.runs.push([ok, m]); }
  async markLatest(_a: string, _p: string | null, src: string) { this.marks.push(src); }
  async activePlatforms() { return ["p1"]; }
}
function fakePlatform(calls: unknown[], fail?: string): PlatformService {
  return {
    async distributePool(...a: unknown[]) { calls.push(["equal", ...a]); if (fail) throw new Error(fail); return { totalCents: a[2], mode: "equal", perSite: { s1: 1, s2: 1 } }; },
    async poolDemand() { return { totalCents: 400000, rows: [] }; },
    async distributePoolDynamic(...a: unknown[]) { calls.push(["dynamic", ...a]); if (fail) throw new Error(fail);
      return { totalCents: 0, mode: "per_site", perSite: {}, preview: { rows: [{}, {}, {}], suggestedTotalCents: 300000, reserveCents: 5000 } }; },
  } as unknown as PlatformService;
}

test("POOL-1: with nothing saved the daily run is DYNAMIC over the current total, labelled auto, and recorded", async () => {
  const repo = new Repo(); const calls: any[] = [];
  const r = await new PoolOpsService(repo, fakePlatform(calls)).runAuto("own", "platform_superadmin", "p1");
  assert.equal(r.ok, true); assert.equal(r.mode, "dynamic");
  assert.equal(calls[0][0], "dynamic");
  assert.deepEqual(calls[0][3], { lookbackDays: 14 }, "no totalCents = keep the platform's current total");
  assert.equal(calls[0][4], "p1");
  assert.deepEqual(repo.marks, ["auto"]);
  assert.match(repo.runs[0]![1], /Split KES 3,000 across 3 brand\(s\) by demand, KES 50 held in reserve/);
});

test("POOL-1: a configured total and equal mode are honoured; off does nothing; failures are recorded, not thrown", async () => {
  const repo = new Repo(); const calls: any[] = [];
  const svc = new PoolOpsService(repo, fakePlatform(calls));
  await svc.saveSettings("pa", "platform_admin", "p1", { mode: "dynamic", dailyTotalCents: 500000, lookbackDays: 21 });
  await svc.runAuto("pa", "platform_admin", "p1", "dynamic");
  assert.deepEqual(calls[0][3], { lookbackDays: 21, totalCents: 500000 }); assert.deepEqual(repo.marks, ["dynamic"]);
  await svc.saveSettings("pa", "platform_admin", "p1", { mode: "equal", dailyTotalCents: 200000, lookbackDays: 14 });
  const eq = await svc.runAuto("pa", "platform_admin", "p1");
  assert.equal(calls[1][0], "equal"); assert.equal(calls[1][3], 200000); assert.match(eq.message, /evenly across 2 brand/);
  await svc.saveSettings("pa", "platform_admin", "p1", { mode: "off", dailyTotalCents: null, lookbackDays: 14 });
  const off = await svc.runAuto("pa", "platform_admin", "p1");
  assert.equal(calls.length, 2, "off never distributes"); assert.match(off.message, /off/);
  const bad = await new PoolOpsService(new Repo(), fakePlatform([], "NO_ACTIVE_SITES")).runAuto("own", "platform_superadmin", "p1");
  assert.equal(bad.ok, false); assert.equal(bad.message, "No active brands with the pool on.");
});

test("POOL-1: with no daily total and no budget anywhere, the run explains instead of writing an empty distribution", async () => {
  const calls: any[] = [];
  const p = { async poolDemand() { return { totalCents: 0, rows: [] }; }, async distributePoolDynamic() { calls.push(1); } } as unknown as PlatformService;
  const r = await new PoolOpsService(new Repo(), p).runAuto("own", "platform_superadmin", "p1");
  assert.equal(r.ok, true); assert.match(r.message, /Set a daily total/); assert.equal(calls.length, 0);
});
