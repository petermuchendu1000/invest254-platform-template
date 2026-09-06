import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { DEFAULT_VERSIONED_CONFIG, DEFAULT_POOL_KNOBS, type VersionedGameConfig } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { StaticConfigProvider } from "./gameconfig.js";
import { SiteRegistry } from "./siteregistry.js";
import { startMultiEngine } from "./multiengine.js";
import { PoolController, InMemoryPoolRepo, eatDay } from "./poolcontroller.js";

/** Phase 2 — MULTIPLIER contracts end-to-end over the real WebSocket transport. */
const SITE = "00000000-0000-0000-0000-0000000000dd";
const cfg: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, minStakeCents: 25000 };

class Client {
  ws: WebSocket; msgs: any[] = [];
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.on("message", (r) => { try { this.msgs.push(JSON.parse(String(r))); } catch { /* ignore */ } }); }
  open(): Promise<void> { return new Promise((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); }); }
  send(type: string, data: unknown) { this.ws.send(JSON.stringify({ type, data })); }
  of(type: string) { return this.msgs.filter((m) => m.type === type); }
  waitFor(type: string, timeoutMs = 6000): Promise<any> {
    const f = this.msgs.find((m) => m.type === type); if (f) return Promise.resolve(f);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
      const h = (raw: any) => { try { const m = JSON.parse(String(raw)); if (m.type === type) { clearTimeout(t); this.ws.off("message", h); res(m); } } catch { /* ignore */ } };
      this.ws.on("message", h);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

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

    c.send("open_multiplier", { instrumentId: "vol10_1s", dir: "up", multiplier: 50, stakeCents: 25000 });
    const opened = await c.waitFor("mult_opened");
    assert.ok(Number.isFinite(opened.data.entry) && opened.data.entry > 0);
    assert.equal(c.of("balance").at(-1).data.real, 975_000, "stake debited on open");

    const upd = await c.waitFor("mult_update"); // streamer evaluates every instrument tick (1s)
    assert.equal(upd.data.positionId, opened.data.positionId);
    assert.ok(Number.isFinite(upd.data.pnlCents) && upd.data.pnlCents >= -25000);

    c.send("close_multiplier", { positionId: opened.data.positionId });
    const closed = await c.waitFor("mult_closed");
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
    const upd = await c.waitFor("mult_update"); // the decided path still streams live P/L
    assert.ok(Number.isFinite(upd.data.pnlCents));
  } finally { c.close(); await handle.close(); }
});
