import { test } from "node:test";
import assert from "node:assert/strict";
import type { Cents } from "@invest254/shared";
import {
  HttpPaynicornClient, StubPaynicornClient, UnconfiguredPaynicornClient, ConfiguredPaynicornClient, STUB_PAYNICORN_SECRET,
  paynicornSign, encodeContent, decodeContent, signMatches, mapPaynicornStatus, readPostbackEnvelope,
  missingPaynicornCredentials, resolvePaynicornConfig, toPaynicornPhone, toPaynicornMethod, methodIsDirect,
} from "./paynicorn.js";
import { PAYNICORN_COUNTRIES, paynicornCountry, formatPaynicornAmount } from "./paynicorncountries.js";
import { testConnection } from "./gatewaytest.js";
import { GATEWAY_SCHEMAS, PLAYER_DEPOSIT_RAILS, splitSubmission, validateConfig } from "./gatewayschema.js";

const SECRET = "143f824b235c4a649b60fae3d1aa5fe6";
const cents = (n: number) => n as Cents;

test("paynicorn sign: reproduces the official documentation vector", () => {
  // docs/overview/authorization — merchant secret + content_base64 -> sign
  const content = "eyJhbW91bnQiOiIzMDAwMCIsImNvdW50cnlDb2RlIjoiSUQiLCJjcEZyb250UGFnZSI6Imh0dHA6Ly93d3cuYmFpZHUuY29tIiwiY3VycmVuY3kiOiJJRFIiLCJlbWFpbCI6IjExMUAxMTEuY29tIiwibWVtbyI6Ik1lbW8iLCJvcmRlckRlc2NyaXB0aW9uIjoiSSBhbSBUZXN0ISIsInBheVR5cGUiOiJEQU5BIiwicGhvbmUiOiIwMjIxOTA5MjM0NSIsInVzZXJJZCI6IlUyMDMyMzEyMyIsIm9yZGVySWQiOiJYWlNfVEVTVDE2MDk0MDk4NDQ2MTAifQ==";
  assert.equal(paynicornSign(content, SECRET), "3dc08594b8877479d8a5cb44a5b76b21");
  assert.ok(signMatches(content, "3DC08594B8877479D8A5CB44A5B76B21", SECRET), "hex case is not significant");
  assert.ok(!signMatches(content, "3dc08594b8877479d8a5cb44a5b76b21", SECRET + "x"));
  assert.ok(!signMatches("", "x", SECRET) && !signMatches(content, "", SECRET) && !signMatches(content, "x", ""));
});

test("paynicorn content: base64(JSON) round-trips, including non-ASCII", () => {
  const c = encodeContent({ orderId: "a-1", orderDescription: "Dépôt — KES" });
  assert.deepEqual(decodeContent(c), { orderId: "a-1", orderDescription: "Dépôt — KES" });
});

test("paynicorn amount: formatted to each country's own decimals", () => {
  assert.equal(formatPaynicornAmount(200, 0), "200");        // KES — no decimals
  assert.equal(formatPaynicornAmount(200.456, 2), "200.46"); // NGN — two
  assert.equal(formatPaynicornAmount(200.44, 1), "200.4");   // AED — one
  assert.equal(formatPaynicornAmount(1234.6, 0), "1235");    // a converted amount rounds to the unit
  assert.throws(() => formatPaynicornAmount(0, 0), /AMOUNT_INVALID/);
  assert.throws(() => formatPaynicornAmount(-5, 2), /AMOUNT_INVALID/);
});

test("paynicorn countries: every country Paynicorn publishes, with its currency and decimals", () => {
  assert.equal(PAYNICORN_COUNTRIES.length, 32, "all 32 published countries are supported");
  assert.deepEqual(paynicornCountry("ke"), { code: "KE", name: "Kenya", currency: "KES", decimals: 0 });
  assert.equal(paynicornCountry("NG")?.currency, "NGN");
  assert.equal(paynicornCountry("NG")?.decimals, 2);
  assert.equal(paynicornCountry("AE")?.decimals, 1, "Gulf currencies take one decimal");
  assert.equal(paynicornCountry("ZZ"), null);
  // every code is unique and every currency/decimal pair is stated, never defaulted
  assert.equal(new Set(PAYNICORN_COUNTRIES.map((c) => c.code)).size, PAYNICORN_COUNTRIES.length);
  for (const c of PAYNICORN_COUNTRIES) assert.ok(/^[A-Z]{2}$/.test(c.code) && /^[A-Z]{3}$/.test(c.currency));
});

