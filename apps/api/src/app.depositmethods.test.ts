import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, type TestApi } from "./testutil.js";

/**
 * GET /deposits/providers — the contract the deposit sheet renders from.
 *
 * `methods` are the CHANNELS a player can actually complete. The client must never infer tabs from
 * provider codes: doing so offered PayHero's Lipwa checkout on brands with no `lipwa_url`, where
 * submitting threw PAYHERO_LIPWA_NOT_CONFIGURED.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const PLAYER = TEST_USER;

function req(api: TestApi, method: string, path: string, opts: { token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  return fetch(`${api.baseUrl}${path}`, { method, headers });
}

test("GET /deposits/providers returns server-declared channels alongside the gateway list", async () => {
  const api = await startTestApi();
  try {
    const body = await json(await req(api, "GET", "/api/v1/deposits/providers", { token: PLAYER }));
    // The default test brand has M-Pesa + Mega Pay enabled.
    assert.deepEqual(body.providers.map((p: any) => p.code).sort(), ["megapay", "mpesa"]);
    assert.ok(Array.isArray(body.methods), "methods must be present for the sheet to render");
    const ids = body.methods.map((m: any) => m.id);
    assert.deepEqual(ids, ["mpesa-stk", "megapay-stk", "mpesa-paybill"]);
    // Two STK rails are numbered; the gateway brand is never exposed to the player.
    assert.deepEqual(body.methods.map((m: any) => m.label), ["M-Pesa (1)", "M-Pesa (2)", "Pay Bill"]);
    for (const m of body.methods) assert.doesNotMatch(m.label, /mega\s*pay|payhero|lipwa|daraja/i);
    // No Lipwa channel: the test brand has no PayHero rail at all.
    assert.equal(body.methods.some((m: any) => m.channel === "lipwa"), false);
  } finally { await api.close(); }
});

test("every declared method has the shape the client keys off", async () => {
  const api = await startTestApi();
  try {
    const body = await json(await req(api, "GET", "/api/v1/deposits/providers", { token: PLAYER }));
    for (const m of body.methods) {
      assert.equal(typeof m.id, "string");
      assert.equal(typeof m.label, "string");
      assert.ok(["stk", "lipwa", "paybill"].includes(m.channel), `bad channel ${m.channel}`);
      assert.ok(["mpesa", "megapay", "payhero"].includes(m.provider), `bad provider ${m.provider}`);
    }
  } finally { await api.close(); }
});

test("platform deposits kill-switch OFF ⇒ no methods offered (the sheet must not promise what POSTs refuse)", async () => {
  // Every deposit POST refuses with SYSTEM_DISABLED while this is off; offering tabs would be a lie.
  const gate = {
    allows: async (k: string) => k !== "deposits",
    flags: async () => ({ deposits: false }),
  };
  const api = await startTestApi({ depsOverrides: { platformGate: gate as never } });
  try {
    const res = await req(api, "GET", "/api/v1/deposits/providers", { token: PLAYER });
    assert.equal(res.status, 200, "still 200 so the sheet shows 'unavailable', not an error");
    const body = await json(res);
    assert.deepEqual(body.methods, []);
    // A real deposit is genuinely refused in this state — this is what the empty list is protecting.
    const post = await fetch(`${api.baseUrl}/api/v1/deposits`, {
      method: "POST",
      headers: { authorization: `Bearer ${PLAYER}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: 50_000, phone: "0798123061" }),
    });
    assert.equal(post.status, 403);
    assert.equal((await json(post)).error.code, "SYSTEM_DISABLED");
  } finally { await api.close(); }
});

test("deposit discovery requires authentication", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/deposits/providers")).status, 401);
  } finally { await api.close(); }
});
