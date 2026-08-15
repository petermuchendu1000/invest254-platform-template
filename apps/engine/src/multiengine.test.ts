import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { DEFAULT_VERSIONED_CONFIG, type VersionedGameConfig } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { StaticConfigProvider } from "./gameconfig.js";
import { SiteRegistry } from "./siteregistry.js";
import { startMultiEngine, type MultiEngineHandle } from "./multiengine.js";

const SITE_A = "00000000-0000-0000-0000-0000000000aa";
const SITE_B = "00000000-0000-0000-0000-0000000000bb";

// Two brands, DIFFERENT economies. Fast rounds so the settle path resolves within the test.
const cfgA: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, minStakeCents: 25000, defaultDurationS: 1, tickRateMs: 60 };
const cfgB: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, minStakeCents: 50000, defaultDurationS: 1, tickRateMs: 60 };
const CONFIGS: Record<string, VersionedGameConfig> = { [SITE_A]: cfgA, [SITE_B]: cfgB };

/** Minimal message-collecting WS client. */
class Client {
  ws: WebSocket;
  msgs: any[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => { try { this.msgs.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  }
  open(): Promise<void> { return new Promise((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); }); }
  send(type: string, data: unknown) { this.ws.send(JSON.stringify({ type, data })); }
  of(type: string) { return this.msgs.filter((m) => m.type === type); }
  async waitFor(type: string, timeoutMs = 3000): Promise<any> {
    const found = this.msgs.find((m) => m.type === type);
    if (found) return found;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
      const h = (raw: any) => { try { const m = JSON.parse(String(raw)); if (m.type === type) { clearTimeout(t); this.ws.off("message", h); res(m); } } catch { /* ignore */ } };
      this.ws.on("message", h);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(): Promise<{ handle: MultiEngineHandle; repo: InMemoryGameRepository; url: (site: string) => string }> {
  const repo = new InMemoryGameRepository();
  const seeded = new Set<string>();
  const registry = new SiteRegistry({
    masterSeed: "platform-master-test",
    repo,
    configFor: (siteId) => new StaticConfigProvider(CONFIGS[siteId] ?? cfgA),
    seedManagerOpts: { calibrationSamples: 4000 }, // small = fast calibration in tests
  });
  const handle = await startMultiEngine({
    port: 0,
    registry,
    repo,
    verifier: null, // dev auth: client supplies userId
    resolveSite: (req) => {
      const u = new URL(req.url ?? "/", "http://x");
      const s = u.searchParams.get("site");
      if (!s) throw new Error("no site");
      return s;
    },
    devSeedBalance: (_siteId, userId) => { if (!seeded.has(userId)) { seeded.add(userId); repo.seed(userId, 1_000_000); } },
    onError: () => { /* quiet in tests */ },
  });
  const port = (handle.wss.address() as any).port as number;
  return { handle, repo, url: (site) => `ws://127.0.0.1:${port}/?site=${site}` };
}

test("multiplex: two brands get isolated, decorrelated tick streams + independent online counts", async () => {
  const { handle, url } = await boot();
  const a = new Client(url(SITE_A)); const b = new Client(url(SITE_B));
  try {
    await a.open(); await b.open();
    const helloA = await a.waitFor("hello"); const helloB = await b.waitFor("hello");
    assert.equal(helloA.data.site, SITE_A);
    assert.equal(helloB.data.site, SITE_B);
    assert.notEqual(helloA.data.serverSeedHash, helloB.data.serverSeedHash, "each brand commits its own seed");

    await sleep(600); // let ticks flow
    const ratesA = a.of("tick").slice(0, 6).map((m) => m.data.rate);
    const ratesB = b.of("tick").slice(0, 6).map((m) => m.data.rate);
    assert.ok(ratesA.length >= 3 && ratesB.length >= 3, "both brands stream ticks");
    assert.notDeepEqual(ratesA, ratesB, "brand curves are decorrelated (different seeds)");

    // online is counted PER brand (each brand has exactly one socket, not two)
    const onlineA = a.of("online").at(-1); const onlineB = b.of("online").at(-1);
    assert.equal(onlineA.data.count, 1);
    assert.equal(onlineB.data.count, 1);
  } finally { a.close(); b.close(); await handle.close(); }
});

test("multiplex: auth, open, settle are fully isolated between brands", async () => {
  const { handle, url } = await boot();
  const a = new Client(url(SITE_A)); const b = new Client(url(SITE_B));
  try {
    await a.open(); await b.open();
    await a.waitFor("hello"); await b.waitFor("hello");
    a.send("auth", { userId: "userA" }); b.send("auth", { userId: "userB" });
    const balA = await a.waitFor("balance"); const balB = await b.waitFor("balance");
    assert.equal(balA.data.real, 1_000_000);
    assert.equal(balB.data.real, 1_000_000);

    // userA opens a valid position on brand A
    a.send("open_position", { stakeCents: 25000, direction: "buy", durationS: 1 });
    const opened = await a.waitFor("position_opened");
    assert.ok(opened.data.positionId);
    // A's balance debited
    const balAfter = a.of("balance").at(-1);
    assert.equal(balAfter.data.real, 975_000, "stake debited on brand A");

    // brand B must NOT see any of A's position events
    await sleep(200);
    assert.equal(b.of("position_opened").length, 0, "brand B never sees brand A's open");

    // wait for auto-settle (~1s round) on A
    const settled = await a.waitFor("position_settled", 4000);
    assert.equal(settled.data.positionId, opened.data.positionId);
    assert.ok(["win", "loss"].includes(settled.data.result));
    assert.equal(b.of("position_settled").length, 0, "brand B never sees brand A's settle");
  } finally { a.close(); b.close(); await handle.close(); }
});

test("multiplex: resolveSite may be async — a brand resolved LIVE (onboarded after boot) still streams", async () => {
  // GAP 2: the boot alias map does not know this brand; an async resolver (mimicking a live `sites`
  // lookup) resolves it on connect, and the registry builds its runtime on demand. Proves the
  // `await opts.resolveSite(req)` path end-to-end: resolve → ensure → hello + ticks.
  const repo = new InMemoryGameRepository();
  const registry = new SiteRegistry({
    masterSeed: "platform-master-test",
    repo,
    configFor: (siteId) => new StaticConfigProvider(CONFIGS[siteId] ?? cfgA),
    seedManagerOpts: { calibrationSamples: 4000 },
  });
  let lookups = 0;
  const handle = await startMultiEngine({
    port: 0,
    registry,
    repo,
    verifier: null,
    resolveSite: async (req) => {
      const u = new URL(req.url ?? "/", "http://x");
      const s = u.searchParams.get("site");
      await sleep(5);            // simulate a DB round-trip
      lookups++;
      if (s === SITE_A) return SITE_A;
      throw new Error("unknown site");
    },
    onError: () => { /* quiet */ },
  });
  const port = (handle.wss.address() as any).port as number;
  const known = new Client(`ws://127.0.0.1:${port}/?site=${SITE_A}`);
  // Capture the close code from construction time — the server rejects the unknown brand within
  // ~5ms, so the listener must be attached before that (not after the known-brand assertions).
  const unknown = new Client(`ws://127.0.0.1:${port}/?site=${SITE_B}`);
  let unknownCloseCode = -1;
  unknown.ws.on("close", (code: number) => { unknownCloseCode = code; });
  unknown.ws.on("error", () => { /* expected: connection rejected */ });
  try {
    await known.open();
    const hello = await known.waitFor("hello");
    assert.equal(hello.data.site, SITE_A, "async-resolved brand connects and streams");
    await sleep(300);
    assert.ok(known.of("tick").length >= 2, "live-resolved brand receives ticks");
    assert.ok(lookups >= 1, "the async resolver was awaited");

    // an unresolved brand is cleanly rejected (async throw → close 1008), not left hanging
    assert.equal(unknown.of("hello").length, 0, "unknown brand never gets a hello");
    assert.equal(unknownCloseCode, 1008, "unknown brand connection is closed with 1008");
  } finally { known.close(); unknown.close(); await handle.close(); }
});

test("multiplex: per-brand stake bounds are enforced independently", async () => {
  const { handle, url } = await boot();
  const b = new Client(url(SITE_B));
  try {
    await b.open(); await b.waitFor("hello");
    b.send("auth", { userId: "userB2" });
    await b.waitFor("balance");
    // 30000 is >= brand A min (25000) but < brand B min (50000) -> rejected on B
    b.send("open_position", { stakeCents: 30000, direction: "buy", durationS: 1 });
    const err = await b.waitFor("error");
    assert.match(String(err.data.message ?? err.data.code), /STAKE_BELOW_MIN|min/i, "brand B enforces its own higher min");
    // a valid stake on B works
    b.send("open_position", { stakeCents: 50000, direction: "sell", durationS: 1 });
    const ok = await b.waitFor("position_opened");
    assert.ok(ok.data.positionId);
  } finally { b.close(); await handle.close(); }
});
