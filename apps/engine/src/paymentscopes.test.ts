import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { InMemoryPaymentRepository } from "./payments.js";
import { PaymentService } from "./paymentservice.js";
import { AffiliateService } from "./affiliateservice.js";
import { InMemoryPaymentScopeRepository, PaymentScopeService, scopeRef } from "./paymentscopes.js";
import type { DarajaClient } from "./daraja.js";

/**
 * PAY-1 (docs/43) — money routing for per-platform / per-brand payment accounts, end to end through the
 * REAL PaymentService with the REAL scoped Daraja client (Safaricom mocked at fetch). Invariants:
 *   1. no mixing across owners (a scope never borrows the System's account, env, or a stub);
 *   2. payouts follow the owner, refused BEFORE approval when the owner cannot pay;
 *   3. verification uses the INITIATING scope; 4. the System Pay Bill is global-only.
 */
const PLATFORM = "10000000-0000-0000-0000-00000000000a";
const SITE = "20000000-0000-0000-0000-00000000000a";
const OTHER_SITE = "20000000-0000-0000-0000-00000000000b";
const PA = "u-pa", OWNER = "u-owner";
const ENV = { PAYMENTS_CONFIG_ENC_KEY: randomBytes(32).toString("base64"),
  // the System owner's env credentials — a scoped client must NEVER use them
  MPESA_CONSUMER_KEY: "OWNER_KEY", MPESA_CONSUMER_SECRET: "OWNER_SECRET", MPESA_SHORTCODE: "999999", MPESA_PASSKEY: "OWNER_PK" } as NodeJS.ProcessEnv;
const CALLBACKS = async () => ({ stkCallbackUrl: "https://api.test/stk", b2cResultUrl: "https://api.test/b2c/result", b2cTimeoutUrl: "https://api.test/b2c/timeout" });

interface Call { url: string; auth?: string | undefined; body?: any }
function safaricom(calls: Call[]): typeof fetch {
  const res = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, auth: h.Authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.includes("/oauth/")) return res({ access_token: "tok", expires_in: 3600 });
    if (u.includes("/stkpush/")) return res({ MerchantRequestID: "m-1", CheckoutRequestID: `c-${calls.length}` });
    if (u.includes("/stkpushquery/")) return res({ ResultCode: "0", ResultDesc: "ok" });
    if (u.includes("/b2c/")) return res({ ConversationID: "conv-1", OriginatorConversationID: "o", ResponseCode: "0" });
    return res({});
  }) as typeof fetch;
}
/** The System owner's global client: records use so tests can prove it was NOT touched. */
function globalDaraja(): DarajaClient & { used: string[] } {
  const used: string[] = [];
  return {
    used,
    async stkPush() { used.push("stkPush"); return { merchantRequestId: "g-m", checkoutRequestId: `g-c-${used.length}` }; },
    async stkPushQuery() { used.push("stkPushQuery"); return { resultCode: 0, processing: false }; },
    async b2cPayment() { used.push("b2cPayment"); return { conversationId: "g-conv" }; },
  } as DarajaClient & { used: string[] };
}
const decodeBasic = (h?: string) => (h ? Buffer.from(h.replace(/^Basic /, ""), "base64").toString() : "");

function setup() {
  const calls: Call[] = [];
  const scopes = new InMemoryPaymentScopeRepository();
  scopes.platforms.set(PLATFORM, "Alpha"); scopes.sitePlatform.set(SITE, PLATFORM); scopes.sitePlatform.set(OTHER_SITE, "30000000-0000-0000-0000-00000000000c");
  scopes.platforms.set("30000000-0000-0000-0000-00000000000c", "Beta");
  scopes.actorPlatform.set(PA, PLATFORM);
  const svc = new PaymentScopeService(scopes, { callbacks: CALLBACKS, env: ENV, fetchImpl: safaricom(calls), ttlMs: 60_000 });
  const repo = new InMemoryPaymentRepository();
  repo.seed("player", 1_000_000);
  const global = globalDaraja();
  const payments = new PaymentService(repo, global, { gateways: svc, verifyStkCallbacks: true });
  return { calls, scopes, svc, repo, global, payments };
}
const FULL_MPESA = { environment: "production", shortcode: "600111", consumer_key: "PLAT_KEY", consumer_secret: "PLAT_SECRET", passkey: "PLAT_PK",
  b2c_initiator: "platop", b2c_security_credential: "cred==", b2c_shortcode: "3000111" };

test("PAY-1: with no active scope every brand stays on the System accounts (no behaviour change)", async () => {
  const { payments, global, repo } = setup();
  const r = await payments.initiateDeposit("player", 100_000, "0712345678", SITE);
  assert.deepEqual(global.used, ["stkPush"]);
  assert.equal((await repo.getTransaction(r.txId))?.paymentScope, "global");
});

