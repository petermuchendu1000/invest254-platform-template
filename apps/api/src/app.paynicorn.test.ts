import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeContent, paynicornSign, STUB_PAYNICORN_SECRET } from "@invest254/engine";
import { startTestApi, TEST_USER, type TestApi } from "./testutil.js";

const json = (res: Response): Promise<any> => res.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; type?: string; origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.origin) headers["origin"] = opts.origin;
  const init: RequestInit = { method, headers };
  if (opts.raw !== undefined) { headers["content-type"] = opts.type ?? "application/json"; init.body = opts.raw; }
  else if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const PLAYER = TEST_USER;
function signed(fields: Record<string, string>, secret = STUB_PAYNICORN_SECRET) {
  const content = encodeContent({ txnId: "PN77", amount: "500", currency: "KES", countryCode: "KE", status: "1", code: "0000", message: "ok", ...fields });
  return { content, sign: paynicornSign(content, secret) };
}

test("payx: players see only a plain M-Pesa tab under the public code — the supplier's name never leaves the API", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "paynicorn", displayName: "PayX" }]);
    const res = await req(api, "GET", "/api/v1/deposits/providers", { token: PLAYER });
    const text = await res.text();
    assert.ok(!/paynicorn/i.test(text), `supplier name leaked: ${text}`);
    const body = JSON.parse(text);
    assert.deepEqual(body.methods.map((m: any) => [m.id, m.provider, m.channel, m.label]), [["payx-mpesa", "payx", "stk", "M-Pesa"]]);
    assert.deepEqual(body.providers.map((p: any) => [p.code, p.displayName]), [["payx", "M-Pesa"]]);
    // The gateway publishes its method icons on its OWN cdn: that URL must never reach the browser.
    assert.ok(!/cdn\.paynicorn|paynicorn\.com/i.test(text), `supplier host leaked: ${text}`);
    assert.equal(body.methods[0].iconUrl, undefined, "no supplier-hosted icon is passed through");
    assert.equal(body.methods[0].methodCode, "MPESA", "the method code is generic and does travel");
  } finally { await api.close(); }
});

test("payx deposit: 202 with no page to open; signed postback credits once; history never names the supplier", async () => {
  const api = await startTestApi({ startingBalanceCents: 100_000 });
  try {
    api.payRepo.setProviders([{ code: "paynicorn", displayName: "PayX" }]);
    const dep = await req(api, "POST", "/api/v1/deposits/payx", { token: PLAYER, body: { amount: 50_000, phone: "0798661061", method: "MPESA" } });
    assert.equal(dep.status, 202);
    const depText = await dep.text();
    assert.ok(!/paynicorn|https?:/i.test(depText), `initiate leaked a page or the supplier: ${depText}`);
    const { transactionId, checkoutRequestId } = JSON.parse(depText);
    assert.equal(checkoutRequestId, transactionId);

    const pending = await (await req(api, "GET", "/api/v1/transactions?kind=deposit", { token: PLAYER })).json() as any;
    assert.notEqual(pending.items.find((t: any) => t.id === transactionId).status, "success", "nothing is success before the callback");

    const cb = await req(api, "POST", "/api/v1/deposits/paynicorn/callback", { raw: JSON.stringify(signed({ orderId: transactionId })) });
    assert.equal(cb.status, 200);
    assert.match(cb.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await cb.text(), "success_PN77");
    const again = await req(api, "POST", "/api/v1/deposits/paynicorn/callback", { raw: JSON.stringify(signed({ orderId: transactionId })) });
    assert.equal(await again.text(), "success_PN77");

    const bal = await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }));
    assert.equal(bal.real, 150_000);
    const histText = await (await req(api, "GET", "/api/v1/transactions?kind=deposit", { token: PLAYER })).text();
    assert.ok(!/paynicorn/i.test(histText), `history leaked the supplier: ${histText}`);
    const tx = JSON.parse(histText).items.find((t: any) => t.id === transactionId);
    assert.equal(tx.status, "success");
    assert.equal(tx.provider, "payx");
  } finally { await api.close(); }
});

test("payx: the supplier-named deposit route does not exist", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "paynicorn", displayName: "PayX" }]);
    assert.equal((await req(api, "POST", "/api/v1/deposits/paynicorn", { token: PLAYER, body: { amount: 50_000, phone: "0798661061" } })).status, 404);
  } finally { await api.close(); }
});

test("paynicorn callback: form-encoded body works; a forged signature is 401 and credits nothing", async () => {
  const api = await startTestApi({ startingBalanceCents: 0 });
  try {
    api.payRepo.setProviders([{ code: "paynicorn", displayName: "Paynicorn" }]);
    const { transactionId } = await json(await req(api, "POST", "/api/v1/deposits/payx", { token: PLAYER, body: { amount: 50_000, phone: "0798661061" } }));
    const forged = signed({ orderId: transactionId }, "attacker");
    const bad = await req(api, "POST", "/api/v1/deposits/paynicorn/callback", { raw: JSON.stringify(forged) });
    assert.equal(bad.status, 401);
    assert.equal((await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }))).real, 0);

    const env = signed({ orderId: transactionId });
    const form = await req(api, "POST", "/api/v1/deposits/paynicorn/callback", {
      raw: `content=${encodeURIComponent(env.content)}&sign=${env.sign}`, type: "application/x-www-form-urlencoded",
    });
    assert.equal(form.status, 200);
    assert.equal((await json(await req(api, "GET", "/api/v1/wallet", { token: PLAYER }))).real, 50_000);
  } finally { await api.close(); }
});

test("paynicorn callback: address check (GET) and unknown signed orders answer 200", async () => {
  const api = await startTestApi();
  try {
    assert.equal((await req(api, "GET", "/api/v1/deposits/paynicorn/callback")).status, 200);
    const r = await req(api, "POST", "/api/v1/deposits/paynicorn/callback", { raw: JSON.stringify(signed({ orderId: "not-ours", txnId: "T9" })) });
    assert.equal(await r.text(), "success_T9");
  } finally { await api.close(); }
});

test("payx deposit: refused when switched off, below the floor, not whole shillings, or without a valid phone", async () => {
  const api = await startTestApi();
  try {
    api.payRepo.setProviders([{ code: "mpesa", displayName: "M-Pesa" }]);
    const off = await req(api, "POST", "/api/v1/deposits/payx", { token: PLAYER, body: { amount: 50_000, phone: "0798661061" } });
    assert.equal(off.status, 403);
    const offText = await off.text();
    assert.equal(JSON.parse(offText).error.code, "PROVIDER_DISABLED");
    assert.ok(!/paynicorn/i.test(offText));
    api.payRepo.setProviders([{ code: "paynicorn", displayName: "PayX" }]);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payx", { token: PLAYER, body: { amount: 9_900, phone: "0798661061" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payx", { token: PLAYER, body: { amount: 50_050, phone: "0798661061" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payx", { token: PLAYER, body: { amount: 50_000, phone: "nope" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/deposits/payx", { body: { amount: 50_000, phone: "0798661061" } })).status, 401);
  } finally { await api.close(); }
});
