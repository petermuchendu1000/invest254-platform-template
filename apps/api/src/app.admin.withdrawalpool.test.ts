import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi, SITE_A, SITE_B } from "./testutil.js";

/**
 * Phase 1 (docs/25): daily withdrawal-pool budget admin surface. INERT — no settlement change.
 * Locks the contract: superadmin-only set, per-brand + per-EAT-day isolation, validation, audit.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Response> {
  const h: Record<string, string> = {};
  if (o.token) h["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers: h };
  if (o.body !== undefined) { h["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const OWNER = "owner:platform_superadmin";
const DAY = "2026-08-16";

test("withdrawal-pool: defaults to zero, superadmin sets it, GET reflects it", async () => {
  const api = await startTestApi();
  try {
    const empty = await json(await req(api, "GET", `/api/v1/admin/withdrawal-pool?site=${SITE_A}&day=${DAY}`, { token: OWNER }));
    assert.equal(empty.amountCents, 0, "no pool set yet -> zero");
    assert.equal(empty.availableCents, 0);

    const set = await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_A}`,
      { token: OWNER, body: { amountCents: 500000, day: DAY } });
    assert.equal(set.status, 200);
    const s = await json(set);
    assert.equal(s.amountCents, 500000);
    assert.equal(s.availableCents, 500000, "available = amount - paid - reserved");

    const reread = await json(await req(api, "GET", `/api/v1/admin/withdrawal-pool?site=${SITE_A}&day=${DAY}`, { token: OWNER }));
    assert.equal(reread.amountCents, 500000);
  } finally { await api.close(); }
});

test("withdrawal-pool is isolated per brand and per day", async () => {
  const api = await startTestApi();
  try {
    await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_A}`, { token: OWNER, body: { amountCents: 300000, day: DAY } });
    await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_B}`, { token: OWNER, body: { amountCents: 900000, day: DAY } });
    const a = await json(await req(api, "GET", `/api/v1/admin/withdrawal-pool?site=${SITE_A}&day=${DAY}`, { token: OWNER }));
    const b = await json(await req(api, "GET", `/api/v1/admin/withdrawal-pool?site=${SITE_B}&day=${DAY}`, { token: OWNER }));
    const otherDay = await json(await req(api, "GET", `/api/v1/admin/withdrawal-pool?site=${SITE_A}&day=2026-08-17`, { token: OWNER }));
    assert.equal(a.amountCents, 300000);
    assert.equal(b.amountCents, 900000, "brand B independent of brand A");
    assert.equal(otherDay.amountCents, 0, "a different EAT day is a separate budget");
  } finally { await api.close(); }
});

test("withdrawal-pool: only superadmin+ may set; a plain admin is forbidden", async () => {
  const api = await startTestApi();
  try {
    const res = await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_A}`, { token: "a:admin", body: { amountCents: 100000, day: DAY } });
    assert.equal(res.status, 403);
  } finally { await api.close(); }
});

test("withdrawal-pool: rejects negative / non-integer amounts", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_A}`, { token: OWNER, body: { amountCents: -1, day: DAY } })).status, 400);
    assert.equal((await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_A}`, { token: OWNER, body: { amountCents: 12.5, day: DAY } })).status, 400);
    assert.equal((await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_A}`, { token: OWNER, body: { amountCents: 1000, day: "not-a-date" } })).status, 400);
  } finally { await api.close(); }
});

test("withdrawal-pool: a site-scoped superadmin is pinned to their brand", async () => {
  const api = await startTestApi();
  try {
    const scopedB = `boss:superadmin:${SITE_B}`;
    await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_A}`, { token: scopedB, body: { amountCents: 777000, day: DAY } });
    const a = await json(await req(api, "GET", `/api/v1/admin/withdrawal-pool?site=${SITE_A}&day=${DAY}`, { token: OWNER }));
    assert.notEqual(a.amountCents, 777000, "scoped-B superadmin could not set brand A");
    const b = await json(await req(api, "GET", `/api/v1/admin/withdrawal-pool?day=${DAY}`, { token: scopedB }));
    assert.equal(b.amountCents, 777000, "it landed on their own brand B");
  } finally { await api.close(); }
});

test("withdrawal-pool set is audited", async () => {
  const api = await startTestApi();
  try {
    await req(api, "PUT", `/api/v1/admin/withdrawal-pool?site=${SITE_A}`, { token: OWNER, body: { amountCents: 250000, day: DAY } });
    const audit = await json(await req(api, "GET", "/api/v1/admin/audit", { token: OWNER }));
    assert.ok(audit.items.some((a: any) => a.action === "pool.set"), "pool.set audit row written");
  } finally { await api.close(); }
});
