import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PaymentScopeService, PgPaymentScopeRepository, PgPaymentRepository, PaymentService, type DarajaClient } from "@invest254/engine";

/**
 * PAY-1 (docs/43) against the REAL schema (0160) with the REAL repositories: a platform admin saves and
 * activates its own M-Pesa account; a player's deposit is initiated on it, stamped with the scope in
 * `transactions`, verified with it after the platform switches back, credited once; a withdrawal is paid
 * from the platform's B2C. Safaricom is mocked at fetch. E2E_PG_DSN only; everything is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;
const ENV = { PAYMENTS_CONFIG_ENC_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;

test("PAY-1 (real schema): deposit + verify + payout routed through a platform's own accounts", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const q = { query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) };
    const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
    const reg = async (phone: string, user: string, site: string) =>
      (await one("select user_id from fn_register_user($1,$2,$3,null,$4)", [phone, user, "x".repeat(32), site])).user_id as string;

    const owner = await reg("254711900000", "pay1owner", "00000000-0000-0000-0000-000000000001");
    await c.query("update profiles set role='platform_superadmin' where id=$1", [owner]);
    const plat = (await one("select fn_platform_create_platform($1,'platform_superadmin','pay1pg','Pay1 PG') as id", [owner])).id as string;
    await c.query("insert into platform_subscriptions(platform_id, plan_key, status) values ($1,'enterprise','active') on conflict (platform_id) do update set plan_key='enterprise'", [plat]);
    const site = (await one("select fn_platform_create_site($1,'platform_superadmin','pay1-pg','Pay1 Brand') as id", [owner])).id as string;
    await one("select fn_platform_assign_site($1,'platform_superadmin',$2,$3)", [owner, site, plat]);
    const pa = await reg("254711900001", "pay1pa", "00000000-0000-0000-0000-000000000001");
    await one("select fn_platform_appoint_platform_admin($1,'platform_superadmin',$2,$3)", [owner, pa, plat]);
    const player = await reg("254711900002", "pay1player", site);
    await c.query("update wallets set real_balance = 500000 where user_id=$1", [player]);

    const calls: Array<{ url: string; body?: any }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const res = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/oauth/")) return res({ access_token: "tok", expires_in: 3600 });
      if (u.includes("/stkpush/")) return res({ MerchantRequestID: "m-pg", CheckoutRequestID: "ws_CO_pay1pg" });
      if (u.includes("/stkpushquery/")) return res({ ResultCode: "0", ResultDesc: "ok" });
      if (u.includes("/b2c/")) return res({ ConversationID: "AG_pg", OriginatorConversationID: "o", ResponseCode: "0" });
      return res({});
    }) as typeof fetch;
    const scopes = new PaymentScopeService(new PgPaymentScopeRepository(q), {
      env: ENV, fetchImpl, ttlMs: 0,
      callbacks: async () => ({ stkCallbackUrl: "https://api.test/stk", b2cResultUrl: "https://api.test/b2c", b2cTimeoutUrl: "https://api.test/b2c/t" }),
    });
    const globalUsed: string[] = [];
    const globalDaraja = {
      async stkPush() { globalUsed.push("stk"); return { merchantRequestId: "g", checkoutRequestId: "g" }; },
      async stkPushQuery() { globalUsed.push("query"); return { resultCode: 0, processing: false }; },
      async b2cPayment() { globalUsed.push("b2c"); return { conversationId: "g" }; },
    } as DarajaClient;
    const payments = new PaymentService(new PgPaymentRepository(q), globalDaraja, { gateways: scopes, verifyStkCallbacks: true });

    // the platform admin brings its own account and goes live
    await scopes.setConfig(pa, "platform_admin", "mpesa", "platform", plat, {
      shortcode: "600777", consumer_key: "PKEY", consumer_secret: "PSEC", passkey: "PPK", b2c_initiator: "op", b2c_security_credential: "cred==", b2c_shortcode: "3000777" });
    const stored = await one("select secret_ciphertext, settings from payment_provider_config where platform_id=$1 and provider_code='mpesa'", [plat]);
    assert.ok(stored.secret_ciphertext && !String(stored.secret_ciphertext).includes("PKEY"), "secrets encrypted at rest");
    assert.equal(stored.settings.environment, "production");
    await scopes.activate(pa, "platform_admin", "platform", plat, true);
    assert.equal((await one("select scope from fn_payment_owner_scope($1)", [site])).scope, `platform:${plat}`);

    // deposit on the platform's paybill, stamped in the DB
    const dep = await payments.initiateDeposit(player, 100_000, "0711900002", site);
    assert.equal(calls.find((x) => x.url.includes("/stkpush/"))!.body.BusinessShortCode, "600777");
    const tx = await one("select payment_scope, status from transactions where id=$1", [dep.txId]);
    assert.equal(tx.payment_scope, `platform:${plat}`);

    // the platform switches back to the System accounts BEFORE the callback arrives: verification still
    // uses the account the deposit was made on, and credits exactly once
    await scopes.deactivate(pa, "platform_admin", "platform", plat);
    const r1 = await payments.handleStkCallback("ws_CO_pay1pg", 0, "ok", "RCPT-PG", {});
    const r2 = await payments.handleStkCallback("ws_CO_pay1pg", 0, "ok", "RCPT-PG", {});
    assert.equal(r1.applied, true); assert.equal(r2.applied, false, "idempotent");
    assert.equal(calls.filter((x) => x.url.includes("/stkpushquery/"))[0]!.body.BusinessShortCode, "600777");
    assert.deepEqual(globalUsed, [], "the System account was never touched");

    // live again: the withdrawal is paid from the platform's B2C shortcode
    await scopes.activate(pa, "platform_admin", "platform", plat, true);
    const w = await payments.requestWithdrawal(player, 50_000, "0711900002", site);
    await payments.approveWithdrawal(w.txId, owner);
    assert.equal(calls.find((x) => x.url.includes("/b2c/"))!.body.PartyA, "3000777");
    assert.equal((await one("select payment_scope from transactions where id=$1", [w.txId])).payment_scope, `platform:${plat}`);
    const notes = await one("select count(*)::int n from user_notifications where user_id=$1 and category='payments'", [owner]);
    assert.ok(notes.n >= 3, "the System owner was told about every switch");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
