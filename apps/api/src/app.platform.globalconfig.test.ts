import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, type TestApi } from "./testutil.js";

const json = (r: Response): Promise<any> => r.json() as Promise<any>;
interface Opts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, o: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const PLATFORM = `${TEST_ADMIN}:platform_superadmin`;
const ADMIN = `${TEST_ADMIN}:admin`;

test("global-config: read defaults, patch switches (versioned), reflect on re-read", async () => {
  const api = await startTestApi();
  try {
    const c0 = (await json(await req(api, "GET", "/api/v1/platform/global-config", { token: PLATFORM }))).config;
    assert.equal(c0.depositsEnabled, true); assert.equal(c0.withdrawalsEnabled, true);
    const v0 = c0.version;
    const patched = (await json(await req(api, "PATCH", "/api/v1/platform/global-config", {
      token: PLATFORM, body: { withdrawals_enabled: false, play_enabled: false, maintenance_message: "Upgrade 2-3am EAT" } }))).config;
    assert.equal(patched.withdrawalsEnabled, false);
    assert.equal(patched.playEnabled, false);
    assert.equal(patched.maintenanceMessage, "Upgrade 2-3am EAT");
    assert.equal(patched.version, v0 + 1);
    const c1 = (await json(await req(api, "GET", "/api/v1/platform/global-config", { token: PLATFORM }))).config;
    assert.equal(c1.withdrawalsEnabled, false);
    assert.equal(c1.depositsEnabled, true, "untouched switch stays on");
  } finally { await api.close(); }
});

test("global-config: authorization — admin blocked (403), unauth (401)", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/platform/global-config", { token: ADMIN })).status, 403);
    assert.equal((await req(api, "PATCH", "/api/v1/platform/global-config", { token: ADMIN, body: { deposits_enabled: false } })).status, 403);
    assert.equal((await req(api, "POST", "/api/v1/platform/pool/distribute", { token: ADMIN, body: { totalCents: 100, mode: "equal" } })).status, 403);
    assert.equal((await req(api, "GET", "/api/v1/platform/global-config")).status, 401);
  } finally { await api.close(); }
});

test("global-config: validation — empty patch + bad boolean + bad amount → 400", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "PATCH", "/api/v1/platform/global-config", { token: PLATFORM, body: {} })).status, 400);
    assert.equal((await req(api, "PATCH", "/api/v1/platform/global-config", { token: PLATFORM, body: { deposits_enabled: "yes" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/platform/pool/distribute", { token: PLATFORM, body: { mode: "equal", totalCents: -5 } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/platform/pool/distribute", { token: PLATFORM, body: { mode: "per_site", overrides: {} } })).status, 400);
  } finally { await api.close(); }
});

test("pool distribute: equal split across active sites + recorded in history", async () => {
  const api = await startTestApi();
  try {
    // add a second brand so the split is non-trivial
    await req(api, "POST", "/api/v1/platform/sites", { token: PLATFORM, body: { slug: "brandb", name: "Brand B" } });
    const res = (await json(await req(api, "POST", "/api/v1/platform/pool/distribute", { token: PLATFORM, body: { totalCents: 900_000, mode: "equal" } }))).result;
    assert.equal(res.totalCents, 900_000);
    const amounts = Object.values(res.perSite) as number[];
    assert.equal(amounts.reduce((a, b) => a + b, 0), 900_000, "distributed amounts sum to the total");
    assert.ok(amounts.length >= 2, "split across >=2 active brands");
    const hist = (await json(await req(api, "GET", "/api/v1/platform/pool/distributions", { token: PLATFORM }))).distributions;
    assert.ok(hist.length >= 1 && hist[0].totalCents === 900_000, "distribution recorded in history");
  } finally { await api.close(); }
});

test("pool distribute: per_site exact amounts", async () => {
  const api = await startTestApi();
  try {
    const sites = (await json(await req(api, "GET", "/api/v1/platform/sites", { token: PLATFORM }))).sites;
    const id = sites[0].siteId;
    const res = (await json(await req(api, "POST", "/api/v1/platform/pool/distribute", {
      token: PLATFORM, body: { mode: "per_site", overrides: { [id]: 250_000 } } }))).result;
    assert.equal(res.perSite[id], 250_000);
  } finally { await api.close(); }
});

// ── Global ECONOMY overrides (migration 0099): separate player/marketer + payments, per-field enforce ──

test("global-config: economy blocks — set player/marketer/payments, merge, reflect on re-read", async () => {
  const api = await startTestApi();
  try {
    const patched = (await json(await req(api, "PATCH", "/api/v1/platform/global-config", {
      token: PLATFORM,
      body: {
        player_economy: { houseEdge: { v: 0.7, on: true }, targetWinRate: { v: 0.2, on: true }, maxMultiplier: { v: 5, on: true } },
        marketer_economy: { targetWinRate: { v: 0.85, on: true }, houseEdge: { v: 0.05, on: true }, maxMultiplier: { v: 10, on: true } },
        payments: { minDepositCents: { v: 30000, on: true } },
      },
    }))).config;
    assert.deepEqual(patched.playerEconomy.houseEdge, { v: 0.7, on: true });
    assert.deepEqual(patched.marketerEconomy.targetWinRate, { v: 0.85, on: true });
    assert.deepEqual(patched.payments.minDepositCents, { v: 30000, on: true });

    // partial merge: toggle one player field off; the others must survive.
    const merged = (await json(await req(api, "PATCH", "/api/v1/platform/global-config", {
      token: PLATFORM, body: { player_economy: { houseEdge: { v: 0.7, on: false } } } }))).config;
    assert.equal(merged.playerEconomy.houseEdge.on, false, "field toggled off");
    assert.deepEqual(merged.playerEconomy.targetWinRate, { v: 0.2, on: true }, "sibling field retained via merge");

    const reread = (await json(await req(api, "GET", "/api/v1/platform/global-config", { token: PLATFORM }))).config;
    assert.deepEqual(reread.marketerEconomy.houseEdge, { v: 0.05, on: true });
  } finally { await api.close(); }
});

test("global-config: economy validation — bad shape / unknown key / wrong cohort field => 400", async () => {
  const api = await startTestApi();
  try {
    const bad = (b: unknown) => req(api, "PATCH", "/api/v1/platform/global-config", { token: PLATFORM, body: b });
    assert.equal((await bad({ player_economy: { houseEdge: { v: "x", on: true } } })).status, 400, "non-numeric v");
    assert.equal((await bad({ player_economy: { houseEdge: { v: 0.7, on: "yes" } } })).status, 400, "non-boolean on");
    assert.equal((await bad({ player_economy: { bogus: { v: 1, on: true } } })).status, 400, "unknown cohort field");
    assert.equal((await bad({ payments: { maxMultiplier: { v: 5, on: true } } })).status, 400, "cohort field not allowed in payments");
    assert.equal((await bad({ player_economy: [1, 2] })).status, 400, "block must be an object");
  } finally { await api.close(); }
});
