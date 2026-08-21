import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

interface ReqOpts { token?: string; body?: unknown; }
function req(api: TestApi, method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}

const ADMIN = "u-admin:admin";
const PLAYER = "u-player:player";
const mtok = (id: string) => `${id}:marketer`;

async function onboard(api: TestApi, name: string, phone: string, pin = "1234"): Promise<string> {
  const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN, body: { name, phone } }))).id as string;
  assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { token: ADMIN, body: { pin } })).status, 200);
  return id;
}

test("marketer transactions feed renders a game withdrawal as an M-PESA 'received' confirmation", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Peter Muchendu", "0722000001");

    // A game withdrawal on invest254 credits the marketer wallet with source=game_withdrawal.
    const credited = await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, {
      token: ADMIN,
      body: { amountCents: 70000, ref: "game:tx-1", meta: { source: "game_withdrawal", tx: "tx-1" } },
    });
    assert.equal(credited.status, 200);

    const feed = await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(id) }));
    assert.equal(Array.isArray(feed.items), true);
    assert.equal(feed.items.length, 1);

    const tx = feed.items[0];
    assert.equal(tx.direction, "in");
    assert.equal(tx.entryType, "credit");
    assert.equal(tx.amountCents, 70000);
    assert.equal(tx.balanceAfterCents, 70000);
    assert.equal(tx.source, "game_withdrawal");
    assert.equal(tx.ref, "game:tx-1");
    assert.equal(tx.mpesa.party, "INVEST254");
    assert.equal(tx.mpesa.amountText, "Ksh700.00");
    assert.equal(tx.mpesa.code.length, 10);
    assert.match(tx.mpesa.message, /^.{10} Confirmed\.You have received Ksh700\.00 from INVEST254 on /);
    assert.match(tx.mpesa.message, /New M-PESA balance is Ksh700\.00\. Download My OneApp on https:\/\/saf\.cx\/lPKcC$/);
  } finally { await api.close(); }
});

test("game-withdrawal confirmation reads the marketer's OWN brand, not the flagship (0096)", async () => {
  const api = await startTestApi();
  try {
    // Register two brands' display names, exactly as the 0096 view resolves them from sites.name.
    const MADOLAR = "site-madolar";
    const THOUSAND = "site-1000wins";
    (api.deps.marketers as any)._setBrandName(MADOLAR, "Madolar");
    (api.deps.marketers as any)._setBrandName(THOUSAND, "1000Wins");

    // Onboard a marketer under EACH brand (admin token carries the site claim -> adminScopeSite).
    const mk = async (site: string, name: string, phone: string): Promise<string> => {
      const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: `u-admin:admin:${site}`, body: { name, phone } }))).id as string;
      assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/pin`, { token: ADMIN, body: { pin: "1234" } })).status, 200);
      return id;
    };
    const madolarId = await mk(MADOLAR, "Alice Wanjiru", "0733000001");
    const thousandId = await mk(THOUSAND, "Bob Otieno", "0733000002");

    // Credit each with a game withdrawal.
    for (const [id, ref] of [[madolarId, "game:md-1"], [thousandId, "game:tw-1"]] as const) {
      assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, {
        token: ADMIN, body: { amountCents: 120000, ref, meta: { source: "game_withdrawal" } },
      })).status, 200);
    }

    const madolarTx = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(madolarId) }))).items[0];
    const thousandTx = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(thousandId) }))).items[0];

    // Each marketer sees their OWN brand as the M-PESA sender — never the flagship.
    assert.equal(madolarTx.mpesa.party, "MADOLAR");
    assert.match(madolarTx.mpesa.message, /Confirmed\.You have received Ksh1,200\.00 from MADOLAR on /);
    assert.doesNotMatch(madolarTx.mpesa.message, /INVEST254/);

    assert.equal(thousandTx.mpesa.party, "1000WINS");
    assert.match(thousandTx.mpesa.message, /from 1000WINS on /);
    assert.doesNotMatch(thousandTx.mpesa.message, /INVEST254/);
  } finally { await api.close(); }
});

test("brandless / default-site marketer still falls back to INVEST254 (behaviour-preserving)", async () => {
  const api = await startTestApi();
  try {
    // No _setBrandName for this marketer's (default) site beyond the built-in Invest254 default.
    const id = await onboard(api, "Carol Njeri", "0733000003");
    assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, {
      token: ADMIN, body: { amountCents: 50000, ref: "game:def-1", meta: { source: "game_withdrawal" } },
    })).status, 200);
    const tx = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(id) }))).items[0];
    assert.equal(tx.mpesa.party, "INVEST254");
    assert.match(tx.mpesa.message, /from INVEST254 on /);
  } finally { await api.close(); }
});

test("transactions feed is newest-first and gated to marketers", async () => {
  const api = await startTestApi();
  try {
    const id = await onboard(api, "Jane Doe", "0722000002");
    await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN, body: { amountCents: 30000, ref: "game:a", meta: { source: "game_withdrawal" } } });
    await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN, body: { amountCents: 50000, ref: "game:b", meta: { source: "game_withdrawal" } } });

    const feed = await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(id) }));
    assert.equal(feed.items.length, 2);
    assert.equal(feed.items[0].ref, "game:b"); // newest first
    assert.equal(feed.items[1].ref, "game:a");
    assert.ok(feed.items[0].id > feed.items[1].id);

    // gating: no token -> 401, player token -> 403
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/transactions")).status, 401);
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/transactions", { token: PLAYER })).status, 403);
  } finally { await api.close(); }
});