test("paynicorn methods: normalised from the live shape; direct only when phone/email is all it needs", () => {
  const mpesa = toPaynicornMethod({ code: "MPESA", name: "M-Pesa", methodType: "WALLET", icon: "https://cdn.example/x.png", minAmount: 1, maxAmount: null, inputs: [{ name: "Phone_KE", type: "Phone", reg: "^[0]?\\d{9}$" }] })!;
  assert.deepEqual(mpesa.inputs, [{ name: "Phone_KE", type: "Phone", pattern: "^[0]?\\d{9}$" }]);
  assert.equal(mpesa.iconUrl, "https://cdn.example/x.png");
  assert.equal(methodIsDirect(mpesa), true);
  const card = toPaynicornMethod({ code: "CARD", methodType: "CARD", inputs: [{ name: "CardNo", type: "Text" }] })!;
  assert.equal(card.name, "CARD", "a method with no name falls back to its code");
  assert.equal(methodIsDirect(card), false, "a field we cannot supply means the hosted page");
  const bank = toPaynicornMethod({ code: "BANK", methodType: "BANK", inputs: [] })!;
  assert.equal(methodIsDirect(bank), true, "no inputs at all is still directly initiable");
  assert.equal(toPaynicornMethod({ name: "no code" }), null);
});

test("paynicorn status: 1 paid, 0 failed, -1/unknown processing", () => {
  assert.deepEqual(mapPaynicornStatus("1", "t"), { resultCode: 0, processing: false, txnId: "t" });
  assert.deepEqual(mapPaynicornStatus("0"), { resultCode: 1, processing: false, txnId: null });
  assert.equal(mapPaynicornStatus("-1").processing, true);
  assert.equal(mapPaynicornStatus(undefined).resultCode, null);
});

test("paynicorn postback envelope: JSON object, JSON text, Buffer and form-encoded", () => {
  const want = { content: "Y29udA==", sign: "abc" };
  assert.deepEqual(readPostbackEnvelope(want), want);
  assert.deepEqual(readPostbackEnvelope(JSON.stringify(want)), want);
  assert.deepEqual(readPostbackEnvelope(Buffer.from(JSON.stringify(want))), want);
  assert.deepEqual(readPostbackEnvelope(`content=${encodeURIComponent(want.content)}&sign=abc`), want);
  assert.equal(readPostbackEnvelope({ content: "x" }), null);
  assert.equal(readPostbackEnvelope(""), null);
  assert.equal(readPostbackEnvelope("{not json"), null);
});