test("PAY-1: an ACTIVE platform account receives its brands' deposits — never the System's (invariant 1)", async () => {
  const { svc, payments, global, calls, repo } = setup();
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, FULL_MPESA);
  await svc.activate(PA, "platform_admin", "platform", PLATFORM, true);
  const r = await payments.initiateDeposit("player", 100_000, "0712345678", SITE);
  assert.deepEqual(global.used, [], "the System client was not used");
  const stk = calls.find((c) => c.url.includes("/stkpush/"))!;
  assert.equal(stk.body.BusinessShortCode, "600111", "the platform's paybill");
  assert.equal(decodeBasic(calls.find((c) => c.url.includes("/oauth/"))!.auth), "PLAT_KEY:PLAT_SECRET", "the platform's Daraja app");
  assert.equal((await repo.getTransaction(r.txId))?.paymentScope, scopeRef("platform", PLATFORM));
  // a brand of ANOTHER platform is unaffected
  await payments.initiateDeposit("player", 100_000, "0712345678", OTHER_SITE);
  assert.deepEqual(global.used, ["stkPush"]);
});

test("PAY-1: a rail the owner has not configured is REFUSED, not re-routed to the System (and not offered)", async () => {
  const { svc, payments, repo, global } = setup();
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, FULL_MPESA);
  await svc.activate(PA, "platform_admin", "platform", PLATFORM, true);
  const before = await repo.listUnsettledDeposits(0, 100);
  await assert.rejects(payments.initiateMegaPayDeposit("player", 100_000, "0712345678", SITE), /GATEWAY_NOT_CONFIGURED/);
  assert.equal((await repo.listUnsettledDeposits(0, 100)).length, before.length, "no transaction was created");
  assert.deepEqual((await payments.listDepositProviders(SITE)).map((p) => p.code), ["mpesa"], "Mega Pay is not offered");
  assert.equal((await payments.paybillConfig(SITE)).enabled, false, "the System Pay Bill is hidden");
  await assert.rejects(payments.claimPaybillDeposit("player", "QX1", SITE), /PAYBILL_NOT_AVAILABLE/);
  assert.equal((await payments.paybillConfig(OTHER_SITE)).enabled, true, "still offered on the System accounts");
  assert.deepEqual(global.used, []);
});

test("PAY-1: an INCOMPLETE scoped account fails loudly — no env credentials, no stub (invariant 1)", async () => {
  const { svc, scopes, payments, calls } = setup();
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, { ...FULL_MPESA });
  await svc.activate(PA, "platform_admin", "platform", PLATFORM, true);
  // the passkey is later cleared (e.g. rotated) — deposits must stop, not fall back to the owner's env passkey
  const row = scopes.configs.get(`mpesa|platform:${PLATFORM}`)!;
  const { decryptSecrets, encryptSecrets } = await import("./providercrypto.js");
  const secrets = decryptSecrets(row.ciphertext!, ENV); delete secrets.passkey;
  row.ciphertext = encryptSecrets(secrets, ENV).ciphertext; row.updatedAt = new Date(Date.now() + 1000).toISOString();
  svc.invalidate();
  await assert.rejects(payments.initiateDeposit("player", 100_000, "0712345678", SITE), /GATEWAY_NOT_CONFIGURED/);
  assert.ok(!calls.some((c) => decodeBasic(c.auth).startsWith("OWNER_KEY")), "the owner's env credentials were never used");
});

test("PAY-1: verification uses the INITIATING scope even after the brand switches owner (invariant 3)", async () => {
  const { svc, payments, global, calls, repo } = setup();
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, FULL_MPESA);
  await svc.activate(PA, "platform_admin", "platform", PLATFORM, true);
  const r = await payments.initiateDeposit("player", 100_000, "0712345678", SITE);
  await svc.deactivate(PA, "platform_admin", "platform", PLATFORM);   // brand is back on the System accounts
  const tx = await repo.listUnsettledDeposits(0, 100);
  const checkout = tx.find((d) => d.txId === r.txId)!.checkoutRequestId;
  await payments.handleStkCallback(checkout, 0, "ok", "RCPT1", {});
  const q = calls.filter((c) => c.url.includes("/stkpushquery/"));
  assert.equal(q.length, 1, "queried Safaricom with the platform's app");
  assert.equal(q[0]!.body.BusinessShortCode, "600111");
  assert.ok(!global.used.includes("stkPushQuery"), "not the System client");
});

test("PAY-1: payouts follow the owner — B2C from the platform's shortcode (invariant 2)", async () => {
  const { svc, payments, global, calls, repo } = setup();
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, FULL_MPESA);
  await svc.activate(PA, "platform_admin", "platform", PLATFORM, true);
  const w = await payments.requestWithdrawal("player", 50_000, "0712345678", SITE);
  const out = await payments.approveWithdrawal(w.txId, "admin");
  assert.equal(out.approved, true);
  const b2c = calls.find((c) => c.url.includes("/b2c/"))!;
  assert.equal(b2c.body.PartyA, "3000111");
  assert.equal(b2c.body.ResultURL, `https://api.test/b2c/result/${w.txId}`, "the System's own callback endpoint");
  assert.ok(!global.used.includes("b2cPayment"));
  assert.equal((await repo.getTransaction(w.txId))?.paymentScope, scopeRef("platform", PLATFORM));
});

