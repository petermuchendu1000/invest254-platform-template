import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VERSIONED_CONFIG, type VersionedGameConfig } from "@invest254/shared";
import { InMemoryGameRepository } from "./wallet.js";
import { StaticConfigProvider } from "./gameconfig.js";
import { SiteRegistry } from "./siteregistry.js";
import { startMultiEngine, type MultiEngineHandle } from "./multiengine.js";
import { WsTestClient as Client, sleep, SETTLE_MS, REPLY_MS, ticksBudget } from "./wstestkit.js";

const SITE_A = "00000000-0000-0000-0000-0000000000aa";
const SITE_B = "00000000-0000-0000-0000-0000000000bb";

/**
 * The brands' shared tick cadence. "Wait for n ticks" ceilings are a multiple of this, not a flat
 * number, so they track the config instead of being re-guessed if it changes.
 */
const TICK_MS = 60;

// Two brands, DIFFERENT economies. Fast rounds so the settle path resolves within the test.
const cfgA: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, minStakeCents: 25000, defaultDurationS: 1, tickRateMs: TICK_MS };
const cfgB: VersionedGameConfig = { ...DEFAULT_VERSIONED_CONFIG, version: 1, minStakeCents: 50000, defaultDurationS: 1, tickRateMs: TICK_MS };
const CONFIGS: Record<string, VersionedGameConfig> = { [SITE_A]: cfgA, [SITE_B]: cfgB };

async function boot(extra?: { playAllowed?: () => boolean | Promise<boolean>; sitesOfPlatform?: (p: string) => Promise<string[]> }): Promise<{ handle: MultiEngineHandle; repo: InMemoryGameRepository; url: (site: string) => string; platformUrl: string }> {
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
    ...(extra?.playAllowed ? { playAllowed: extra.playAllowed } : {}),
    ...(extra?.sitesOfPlatform ? { sitesOfPlatform: extra.sitesOfPlatform } : {}),
  });
  const port = (handle.wss.address() as any).port as number;
  return { handle, repo, url: (site) => `ws://127.0.0.1:${port}/?site=${site}`, platformUrl: `ws://127.0.0.1:${port}/?platform=1` };
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

    // Await the ticks the comparison samples instead of sleeping for roughly long enough: the
    // slice wants 6 from each brand, so wait for 6 from each. On a busy runner 600ms bought fewer
    // than the 3 the assertion below demands; waiting for the condition cannot buy fewer.
    await Promise.all([
      a.waitUntil(() => a.of("tick").length >= 6, "6 ticks on brand A", ticksBudget(6, TICK_MS)),
      b.waitUntil(() => b.of("tick").length >= 6, "6 ticks on brand B", ticksBudget(6, TICK_MS)),
    ]);
    const ratesA = a.of("tick").slice(0, 6).map((m) => m.data.rate);
    const ratesB = b.of("tick").slice(0, 6).map((m) => m.data.rate);
    assert.ok(ratesA.length >= 3 && ratesB.length >= 3, "both brands stream ticks");
    assert.notDeepEqual(ratesA, ratesB, "brand curves are decorrelated (different seeds)");

    // online is counted PER brand (each brand has exactly one socket, not two). The `online` frame
    // is its own send, after `hello`, so await its arrival rather than sampling for it — reading
    // `.at(-1)` of an empty list threw a TypeError here on a loaded runner rather than failing an
    // assertion.
    await a.waitFor("online"); await b.waitFor("online");
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
    const balFramesBeforeOpen = a.of("balance").length;
    a.send("open_position", { stakeCents: 25000, direction: "buy", durationS: 1 });
    const opened = await a.waitFor("position_opened");
    assert.ok(opened.data.positionId);
    // A's balance debited. The debit rides a balance frame the server sends AFTER position_opened,
    // behind a wallet round-trip, so await THAT frame instead of sampling the newest one — which is
    // still the pre-open snapshot whenever the runner is busy (the deploy-170 failure mode).
    await a.waitWhere("balance", () => a.of("balance").length > balFramesBeforeOpen);
    const balAfter = a.of("balance").at(-1);
    assert.equal(balAfter.data.real, 975_000, "stake debited on brand A");

    // brand B must NOT see any of A's position events. The window is B's own tick stream rather
    // than 200ms of wall clock: it proves B's socket was live and delivering frames throughout,
    // and it gets LONGER, not shorter, when the runner is slow.
    await b.collect(["tick"], (seen) => seen.length >= 3, "3 ticks on brand B after A's open", ticksBudget(3, TICK_MS));
    assert.equal(b.of("position_opened").length, 0, "brand B never sees brand A's open");

    // wait for auto-settle (~1s round) on A
    const settled = await a.waitFor("position_settled", SETTLE_MS);
    assert.equal(settled.data.positionId, opened.data.positionId);
    assert.ok(["win", "loss"].includes(settled.data.result));
    assert.equal(b.of("position_settled").length, 0, "brand B never sees brand A's settle");
  } finally { a.close(); b.close(); await handle.close(); }
});

