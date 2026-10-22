import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VERSIONED_CONFIG, DEFAULT_POOL_KNOBS, type VersionedGameConfig } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { StaticConfigProvider } from "./gameconfig.js";
import { SiteRegistry } from "./siteregistry.js";
import { startMultiEngine } from "./multiengine.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";
import { WsTestClient as Client, SETTLE_MS } from "./wstestkit.js";

/** Phase 2 — MULTIPLIER contracts end-to-end over the real WebSocket transport. */
const SITE = "00000000-0000-0000-0000-0000000000dd";
const cfg: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, minStakeCents: 25000 };

/**
 * The shared test client (wstestkit.ts) replaces this file's private one: same `waitFor`, plus a
 * `waitWhere` that awaits "the frame that says X" and ceilings scaled off measured idle cost rather
 * than a hand-picked 6000. `mult_update` only arrives on the instrument's own 1s tick, so the waits
 * that ride that stream take `SETTLE_MS`.
 */

async function boot(pool?: { controller: PoolController }) {
  const repo = new InMemoryGameRepository();
  const seeded = new Set<string>();
  const registry = new SiteRegistry({
    masterSeed: "platform-master-mult-test",
    repo,
    configFor: () => new StaticConfigProvider(cfg),
    seedManagerOpts: { calibrationSamples: 4000 },
    ...(pool ? { poolController: pool.controller, poolModeFor: () => true } : {}),
  });
  const handle = await startMultiEngine({
    port: 0, registry, repo, verifier: null,
    resolveSite: (req) => new URL(req.url ?? "/", "http://x").searchParams.get("site") ?? SITE,
    devSeedBalance: (_s, u) => { if (!seeded.has(u)) { seeded.add(u); repo.seed(u, 1_000_000); } },
    onError: () => { /* quiet */ },
  });
  const port = (handle.wss.address() as any).port as number;
  return { handle, url: `ws://127.0.0.1:${port}/?site=${SITE}` };
}

test("multiplier WS (statistical): open → live mult_update stream → manual close pays stake + P/L", async () => {
  const { handle, url } = await boot();
  const c = new Client(url);
  try {
    await c.open(); await c.waitFor("hello");
    c.send("auth", { userId: "m1" });
    const bal0 = await c.waitFor("balance");
    assert.equal(bal0.data.real, 1_000_000);

    const balFramesBeforeOpen = c.of("balance").length;
    c.send("open_multiplier", { instrumentId: "vol10_1s", dir: "up", multiplier: 50, stakeCents: 25000 });
    const opened = await c.waitFor("mult_opened");
    assert.ok(Number.isFinite(opened.data.entry) && opened.data.entry > 0);
    // The debit arrives in a balance frame sent AFTER mult_opened, behind a wallet round-trip, so
    // await that frame rather than sampling the newest one: sampling reads the pre-open auth
    // snapshot whenever the runner is busy, which is exactly how deploy 170 broke on the digit path.
    await c.waitWhere("balance", () => c.of("balance").length > balFramesBeforeOpen);
    assert.equal(c.of("balance").at(-1).data.real, 975_000, "stake debited on open");

    const upd = await c.waitFor("mult_update", SETTLE_MS); // streamer evaluates every instrument tick (1s)
    assert.equal(upd.data.positionId, opened.data.positionId);
    assert.ok(Number.isFinite(upd.data.pnlCents) && upd.data.pnlCents >= -25000);

    c.send("close_multiplier", { positionId: opened.data.positionId });
    const closed = await c.waitFor("mult_closed", SETTLE_MS);
    assert.equal(closed.data.positionId, opened.data.positionId);
    assert.equal(closed.data.reason, "manual");
    assert.equal(closed.data.payoutCents, 25000 + closed.data.pnlCents, "payout = stake + realized P/L");
    assert.equal(closed.data.balance, 975_000 + closed.data.payoutCents, "balance reconciles exactly");
  } finally { c.close(); await handle.close(); }
});

test("multiplier WS (POOL MODE): manual close is refused; the decided path governs", async () => {
  const poolRepo = new InMemoryPoolRepo();
  poolRepo.setPool(SITE, eatDay(Date.now()), 5_000_000);
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS);
  const { handle, url } = await boot({ controller });
  const c = new Client(url);
  try {
    await c.open(); await c.waitFor("hello");
    c.send("auth", { userId: "m2" }); await c.waitFor("balance");
    c.send("open_multiplier", { instrumentId: "vol10_1s", dir: "up", multiplier: 100, stakeCents: 25000, slCents: 10000, dcMinutes: 5 });
    const opened = await c.waitFor("mult_opened");
    assert.equal(opened.data.slCents, null, "SL stripped in pool mode");
    assert.equal(opened.data.dcUntilMs, null, "DC stripped in pool mode");
    assert.equal(opened.data.tpCents, 25000, "TP defaults to +100% of stake in pool mode");
    c.send("close_multiplier", { positionId: opened.data.positionId });
    const err = await c.waitFor("error");
    assert.match(String(err.data.message ?? ""), /CLOSE_DISABLED/, "manual close refused in pool mode");
    const upd = await c.waitFor("mult_update", SETTLE_MS); // the decided path still streams live P/L
    assert.ok(Number.isFinite(upd.data.pnlCents));
  } finally { c.close(); await handle.close(); }
});
