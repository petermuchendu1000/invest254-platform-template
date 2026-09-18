import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StubPayHeroClient, HttpPayHeroClient, UnconfiguredPayHeroClient, ConfiguredPayHeroClient,
  mapPayHeroStatus, toLocalMsisdn, resolvePayHeroConfig, missingPayHeroCredentials, type PayHeroConfig,
} from "./payhero.js";

function fakeFetch(spec: { status?: number; body?: unknown; capture?: (url: string, init: any) => void }): typeof fetch {
  return (async (url: string, init: any) => {
    spec.capture?.(String(url), init);
    return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}
const cfg: PayHeroConfig = { baseUrl: "https://backend.payhero.co.ke/api/v2", basicAuthToken: "dXNlcjpwYXNz", channelId: "1487", callbackUrl: "https://x/cb" };

test("toLocalMsisdn normalizes every Kenyan form to 07XXXXXXXX", () => {
  assert.equal(toLocalMsisdn("254712345678"), "0712345678");
  assert.equal(toLocalMsisdn("+254712345678"), "0712345678");
  assert.equal(toLocalMsisdn("0712345678"), "0712345678");
  assert.equal(toLocalMsisdn("712345678"), "0712345678");
});

test("mapPayHeroStatus: SUCCESS->paid(0), FAILED->failed(1), QUEUED->processing", () => {
  assert.deepEqual(mapPayHeroStatus("SUCCESS", "RCPT01"), { resultCode: 0, processing: false, receipt: "RCPT01" });
  assert.deepEqual(mapPayHeroStatus("FAILED", null), { resultCode: 1, processing: false, receipt: null });
  assert.deepEqual(mapPayHeroStatus("QUEUED", null), { resultCode: null, processing: true, receipt: null });
});

test("HttpPayHeroClient.initiateStk posts the exact PayHero contract + parses reference", async () => {
  let seen: any = {};
  const c = new HttpPayHeroClient(cfg, fakeFetch({ status: 201, body: { success: true, status: "QUEUED", reference: "E8UWT7CLUW", CheckoutRequestID: "ws_CO_1" }, capture: (_u, i) => (seen = i) }));
  const r = await c.initiateStk({ amountCents: 20_000, msisdn: "254798123061", externalReference: "tx-1", customerName: "Jo" });
  assert.deepEqual(r, { reference: "E8UWT7CLUW", checkoutRequestId: "ws_CO_1" });
  const body = JSON.parse(seen.body);
  assert.equal(body.amount, 200);            // cents -> whole KES
  assert.equal(body.phone_number, "0798123061"); // local form
  assert.equal(body.channel_id, 1487);       // integer
  assert.equal(body.provider, "m-pesa");
  assert.equal(body.external_reference, "tx-1");
  assert.equal(body.callback_url, "https://x/cb");
  assert.equal(seen.headers.Authorization, "Basic dXNlcjpwYXNz");
});

test("HttpPayHeroClient.initiateStk throws on rejection (success:false / no reference)", async () => {
  const c = new HttpPayHeroClient(cfg, fakeFetch({ status: 400, body: { error_message: "bad" } }));
  await assert.rejects(() => c.initiateStk({ amountCents: 20_000, msisdn: "0798123061", externalReference: "tx-1" }), /PAYHERO_INITIATE_REJECTED/);
});

test("HttpPayHeroClient.queryStatus maps SUCCESS + provider_reference; !ok -> processing", async () => {
  const ok = new HttpPayHeroClient(cfg, fakeFetch({ status: 200, body: { status: "SUCCESS", success: true, provider_reference: "SKQ96C7K7H" } }));
  assert.deepEqual(await ok.queryStatus("E8U"), { resultCode: 0, processing: false, receipt: "SKQ96C7K7H" });
  const down = new HttpPayHeroClient(cfg, fakeFetch({ status: 500, body: {} }));
  assert.deepEqual(await down.queryStatus("E8U"), { resultCode: null, processing: true, receipt: null }); // never credit on transient
});

test("missingPayHeroCredentials requires basic_auth_token + channel_id", () => {
  assert.deepEqual(missingPayHeroCredentials(resolvePayHeroConfig({}, {} as any)), ["basic_auth_token", "channel_id"]);
  assert.deepEqual(missingPayHeroCredentials(resolvePayHeroConfig({ basicAuthToken: "t", channelId: "1" }, {} as any)), []);
});

test("UnconfiguredPayHeroClient fails loudly (never a phantom credit)", async () => {
  const c = new UnconfiguredPayHeroClient(["basic_auth_token"]);
  await assert.rejects(() => c.queryStatus("x"), /PAYHERO_NOT_CONFIGURED/);
});

test("ConfiguredPayHeroClient: no override / resolver throw -> env (behaviour-neutral stub in dev)", async () => {
  const noEnv = {} as NodeJS.ProcessEnv;
  const a = new ConfiguredPayHeroClient(async () => null, noEnv);
  assert.equal((await a.initiateStk({ amountCents: 20_000, msisdn: "0712345678", externalReference: "t" })).reference, "stub-ph-ref-1");
  const b = new ConfiguredPayHeroClient(async () => { throw new Error("db down"); }, noEnv);
  assert.equal((await b.initiateStk({ amountCents: 20_000, msisdn: "0712345678", externalReference: "t" })).reference, "stub-ph-ref-1");
});

test("ConfiguredPayHeroClient: complete override w/ prod env + missing channel -> fails loudly", async () => {
  const prod = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
  const c = new ConfiguredPayHeroClient(async () => ({ basicAuthToken: "t" }), prod); // channel_id missing
  await assert.rejects(() => c.queryStatus("x"), /PAYHERO_NOT_CONFIGURED/);
});