test("PAY-1: an owner that cannot pay is refused BEFORE approval — the withdrawal stays pending (invariant 2)", async () => {
  const { svc, payments, global, repo } = setup();
  const depositsOnly = { environment: "production", shortcode: "600111", consumer_key: "K", consumer_secret: "S", passkey: "P" };
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, depositsOnly);
  await assert.rejects(svc.activate(PA, "platform_admin", "platform", PLATFORM, true), /PAYOUTS_NOT_CONFIGURED/, "go-live needs a payout path");
  await svc.activate(PA, "platform_admin", "platform", PLATFORM, false);  // explicit "deposits only"
  const w = await payments.requestWithdrawal("player", 50_000, "0712345678", SITE);
  await assert.rejects(payments.approveWithdrawal(w.txId, "admin"), /MPESA_B2C_NOT_CONFIGURED/);
  assert.equal((await repo.getTransaction(w.txId))?.status, "pending", "not stranded in processing");
  assert.ok(!global.used.includes("b2cPayment"), "never paid from the System's B2C");
});

test("PAY-1: go-live needs a complete deposit rail; configs stay drafts until then", async () => {
  const { svc, payments, global } = setup();
  await assert.rejects(svc.activate(PA, "platform_admin", "platform", PLATFORM, true), /NO_DEPOSIT_RAIL_READY/);
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, FULL_MPESA);   // saved, NOT active
  await payments.initiateDeposit("player", 100_000, "0712345678", SITE);
  assert.deepEqual(global.used, ["stkPush"], "a draft never takes live traffic");
});

test("PAY-1: a brand's own active scope wins over its platform's", async () => {
  const { svc, payments, calls } = setup();
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, FULL_MPESA);
  await svc.activate(PA, "platform_admin", "platform", PLATFORM, true);
  await svc.setConfig(PA, "platform_admin", "mpesa", "site", SITE, { ...FULL_MPESA, shortcode: "700222", consumer_key: "SITE_KEY" });
  await svc.activate(PA, "platform_admin", "site", SITE, true);
  await payments.initiateDeposit("player", 100_000, "0712345678", SITE);
  assert.equal(calls.find((c) => c.url.includes("/stkpush/"))!.body.BusinessShortCode, "700222");
});

test("PAY-1: affiliate B2C payouts follow the owner too", async () => {
  const { svc, calls, global } = setup();
  await svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, FULL_MPESA);
  await svc.activate(PA, "platform_admin", "platform", PLATFORM, true);
  const repo = {
    siteOfPayout: async () => SITE,
    approvePayout: async () => ({ approved: true, amountCents: 20_000, phone: "254712345678" }),
  } as unknown as ConstructorParameters<typeof AffiliateService>[0];
  const aff = new AffiliateService(repo, global, svc);
  await aff.approvePayout("p-1", "admin");
  assert.equal(calls.find((c) => c.url.includes("/b2c/"))!.body.PartyA, "3000111");
  assert.ok(!global.used.includes("b2cPayment"));
});

test("PAY-1: console — platform admins are scoped, owner-only fields refused, secrets encrypted + masked", async () => {
  const { svc, scopes } = setup();
  await assert.rejects(svc.setConfig(PA, "platform_admin", "mpesa", "site", OTHER_SITE, FULL_MPESA), /PLATFORM_SCOPE_FORBIDDEN/);
  await assert.rejects(svc.setConfig(PA, "platform_admin", "megapay", "platform", PLATFORM, { email: "a@b.co", api_key: "k", api_base: "https://evil.test" }), /OWNER_ONLY_FIELD: api_base/);
  await assert.rejects(svc.setConfig(PA, "platform_admin", "mpesa", "platform", PLATFORM, { ...FULL_MPESA, environment: "sandbox" }), /OWNER_ONLY_FIELD: env/);
  const saved = await svc.setConfig(PA, "platform_admin", "megapay", "platform", PLATFORM, { email: "a@b.co", api_key: "SECRETKEY1234" });
  assert.equal(saved.settings.env, "production", "a platform admin's account defaults to live");
  assert.deepEqual(saved.secretMeta.api_key, { set: true, last4: "1234" });
  assert.ok(!JSON.stringify(scopes.configs.get(`megapay|platform:${PLATFORM}`)).includes("SECRETKEY1234"), "stored encrypted");
  // a later settings-only edit keeps the secret; a new secret merges over THIS scope's secrets only
  await svc.setConfig(PA, "platform_admin", "megapay", "platform", PLATFORM, { email: "b@b.co" });
  assert.equal((await svc.getConfig(PA, "platform_admin", "megapay", "platform", PLATFORM)).secretMeta.api_key?.last4, "1234");
  const owner = await svc.setConfig(OWNER, "platform_superadmin", "megapay", "platform", PLATFORM, { api_base: "https://sandbox.megapay.test", env: "sandbox" });
  assert.equal(owner.settings.api_base, "https://sandbox.megapay.test", "the System owner may set them");
  assert.ok(!("api_base" in Object.fromEntries(svc.schemas("platform_admin").megapay!.fields.map((f) => [f.key, 1]))), "owner-only fields are not even shown to a platform admin");
});