/** A fake Paynicorn server: checks the request signature and answers a signed envelope. */
function fakePaynicorn(answer: (op: string, biz: any) => Record<string, unknown>, opts: { secret?: string; responseCode?: string; tamper?: boolean } = {}) {
  const calls: Array<{ url: string; body: any; biz: any }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.sign, paynicornSign(body.content, SECRET), "request must be signed with the merchant secret");
    const biz = decodeContent(body.content);
    calls.push({ url, body, biz });
    const op = url.split("/").pop()!;
    if (opts.responseCode && opts.responseCode !== "000000") return new Response(JSON.stringify({ responseCode: opts.responseCode, responseMessage: "nope" }), { status: 200 });
    const content = encodeContent(answer(op, biz));
    const sign = opts.tamper ? "0".repeat(32) : paynicornSign(content, opts.secret ?? SECRET);
    return new Response(JSON.stringify({ responseCode: "000000", responseMessage: "success", content, sign }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const CFG = { baseUrl: "https://api.paynicorn.test/", appKey: "7971321", merchantSecret: SECRET };

test("paynicorn http: pay sends a signed KE/KES order and returns the cashier URL", async () => {
  const f = fakePaynicorn(() => ({ code: "0000", message: "ok", txnId: "PN1", status: "-1", webUrl: "https://cashier/x" }));
  const c = new HttpPaynicornClient({ ...CFG, frontPage: "https://default/wallet" }, f.impl);
  const out = await c.pay({ amount: "500", countryCode: "KE", currency: "KES", orderId: "tx-1", description: "Deposit", frontPage: "https://cpfmarket.com/wallet" });
  assert.deepEqual(out, { txnId: "PN1", webUrl: "https://cashier/x", status: "-1" });
  assert.equal(f.calls[0]!.url, "https://api.paynicorn.test/trade/v3/transaction/pay");
  assert.equal(f.calls[0]!.body.appKey, "7971321");
  assert.deepEqual(f.calls[0]!.biz, { amount: "500", countryCode: "KE", currency: "KES", orderId: "tx-1", orderDescription: "Deposit", cpFrontPage: "https://cpfmarket.com/wallet" });
});

test("paynicorn http: method + phone is a direct push — no page, no cpFrontPage, null webUrl accepted", async () => {
  const f = fakePaynicorn(() => ({ code: "0000", message: "success", txnId: "PN2", status: "-1", webUrl: null }));
  const c = new HttpPaynicornClient({ ...CFG, frontPage: "https://default/wallet" }, f.impl);
  const out = await c.pay({ amount: "130", countryCode: "KE", currency: "KES", orderId: "tx-2", description: "Deposit", payMethod: "MPESA", phone: "798661061" });
  assert.deepEqual(out, { txnId: "PN2", webUrl: "", status: "-1" });
  assert.deepEqual(f.calls[0]!.biz, { amount: "130", countryCode: "KE", currency: "KES", orderId: "tx-2", orderDescription: "Deposit", payMethod: "MPESA", phone: "798661061" });
  const refused = new HttpPaynicornClient(CFG, fakePaynicorn(() => ({ code: "101002", message: "bad", status: "0", webUrl: null })).impl);
  await assert.rejects(refused.pay({ amount: "130", countryCode: "KE", currency: "KES", orderId: "o", description: "d", payMethod: "MPESA", phone: "798661061" }), /PAY_REFUSED:101002/);
});

test("paynicorn phone: 9 local digits, whatever form the MSISDN arrives in", () => {
  for (const p of ["0798661061", "254798661061", "+254 798 661 061", "798661061"]) assert.equal(toPaynicornPhone(p), "798661061");
  assert.equal(toPaynicornPhone("0112345678"), "112345678");
  assert.throws(() => toPaynicornPhone("12345"), /INVALID_PHONE/);
});

test("paynicorn http: pay refuses a failed order, an envelope error, and an unsigned response", async () => {
  const failed = new HttpPaynicornClient(CFG, fakePaynicorn(() => ({ code: "1001", message: "bad", status: "0", webUrl: "" })).impl);
  await assert.rejects(failed.pay({ amount: "200", countryCode: "KE", currency: "KES", orderId: "o", description: "d" }), /PAYNICORN_PAY_REFUSED/);
  const authFail = new HttpPaynicornClient(CFG, fakePaynicorn(() => ({}), { responseCode: "204005" }).impl);
  await assert.rejects(authFail.pay({ amount: "200", countryCode: "KE", currency: "KES", orderId: "o", description: "d" }), /REJECTED_200:204005/);
  const forged = new HttpPaynicornClient(CFG, fakePaynicorn(() => ({ status: "-1", webUrl: "https://evil" }), { tamper: true }).impl);
  await assert.rejects(forged.pay({ amount: "200", countryCode: "KE", currency: "KES", orderId: "o", description: "d" }), /BAD_SIGNATURE/);
});

test("paynicorn http: listMethods parses the live shape; an out-of-scope country is simply empty", async () => {
  const f = fakePaynicorn(() => ({ code: "0000", message: "success", methodInfo: [
    { code: "MPESA", name: "M-Pesa", methodType: "WALLET", icon: "https://cdn/x.png", minAmount: 1, inputs: [{ name: "Phone_KE", type: "Phone", reg: "^[0]?\\d{9}$" }] },
    { code: "CARD", name: "Card", methodType: "CARD", inputs: [{ name: "CardNo", type: "Text" }] },
    { name: "junk with no code" },
  ] }));
  const c = new HttpPaynicornClient(CFG, f.impl);
  const got = await c.listMethods("NG", "NGN");
  assert.deepEqual(got.map((m) => [m.code, m.name, m.methodType]), [["MPESA", "M-Pesa", "WALLET"], ["CARD", "Card", "CARD"]]);
  assert.deepEqual(f.calls[0]!.biz, { countryCode: "NG", currency: "NGN", txnType: "payment" });
  // 101016: the country is not in the merchant's console scope — an empty list, not an error.
  const none = new HttpPaynicornClient(CFG, fakePaynicorn(() => ({ code: "101016", message: "not open", methodInfo: [] })).impl);
  assert.deepEqual(await none.listMethods("GH", "GHS"), []);
});

test("paynicorn http: pay carries whatever country, currency and amount it is given", async () => {
  const f = fakePaynicorn(() => ({ code: "0000", txnId: "PN3", status: "-1", webUrl: "https://cashier/ng" }));
  const c = new HttpPaynicornClient(CFG, f.impl);
  const out = await c.pay({ amount: "1500.75", countryCode: "NG", currency: "NGN", orderId: "tx-ng", description: "Deposit", payMethod: "CARD", frontPage: "https://brand/wallet" });
  assert.equal(out.webUrl, "https://cashier/ng", "a hosted method hands back its page");
  assert.deepEqual(f.calls[0]!.biz, { amount: "1500.75", countryCode: "NG", currency: "NGN", orderId: "tx-ng", orderDescription: "Deposit", payMethod: "CARD", cpFrontPage: "https://brand/wallet" });
});

test("paynicorn http: an email-only method is pushed directly, with no page", async () => {
  const f = fakePaynicorn(() => ({ code: "0000", txnId: "PN4", status: "-1", webUrl: null }));
  const c = new HttpPaynicornClient(CFG, f.impl);
  const out = await c.pay({ amount: "10.00", countryCode: "US", currency: "USD", orderId: "tx-us", description: "D", payMethod: "WALLETX", email: "a@b.com" });
  assert.equal(out.webUrl, "");
  assert.equal(f.calls[0]!.biz.email, "a@b.com");
  assert.equal(f.calls[0]!.biz.cpFrontPage, undefined, "a direct push needs no return page");
});

test("paynicorn http: query maps status; a transport/signature failure is 'processing', never paid", async () => {
  const paid = new HttpPaynicornClient(CFG, fakePaynicorn((_op, biz) => ({ txnId: "PN9", status: "1", orderId: biz.orderId })).impl);
  assert.deepEqual(await paid.queryPayment("tx-9"), { resultCode: 0, processing: false, txnId: "PN9" });
  const forged = new HttpPaynicornClient(CFG, fakePaynicorn(() => ({ status: "1" }), { tamper: true }).impl);
  assert.deepEqual(await forged.queryPayment("tx-9"), { resultCode: null, processing: true, txnId: null });
  const down = new HttpPaynicornClient(CFG, (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
  assert.equal((await down.queryPayment("tx-9")).processing, true);
});

test("paynicorn http: postbacks verify only with our secret", async () => {
  const c = new HttpPaynicornClient(CFG);
  const content = encodeContent({ txnId: "PN1", orderId: "tx-1", amount: "500", currency: "KES", countryCode: "KE", status: "1", code: "0000", message: "ok" });
  const ok = await c.verifyPostback({ content, sign: paynicornSign(content, SECRET) });
  assert.equal(ok?.orderId, "tx-1");
  assert.equal(ok?.status, "1");
  assert.equal(await c.verifyPostback({ content, sign: paynicornSign(content, "attacker") }), null);
  assert.equal(await c.verifyPostback({ orderId: "tx-1", status: "1" }), null, "an unsigned body never verifies");
});

test("paynicorn stub + unconfigured clients", async () => {
  const s = new StubPaynicornClient();
  assert.match((await s.pay({ amount: "200", countryCode: "KE", currency: "KES", orderId: "o1", description: "d" })).webUrl, /order=o1/);
  const content = encodeContent({ txnId: "t", orderId: "o1", status: "1" });
  assert.equal((await s.verifyPostback({ content, sign: paynicornSign(content, STUB_PAYNICORN_SECRET) }))?.orderId, "o1");
  const u = new UnconfiguredPaynicornClient(["merchant_secret"]);
  await assert.rejects(u.pay({ amount: "200", countryCode: "KE", currency: "KES", orderId: "o", description: "d" }), /PAYNICORN_NOT_CONFIGURED:merchant_secret/);
  await assert.rejects(u.queryPayment("o"), /PAYNICORN_NOT_CONFIGURED/);
  assert.equal(await u.verifyPostback({ content, sign: "x" }), null);
});

test("paynicorn config: env fallback, DB override, and production refuses the stub", async () => {
  assert.deepEqual(missingPaynicornCredentials(resolvePaynicornConfig({}, {})), ["app_key", "merchant_secret"]);
  const env = { PAYNICORN_APP_KEY: "k", PAYNICORN_MERCHANT_SECRET: SECRET, NODE_ENV: "production" } as NodeJS.ProcessEnv;
  assert.equal(resolvePaynicornConfig({}, env).baseUrl, "https://api.paynicorn.com");
  const prodEmpty = new ConfiguredPaynicornClient(async () => null, { NODE_ENV: "production" } as NodeJS.ProcessEnv);
  await assert.rejects(prodEmpty.pay({ amount: "200", countryCode: "KE", currency: "KES", orderId: "o", description: "d" }), /PAYNICORN_NOT_CONFIGURED/);
  const dbWins = new ConfiguredPaynicornClient(async () => ({ appKey: "db", merchantSecret: "dbsecret" }), env);
  const content = encodeContent({ orderId: "o" });
  assert.ok(await dbWins.verifyPostback({ content, sign: paynicornSign(content, "dbsecret") }), "DB secret is the one in force");
  assert.equal(await dbWins.verifyPostback({ content, sign: paynicornSign(content, SECRET) }), null);
});

test("paynicorn schema: a player rail with app key + encrypted merchant secret", () => {
  assert.ok(PLAYER_DEPOSIT_RAILS.has("paynicorn"));
  assert.equal(GATEWAY_SCHEMAS.paynicorn!.playerAvailable, true);
  const split = splitSubmission("paynicorn", { app_key: "7971321", merchant_secret: SECRET, front_page: "https://cpfmarket.com/wallet" });
  assert.deepEqual(split.secrets, { merchant_secret: SECRET });
  assert.deepEqual(validateConfig("paynicorn", split), []);
  assert.deepEqual(validateConfig("paynicorn", splitSubmission("paynicorn", { app_key: "k" })).map((i) => i.field), ["merchant_secret"]);
  assert.deepEqual(validateConfig("paynicorn", splitSubmission("paynicorn", { app_key: "k" }), ["merchant_secret"]), [], "a stored secret satisfies the requirement");
});

test("paynicorn connection test: signed query, codes mapped, secret never echoed", async () => {
  const answer = (code: string) => (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    assert.equal(b.sign, paynicornSign(b.content, SECRET));
    return new Response(JSON.stringify({ responseCode: code, responseMessage: "m" }), { status: 200 });
  }) as unknown as typeof fetch;
  const cfg = { app_key: "7971321", merchant_secret: SECRET };
  assert.equal((await testConnection("paynicorn", cfg, answer("000000"))).status, "valid");
  const bad = await testConnection("paynicorn", cfg, answer("204005"));
  assert.equal(bad.status, "invalid");
  assert.ok(!bad.detail.includes(SECRET));
  assert.equal((await testConnection("paynicorn", { app_key: "k" }, answer("000000"))).status, "not_configured");
});
