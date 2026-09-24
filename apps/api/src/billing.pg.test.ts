import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { BillingService, PgBillingRepository, type DarajaClient } from "@invest254/engine";

/**
 * BILL-1 (docs/47) against the REAL schema (0165) with the REAL repository: a renewal is invoiced by "Run
 * billing now", the platform admin sees it, pays with M-Pesa (STK pushed from the System client with the
 * 12-character account reference), the verified callback pays the invoice exactly once, and the owner's
 * overview counts the money. E2E_PG_DSN only; everything is rolled back.
 */
const DSN = process.env.E2E_PG_DSN;

test("BILL-1 (real schema): renewal -> platform admin pays by M-Pesa -> verified settle -> overview", { skip: !DSN }, async () => {
  const pool = new pg.Pool({ connectionString: DSN });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const q = { query: (sql: string, p?: unknown[]) => c.query(sql, p as unknown[]) };
    const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
    const reg = async (phone: string, user: string, site: string) =>
      (await one("select user_id from fn_register_user($1,$2,$3,null,$4)", [phone, user, "x".repeat(32), site])).user_id as string;
    const owner = await reg("254711920000", "bill1owner", "00000000-0000-0000-0000-000000000001");
    await c.query("update profiles set role='platform_superadmin' where id=$1", [owner]);
    const plat = (await one("select fn_platform_create_platform($1,'platform_superadmin','bill1pg','Bill1 PG') as id", [owner])).id as string;
    const site = (await one("select fn_platform_create_site($1,'platform_superadmin','bill1-a','Bill One') as id", [owner])).id as string;
    await one("select fn_platform_assign_site($1,'platform_superadmin',$2,$3)", [owner, site, plat]);
    const pa = await reg("254711920001", "bill1pa", site);
    await one("select fn_platform_appoint_platform_admin($1,'platform_superadmin',$2,$3)", [owner, pa, plat]);
    await one("select fn_subscription_set_plan($1,'platform_superadmin',$2,'business')", [owner, plat]);
    await one("select fn_subscription_set_status($1,'platform_superadmin',$2,'active','t')", [owner, plat]);
    await c.query("update platform_subscriptions set current_period_end = now() - interval '1 hour' where platform_id=$1", [plat]);

    const pushes: { amountCents: number; accountRef: string }[] = [];
    const daraja: DarajaClient = {
      async stkPush(a) { pushes.push({ amountCents: a.amountCents, accountRef: a.accountRef }); return { merchantRequestId: "m", checkoutRequestId: "ws_CO_BILL1PG" }; },
      async stkPushQuery() { return { resultCode: 0, processing: false }; },
      async b2cPayment() { throw new Error("no"); },
    };
    const svc = new BillingService(new PgBillingRepository(q), { daraja: () => daraja });

    const run = await svc.runNow(owner, "platform_superadmin");
    assert.ok(run.issued >= 1);
    const list = await svc.invoices(pa, "platform_admin", {});
    assert.equal(list.length, 1); assert.equal(list[0]!.totalCents, 4000000); assert.equal(list[0]!.status, "open");
    const inv = await svc.invoice(pa, "platform_admin", list[0]!.id);
    assert.equal(inv.lines[0]!.kind, "plan"); assert.equal(inv.seller.name.length > 0, true);
    const [acct] = await svc.accounts(pa, "platform_admin");
    assert.equal(acct!.balanceDueCents, 4000000); assert.equal(acct!.planKey, "business");

    const pay = await svc.payNow(pa, "platform_admin", inv.id, "0712345678");
    assert.equal(pay.amountCents, 4000000);
    assert.equal(pushes[0]!.accountRef.length <= 12, true);
    const cb = await svc.handleStkCallback("ws_CO_BILL1PG", 0, "ok", "QKPG1", { test: true });
    assert.equal(cb.handled, true); assert.equal(cb.result?.applied, true); assert.equal(cb.result?.invoiceStatus, "paid");
    const again = await svc.handleStkCallback("ws_CO_BILL1PG", 0, "ok", "QKPG1", { test: true });
    assert.equal(again.result?.applied, false, "a repeated callback never pays twice");
    assert.deepEqual(await svc.handleStkCallback("ws_some_deposit", 0, "ok", "R", {}), { handled: false });

    const paid = await svc.invoice(owner, "platform_superadmin", inv.id);
    assert.equal(paid.status, "paid"); assert.equal(paid.payments[0]!.reference, "QKPG1");
    const ov = await svc.overview(owner, "platform_superadmin");
    assert.ok(ov.collectedThisMonthCents >= 4000000);
    const plans = await svc.plans();
    assert.ok(plans.find((p) => p.key === "business")!.platforms >= 1);
    await assert.rejects(() => svc.overview(pa, "platform_admin"), /NOT_AUTHORIZED/);   // last: aborts the tx
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
});
