import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VERSIONED_CONFIG, type VersionedGameConfig } from "@invest254/shared";
import { SiteRegistry } from "./siteregistry.js";
import { InMemoryGameRepository } from "./wallet.js";
import type { ConfigProvider, ConfigChangeListener } from "./gameconfig.js";

const SITE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** A live config provider whose `set()` fires subscribers — stands in for a SiteGameConfigStore. */
class FakeProvider implements ConfigProvider {
  private readonly listeners = new Set<ConfigChangeListener>();
  constructor(private cfg: VersionedGameConfig) {}
  active(): VersionedGameConfig { return this.cfg; }
  async forVersion(): Promise<VersionedGameConfig> { return this.cfg; }
  subscribe(l: ConfigChangeListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  set(next: VersionedGameConfig): void {
    const prev = this.cfg; this.cfg = next;
    for (const l of this.listeners) l(next, prev);
  }
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("SiteRegistry: a pricing edit re-prices the brand's next round; a non-pricing edit does not rebuild", async () => {
  const repo = new InMemoryGameRepository();
  const provider = new FakeProvider({ ...DEFAULT_VERSIONED_CONFIG, volatility: 1.0, tickRateMs: 150, maxStakeCents: 100_000, version: 1 });
  const registry = new SiteRegistry({
    masterSeed: "registry-hotreload-master",
    repo,
    configFor: () => provider,
    now: () => 0,
    seedManagerOpts: { calibrationSamples: 2000 },
  });
  try {
    const rt = await registry.ensure(SITE);
    assert.equal(rt.seeds.getActive().configVersion, 1);
    const curveV1 = rt.seeds.getActive().curve.value(12.5);
    rt.game.start();
    assert.equal(rt.game.currentTickRateMs(), 150);

    // (1) PRICING edit (volatility) + tick change -> rebuild seeds AND re-arm the tick loop.
    provider.set({ ...provider.active(), volatility: 2.5, tickRateMs: 500, version: 2 });
    await waitFor(() => rt.seeds.getActive().configVersion === 2);
    assert.notEqual(rt.seeds.getActive().curve.value(12.5), curveV1, "curve must actually change after a pricing edit");
    await waitFor(() => rt.game.currentTickRateMs() === 500);

    // (2) NON-pricing edit (stake ceiling only) -> NO seed rebuild, but read live by the GameServer.
    provider.set({ ...provider.active(), maxStakeCents: 900_000, version: 3 });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rt.seeds.getActive().configVersion, 2, "non-pricing edit must not recalibrate (still v2 context)");
    assert.equal(rt.game.onlineConfigSnapshot().maxStakeCents, 900_000, "but the new stake bound is live immediately");
  } finally {
    registry.stopAll();
  }
});