test("platform master switch: play OFF refuses open_position (SYSTEM_DISABLED); balance untouched", async () => {
  const { handle, url } = await boot({ playAllowed: () => false });
  const a = new Client(url(SITE_A));
  try {
    await a.open();
    await a.waitFor("hello");
    a.send("auth", { userId: "userPlayOff" });
    const bal = await a.waitFor("balance");
    assert.equal(bal.data.real, 1_000_000);
    a.send("open_position", { stakeCents: 25000, direction: "buy", durationS: 1 });
    const err = await a.waitFor("error");
    assert.equal(err.data.code, "SYSTEM_DISABLED", "open refused when play is globally off");
    // Same substitution: a window measured in the brand's own ticks, which a slow runner widens.
    await a.collect(["tick"], (seen) => seen.length >= 3, "3 ticks after the refusal", ticksBudget(3, TICK_MS));
    assert.equal(a.of("position_opened").length, 0, "no position opened");
    // balance must be unchanged (no debit on a refused open)
    assert.equal(a.of("balance").at(-1).data.real, 1_000_000, "stake NOT debited on refusal");
  } finally { a.close(); await handle.close(); }
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
  // A promise, not a variable read at a fixed moment: on a loaded runner, building brand A's runtime
  // can hold the event loop past the known client's hello + 300ms, so the close may not have been
  // handled yet when the assertion runs (it read the initial -1 in CI).
  const unknownClosed = new Promise<number>((resolve) => unknown.ws.on("close", (code: number) => resolve(code)));
  unknown.ws.on("error", () => { /* expected: connection rejected */ });
  try {
    await known.open();
    const hello = await known.waitFor("hello");
    assert.equal(hello.data.site, SITE_A, "async-resolved brand connects and streams");
    // Await the two ticks the assertion wants rather than sleeping for about long enough: this is
    // the line PR #147 left as a fixed-moment sample, and it is what regressed under load.
    await known.waitUntil(() => known.of("tick").length >= 2, "2 ticks on the live-resolved brand", ticksBudget(2, TICK_MS));
    assert.ok(known.of("tick").length >= 2, "live-resolved brand receives ticks");
    assert.ok(lookups >= 1, "the async resolver was awaited");

    // an unresolved brand is cleanly rejected (async throw → close 1008), not left hanging
    assert.equal(unknown.of("hello").length, 0, "unknown brand never gets a hello");
    const unknownCloseCode = await Promise.race([unknownClosed, sleep(REPLY_MS).then(() => -1)]);
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

test("bonus visibility: auth + open_position balance frames carry the bonus bucket (0094)", async () => {
  const { handle, repo, url } = await boot();
  const c = new Client(url(SITE_A));
  try {
    await c.open(); await c.waitFor("hello");
    c.send("auth", { userId: "bonusUser" });
    const bal = await c.waitFor("balance");
    // The auth frame must be a full snapshot: real AND bonus present (bonus 0 for a fresh user).
    assert.equal(typeof bal.data.real, "number");
    assert.equal(typeof bal.data.bonus, "number", "auth balance frame carries bonus");
    assert.equal(bal.data.bonus, 0);

    // Open a trade: the post-open frame must also carry bonus (bonus-first staking moves both buckets).
    const balFramesBeforeOpen = c.of("balance").length;
    c.send("open_position", { stakeCents: 25000, direction: "buy", durationS: 1 });
    await c.waitFor("position_opened");
    // The post-open balance frame is a separate, later send than position_opened: await it, or the
    // "frame" sampled below is the auth snapshot and the debit assertion tests nothing.
    await c.waitWhere("balance", () => c.of("balance").length > balFramesBeforeOpen);
    const frames = c.of("balance");
    const postOpen = frames[frames.length - 1];
    assert.equal(typeof postOpen.data.bonus, "number", "open_position balance frame carries bonus");
    assert.ok(postOpen.data.real < bal.data.real, "stake debited");
  } finally { c.close(); await handle.close(); }
});

// ── docs/42 UI-5: the console live feed is scoped — owner sees every brand, a platform admin only its own ──
test("UI-5: platform live feed — owner: all brands; platform admin: its platform only; others refused", async () => {
  const P1 = "10000000-0000-0000-0000-00000000000a";
  const { handle, platformUrl, url } = await boot({ sitesOfPlatform: async (p) => (p === P1 ? [SITE_A] : []) });
  const clients: Client[] = [];
  const mk = async (u: string) => { const c = new Client(u); clients.push(c); await c.open(); return c; };
  try {
    // One player online on each brand.
    const pa = await mk(url(SITE_A)); await pa.waitFor("hello");
    const pb = await mk(url(SITE_B)); await pb.waitFor("hello");
    // No sleep needed for the snapshot to count these two: the server adds a socket to its per-site
    // set BEFORE it sends that socket's `hello`, so an awaited hello already proves registration.

    const owner = await mk(platformUrl); owner.send("auth", { role: "platform_superadmin" }); await owner.waitFor("platform_authed");
    owner.send("subscribe_platform", {});
    const os = await owner.waitFor("platform_snapshot");
    assert.deepEqual(os.data.sites.map((x: any) => x.siteId).sort(), [SITE_A, SITE_B].sort(), "owner sees every brand");

    const plat = await mk(platformUrl); plat.send("auth", { role: "platform_admin", platform: P1 }); await plat.waitFor("platform_authed");
    plat.send("subscribe_platform", {});
    const ps = await plat.waitFor("platform_snapshot");
    assert.deepEqual(ps.data.sites.map((x: any) => x.siteId), [SITE_A], "platform admin sees ONLY its platform's brand");
    assert.equal(ps.data.totalOnline, 1);

    handle.emitPlatformDeposit({ siteId: SITE_B, userId: "pB", username: "b", amountCents: 100, txId: "t-b", atMs: 1 });
    handle.emitPlatformDeposit({ siteId: SITE_A, userId: "pA", username: "a", amountCents: 200, txId: "t-a", atMs: 2 });
    // Await both fan-outs instead of sleeping: the owner must end up with two frames and the
    // platform admin with one. Frames on one socket arrive in the order they were sent, and t-b was
    // sent FIRST, so a platform admin that holds exactly one frame can never have been sent t-b —
    // which makes this window stricter than the 150ms it replaces, not laxer.
    await owner.waitUntil(() => owner.of("platform_deposit").length >= 2, "both deposits at the owner");
    await plat.waitUntil(() => plat.of("platform_deposit").length >= 1, "its own platform's deposit at the admin");
    assert.deepEqual(plat.of("platform_deposit").map((m) => m.data.txId), ["t-a"], "other platform's deposit never reaches a platform admin");
    assert.deepEqual(owner.of("platform_deposit").map((m) => m.data.txId), ["t-b", "t-a"], "owner receives every deposit");

    for (const bad of [{ role: "platform_admin" }, { role: "admin" }, { role: "player" }]) {
      const c = await mk(platformUrl); c.send("auth", bad);
      const e = await c.waitFor("error");
      assert.equal(e.data.code, "NOT_AUTHORIZED", JSON.stringify(bad));
    }
  } finally {
    clients.forEach((c) => c.close());
    await handle.close();
  }
});
