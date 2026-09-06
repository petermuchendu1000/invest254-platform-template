import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { DEFAULT_VERSIONED_CONFIG, DEFAULT_POOL_KNOBS, type VersionedGameConfig } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { StaticConfigProvider } from "./gameconfig.js";
import { SiteRegistry } from "./siteregistry.js";
import { startMultiEngine, type MultiEngineHandle } from "./multiengine.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";

/**
 * Phase 2 — DIGIT contracts end-to-end over the real WebSocket transport (in-memory brand).
 * Proves: subscribe → authoritative per-instrument stream (history + live) → open_digit debits the
 * stake → the engine settles at settleIndex against the SAME digit the chart showed → payout uses
 * the DIGIT factor. This is the full client-reachable path the classic game lacked for contracts.
 */
const SITE = "00000000-0000-0000-0000-0000000000cc";
const cfg: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, minStakeCents: 25000, digitPayoutFactor: 0.95 };

class Client {
  ws: WebSocket; msgs: any[] = [];
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.on("message", (r) => { try { this.msgs.push(JSON.parse(String(r))); } catch { /* ignore */ } }); }
  open(): Promise<void> { return new Promise((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); }); }
  send(type: string, data: unknown) { this.ws.send(JSON.stringify({ type, data })); }
  of(type: string) { return this.msgs.filter((m) => m.type === type); }
  waitFor(type: string, timeoutMs = 5000): Promise<any> {
    const f = this.msgs.find((m) => m.type === type); if (f) return Promise.resolve(f);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
      const h = (raw: any) => { try { const m = JSON.parse(String(raw)); if (m.type === type) { clearTimeout(t); this.ws.off("message", h); res(m); } } catch { /* ignore */ } };
      this.ws.on("message", h);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function boot(): Promise<{ handle: MultiEngineHandle; url: string }> {
  const repo = new InMemoryGameRepository();
  const seeded = new Set<string>();
  const registry = new SiteRegistry({
    masterSeed: "platform-master-digits-test",
    repo,
    configFor: () => new StaticConfigProvider(cfg),
    seedManagerOpts: { calibrationSamples: 4000 },
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

test("digits WS: subscribe streams authoritative history + live ticks", async () => {
  const { handle, url } = await boot();
  const c = new Client(url);
  try {
    await c.open(); await c.waitFor("hello");
    c.send("auth", { userId: "d1" }); await c.waitFor("balance");
    c.send("subscribe_instrument", { instrumentId: "vol10_1s" });
    const hist = await c.waitFor("inst_history");
    assert.equal(hist.data.instrumentId, "vol10_1s");
    assert.ok(hist.data.ticks.length > 10, "history backfills the chart");
    assert.equal(hist.data.tickMs, 1000);
    for (const t of hist.data.ticks) assert.ok(t.digit >= 0 && t.digit <= 9);
    const live = await c.waitFor("inst_tick");
    assert.equal(live.data.instrumentId, "vol10_1s");
    assert.ok(Number.isFinite(live.data.quote) && live.data.digit >= 0 && live.data.digit <= 9);
  } finally { c.close(); await handle.close(); }
});

test("digits WS: open_digit debits stake, settles at settleIndex, chart digit == settled digit", async () => {
  const { handle, url } = await boot();
  const c = new Client(url);
  try {
    await c.open(); await c.waitFor("hello");
    c.send("auth", { userId: "d2" });
    const bal0 = await c.waitFor("balance");
    assert.equal(bal0.data.real, 1_000_000);
    c.send("subscribe_instrument", { instrumentId: "vol10_1s" });
    await c.waitFor("inst_history");

    c.send("open_digit", { instrumentId: "vol10_1s", kind: "even", stakeCents: 25000 });
    const opened = await c.waitFor("digit_opened");
    assert.equal(opened.data.settleIndex, opened.data.openIndex + 1, "1-tick contract");
    // stake debited immediately
    const balAfterOpen = c.of("balance").at(-1);
    assert.equal(balAfterOpen.data.real, 975_000, "stake debited on open");

    const settled = await c.waitFor("digit_settled");
    assert.equal(settled.data.positionId, opened.data.positionId);
    assert.equal(settled.data.index, opened.data.settleIndex, "settled at the committed settleIndex");
    assert.ok(settled.data.digit >= 0 && settled.data.digit <= 9);
    assert.equal(settled.data.won, settled.data.digit % 2 === 0, "even wins iff digit is even");

    // The tick frame the CHART showed at settleIndex must carry the SAME digit (fairness parity).
    const chartTick = c.of("inst_tick").find((m) => m.data.index === opened.data.settleIndex);
    assert.ok(chartTick, "the settle-index tick was streamed to the chart");
    assert.equal(chartTick.data.digit, settled.data.digit, "on-chart digit == settlement digit");

    // Money: win pays round(stake*0.95/0.5)=47500 (net +22500); loss pays 0.
    if (settled.data.won) {
      assert.equal(settled.data.payoutCents, 47500);
      assert.equal(settled.data.pnlCents, 22500);
      assert.equal(settled.data.balance, 1_022_500);
    } else {
      assert.equal(settled.data.payoutCents, 0);
      assert.equal(settled.data.pnlCents, -25000);
      assert.equal(settled.data.balance, 975_000);
    }
  } finally { c.close(); await handle.close(); }
});

test("digits WS: an unknown instrument id is rejected (no spoofing)", async () => {
  const { handle, url } = await boot();
  const c = new Client(url);
  try {
    await c.open(); await c.waitFor("hello");
    c.send("auth", { userId: "d3" }); await c.waitFor("balance");
    c.send("subscribe_instrument", { instrumentId: "vol999_evil" });
    const err = await c.waitFor("error");
    assert.equal(err.data.code, "INVALID_INSTRUMENT");
  } finally { c.close(); await handle.close(); }
});

test("digits WS (POOL MODE): outcome is pool-decided and the owner's settle-index tick carries the decided digit", async () => {
  const repo = new InMemoryGameRepository();
  const poolRepo = new InMemoryPoolRepo();
  const controller = new PoolController(poolRepo, DEFAULT_POOL_KNOBS);
  poolRepo.setPool(SITE, eatDay(Date.now()), 5_000_000); // fund today's EAT-day pool
  const seeded = new Set<string>();
  const registry = new SiteRegistry({
    masterSeed: "platform-master-digits-pool",
    repo,
    configFor: () => new StaticConfigProvider(cfg),
    seedManagerOpts: { calibrationSamples: 4000 },
    poolController: controller,
    poolModeFor: () => true,
  });
  const handle = await startMultiEngine({
    port: 0, registry, repo, verifier: null,
    resolveSite: (req) => new URL(req.url ?? "/", "http://x").searchParams.get("site") ?? SITE,
    devSeedBalance: (_s, u) => { if (!seeded.has(u)) { seeded.add(u); repo.seed(u, 1_000_000); } },
    onError: () => { /* quiet */ },
  });
  const port = (handle.wss.address() as any).port as number;
  const c = new Client(`ws://127.0.0.1:${port}/?site=${SITE}`);
  try {
    await c.open(); await c.waitFor("hello");
    c.send("auth", { userId: "poolp" });
    await c.waitFor("balance");
    c.send("subscribe_instrument", { instrumentId: "vol10_1s" });
    await c.waitFor("inst_history");

    c.send("open_digit", { instrumentId: "vol10_1s", kind: "even", stakeCents: 25000 });
    const opened = await c.waitFor("digit_opened");
    const settled = await c.waitFor("digit_settled");
    assert.equal(settled.data.positionId, opened.data.positionId);

    // The decision governs: digit parity must reproduce the decided result exactly.
    assert.equal(settled.data.won, settled.data.digit % 2 === 0, "digit is consistent with the pool decision");
    if (settled.data.won) {
      assert.equal(settled.data.payoutCents, 47500, "fixed-odds pool win pays the full contract return");
    } else {
      assert.equal(settled.data.payoutCents, 0);
    }
    // The OWNER's chart tick at settleIndex must carry the SAME (possibly overridden) digit.
    const chartTick = c.of("inst_tick").find((m) => m.data.index === opened.data.settleIndex);
    assert.ok(chartTick, "the settle-index tick was streamed to the owner");
    assert.equal(chartTick.data.digit, settled.data.digit, "owner's on-chart digit == pool-decided settled digit");
    assert.equal(Math.round(chartTick.data.quote * 100) % 10, settled.data.digit, "quote's last pip matches too");
  } finally { c.close(); await handle.close(); }
});
