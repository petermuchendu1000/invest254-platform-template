import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, type TestApi } from "./testutil.js";

/**
 * Cross-brand marketer rollup (docs/22 Task R): a person can market on several brands (one
 * per-site `affiliates` row each). An optional `marketerGlobalId` links those rows so the platform
 * report answers "which marketer brought which client on which site, and their total" in one view.
 * Reporting only — money stays per site. All /platform routes are platform_superadmin-gated.
 */

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
const SUPERADMIN = `${TEST_ADMIN}:superadmin`;

test("every marketer-rollup route is platform_superadmin-gated", async () => {
  const api = await startTestApi();
  try {
    for (const [m, p, b] of [
      ["GET", "/api/v1/platform/marketers/rollup", undefined],
      ["POST", "/api/v1/platform/marketers", { label: "x" }],
      ["PATCH", "/api/v1/platform/affiliates/u1/marketer", { marketerGlobalId: null }],
    ] as const) {
      assert.equal((await req(api, m, p, { token: ADMIN, body: b })).status, 403, `${p} rejects admin`);
      assert.equal((await req(api, m, p, { token: SUPERADMIN, body: b })).status, 403, `${p} rejects superadmin`);
      assert.equal((await req(api, m, p, { body: b })).status, 401, `${p} needs auth`);
    }
  } finally { await api.close(); }
});

test("link two per-site affiliate rows to one global marketer -> grouped rollup with totals", async () => {
  const api = await startTestApi();
  try {
    // Brand B (SITE_A/default is seeded by the repo). Capture its generated id.
    const { siteId: siteB } = await json(await req(api, "POST", "/api/v1/platform/sites", { token: PLATFORM, body: { slug: "brandb", name: "Brand B" } }));

    // The same real person markets on both brands (two affiliate rows, one per brand).
    api.platformRepo.seedMarketer({ affiliateUserId: "jane-A", siteId: SITE_A, clients: 3, ggrCents: 30_000, commissionCents: 6_000 });
    api.platformRepo.seedMarketer({ affiliateUserId: "jane-B", siteId: siteB, clients: 5, ggrCents: 50_000, commissionCents: 10_000 });
    // A different, single-brand marketer who is never linked.
    api.platformRepo.seedMarketer({ affiliateUserId: "solo-A", siteId: SITE_A, clients: 2, ggrCents: 8_000, commissionCents: 1_600 });

    // Create the global identity and link both of Jane's rows to it.
    const { marketerGlobalId } = await json(await req(api, "POST", "/api/v1/platform/marketers", { token: PLATFORM, body: { label: "Jane Doe" } }));
    assert.ok(marketerGlobalId);
    assert.equal((await req(api, "PATCH", "/api/v1/platform/affiliates/jane-A/marketer", { token: PLATFORM, body: { marketerGlobalId } })).status, 200);
    assert.equal((await req(api, "PATCH", "/api/v1/platform/affiliates/jane-B/marketer", { token: PLATFORM, body: { marketerGlobalId } })).status, 200);

    const rollup = await json(await req(api, "GET", "/api/v1/platform/marketers/rollup", { token: PLATFORM }));
    const jane = rollup.marketers.find((m: any) => m.marketerGlobalId === marketerGlobalId);
    assert.ok(jane, "Jane grouped under her global id");
    assert.equal(jane.label, "Jane Doe");
    assert.equal(jane.sites.length, 2, "both brands under one marketer");
    // Totals across sites: clients 3+5, GGR 30k+50k, commission 6k+10k.
    assert.deepEqual(jane.totals, { clients: 8, ggrCents: 80_000, commissionCents: 16_000 });
    // Which client on which site is preserved in the per-site breakdown.
    const bySite = Object.fromEntries(jane.sites.map((s: any) => [s.affiliateUserId, s]));
    assert.equal(bySite["jane-A"].clients, 3);
    assert.equal(bySite["jane-B"].clients, 5);

    // The unlinked marketer stands alone (its own group, null global id).
    const solo = rollup.marketers.find((m: any) => m.marketerGlobalId === null);
    assert.ok(solo, "unlinked marketer is its own group");
    assert.equal(solo.totals.clients, 2);
  } finally { await api.close(); }
});

test("link validation: unknown global -> 404; unknown affiliate -> 404; empty label -> 400; unlink works", async () => {
  const api = await startTestApi();
  try {
    api.platformRepo.seedMarketer({ affiliateUserId: "aff-1", siteId: SITE_A, clients: 1, ggrCents: 1_000, commissionCents: 200 });

    // Empty label rejected.
    assert.equal((await req(api, "POST", "/api/v1/platform/marketers", { token: PLATFORM, body: { label: "  " } })).status, 400);

    // Link to a non-existent global identity.
    const badGlobal = await req(api, "PATCH", "/api/v1/platform/affiliates/aff-1/marketer", { token: PLATFORM, body: { marketerGlobalId: "00000000-0000-0000-0000-0000000000ff" } });
    assert.equal(badGlobal.status, 404);
    assert.equal((await json(badGlobal)).error.code, "MARKETER_GLOBAL_NOT_FOUND");

    // Link a non-existent affiliate to a real global.
    const { marketerGlobalId } = await json(await req(api, "POST", "/api/v1/platform/marketers", { token: PLATFORM, body: { label: "Someone" } }));
    const badAff = await req(api, "PATCH", "/api/v1/platform/affiliates/nope/marketer", { token: PLATFORM, body: { marketerGlobalId } });
    assert.equal(badAff.status, 404);
    assert.equal((await json(badAff)).error.code, "NOT_AFFILIATE");

    // Link then unlink (null) the real affiliate.
    assert.equal((await req(api, "PATCH", "/api/v1/platform/affiliates/aff-1/marketer", { token: PLATFORM, body: { marketerGlobalId } })).status, 200);
    const unlink = await req(api, "PATCH", "/api/v1/platform/affiliates/aff-1/marketer", { token: PLATFORM, body: { marketerGlobalId: null } });
    assert.equal(unlink.status, 200);
    assert.equal((await json(unlink)).marketerGlobalId, null);

    const rollup = await json(await req(api, "GET", "/api/v1/platform/marketers/rollup", { token: PLATFORM }));
    assert.equal(rollup.marketers.length, 1, "one unlinked group after unlink");
    assert.equal(rollup.marketers[0].marketerGlobalId, null);
  } finally { await api.close(); }
});
