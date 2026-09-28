import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const PLAYER = TEST_USER;

test("payhero: appears in /deposits/providers when enabled (rail-ready)", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "mpesa", displayName: "M-Pesa" }, { code: "payhero", displayName: "PayHero" }]);
    const codes = (await json(await req(api, "GET", "/api/v1/deposits/providers", { token: PLAYER }))).providers.map((p: any) => p.code).sort();
    assert.deepEqual(codes, ["mpesa", "payhero"]);
  } finally { await api.close(); }
});

test("payhero deposit: POST /deposits/payhero -> 202, callback sweep credits the wallet exactly once", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    api.payRepo.setProviders([{ code: "payhero", displayName: "PayHero" }]);
    const dep = await req(api, "POST", "/api/v1/deposits/payhero", { token: PLAYER, body: { amount: 50_000, phone: "0798123061" } });
    assert.equal(dep.status, 202);
    const { transactionId, reference } = await json(dep);
    assert.ok(transactionId && reference);

    // PayHero webhook (public). Handler runs the authoritative sweep (stub status -> SUCCESS) before crediting.
    const cb = await req(api, "POST", "/api/v1/deposits/payhero/callback", { body: { response: { ExternalReference: transactionId, Status: "Success" }, status: true } });
    assert.equal(cb.status, 200);

    const bal = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(bal.real, 150_000); // 100k + 50k credited exactly once
  } finally { await api.close(); }
});

test("payhero deposit: honours the deposit floor + rejects junk", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "payhero", displayName: "PayHero" }]);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payhero", { token: PLAYER, body: { amount: 9_999, phone: "0798123061" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payhero", { token: PLAYER, body: { amount: 50_000, phone: "nope" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payhero", { token: PLAYER, body: {} })).status, 400);
  } finally { await api.close(); }
});

test("payhero deposit: refused when the gateway is switched off for the brand", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "mpesa", displayName: "M-Pesa" }]); // PayHero off
    const res = await req(api, "POST", "/api/v1/deposits/payhero", { token: PLAYER, body: { amount: 50_000, phone: "0798123061" } });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, "PROVIDER_DISABLED");
  } finally { await api.close(); }
});

// ── PayHero Lipwa (hosted multi-channel) route ───────────────────────────────────────────────────

test("payhero lipwa: POST /deposits/payhero/lipwa -> 202 with a checkout URL referencing the txId", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "payhero", displayName: "PayHero" }]);
    const res = await req(api, "POST", "/api/v1/deposits/payhero/lipwa", { token: PLAYER, body: { amount: 50_000 } });
    assert.equal(res.status, 202);
    const b = await json(res);
    assert.ok(b.transactionId && b.lipwaUrl);
    assert.equal(b.reference, b.transactionId);           // reference === txId (unambiguous ledger match)
    assert.match(b.lipwaUrl, new RegExp(`reference=${b.transactionId}`));
  } finally { await api.close(); }
});

test("payhero lipwa: refused when PayHero is switched off, and honours the deposit floor", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "mpesa", displayName: "M-Pesa" }]); // PayHero off
    assert.equal((await req(api, "POST", "/api/v1/deposits/payhero/lipwa", { token: PLAYER, body: { amount: 50_000 } })).status, 403);
    api.payRepo.setProviders([{ code: "payhero", displayName: "PayHero" }]);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payhero/lipwa", { token: PLAYER, body: { amount: 9_999 } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payhero/lipwa", { token: PLAYER, body: {} })).status, 400);
  } finally { await api.close(); }
});

// ── PayHero manual Pay Bill claim route ──────────────────────────────────────────────────────────

test("payhero paybill claim: gated on PayHero + validates the code + unknown code is not_found (no credit)", async () => {
  const api = await startTestApi({ startingBalanceCents: 0 });
  try {
    api.payRepo.setProviders([{ code: "mpesa", displayName: "M-Pesa" }]); // PayHero off
    assert.equal((await req(api, "POST", "/api/v1/deposits/payhero/paybill/claim", { token: PLAYER, body: { code: "X" } })).status, 403);
    api.payRepo.setProviders([{ code: "payhero", displayName: "PayHero" }]);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payhero/paybill/claim", { token: PLAYER, body: {} })).status, 400);
    const unknown = await req(api, "POST", "/api/v1/deposits/payhero/paybill/claim", { token: PLAYER, body: { code: "NOPE123" } });
    assert.equal(unknown.status, 200);
    assert.equal((await json(unknown)).status, "not_found");
  } finally { await api.close(); }
});
