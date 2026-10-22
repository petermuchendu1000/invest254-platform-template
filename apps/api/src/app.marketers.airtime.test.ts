import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";
import { mpesaCode } from "./mpesa.js";

/**
 * The marketer's own email, and airtime bought out of the wallet (0207, docs/66).
 *
 * Both exist because docs/65 shipped a statement that could not be emailed to anybody and could
 * not report a purchase. What is proven here is that the money moves between the two buckets of
 * one wallet and nowhere else, that Fuliza cannot fund it, that the full target number never
 * reaches the ledger, and that an address is the marketer's own to set and nobody else's.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const SITE_A = "00000000-0000-0000-0000-000000000001";
const ADMIN_A = `u-admin:admin:${SITE_A}`;
const mtok = (id: string) => `${id}:marketer`;
const AIR = "/api/v1/marketers/me/airtime";
const MAIL = "/api/v1/marketers/me/email";
let n = 0;
const newRef = () => `air-${Date.now()}-${++n}-aaaaaaaa`;

const d = (offsetDays: number): string => {
  const t = new Date(Date.now() + offsetDays * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};
const STMT = `/api/v1/marketers/me/statement?from=${d(-2)}&to=${d(2)}`;

async function marketer(api: TestApi, name: string, phone: string, cents = 0): Promise<string> {
  const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN_A, body: { name, phone } }))).id as string;
  if (cents) await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN_A, body: { amountCents: cents, ref: `seed-${id}` } });
  return id;
}
const me = async (api: TestApi, id: string) => json(await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) }));

// ── The email ─────────────────────────────────────────────────────────────────────────────────────

test("a marketer sets their own email, and it comes back normalised", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057170");
    assert.equal((await me(api, id)).email, null, "a new marketer has no address");

    const r = await json(await req(api, "POST", MAIL, { token: mtok(id), body: { email: "  Faith@Example.COM  " } }));
    // Trimmed and lower-cased, so one inbox cannot be stored as two near-duplicates.
    assert.equal(r.email, "faith@example.com");
    assert.equal((await me(api, id)).email, "faith@example.com");
  } finally { await api.close(); }
});

test("an address that could not be delivered to is refused, and nothing is stored", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057171");
    for (const bad of ["faith", "faith@", "@example.com", "a@b"]) {
      assert.equal((await req(api, "POST", MAIL, { token: mtok(id), body: { email: bad } })).status, 400, `"${bad}" was accepted`);
    }
    assert.equal((await me(api, id)).email, null);
  } finally { await api.close(); }
});

test("null clears it — the only way to stop statements reaching a lost inbox", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057172");
    await req(api, "POST", MAIL, { token: mtok(id), body: { email: "faith@example.com" } });
    const r = await json(await req(api, "POST", MAIL, { token: mtok(id), body: { email: null } }));
    assert.equal(r.email, null);
    assert.equal((await me(api, id)).email, null);
  } finally { await api.close(); }
});

test("the address is the marketer's own: nobody else can set it and nobody else sees it", async () => {
  const api = await startTestApi();
  try {
    const a = await marketer(api, "Faith Mutiso", "0748057173");
    const b = await marketer(api, "Tony Angwa", "0722500001");
    await req(api, "POST", MAIL, { token: mtok(a), body: { email: "faith@example.com" } });

    // There is no id in the route at all, so B's token sets B's address, never A's.
    await req(api, "POST", MAIL, { token: mtok(b), body: { email: "tony@example.com" } });
    assert.equal((await me(api, a)).email, "faith@example.com");
    assert.equal((await me(api, b)).email, "tony@example.com");

    assert.equal((await req(api, "POST", MAIL, { body: { email: "x@example.com" } })).status, 401);
    assert.equal((await req(api, "POST", MAIL, { token: "u-player:player", body: { email: "x@example.com" } })).status, 403);
  } finally { await api.close(); }
});

test("the stored address is what a statement is emailed to, and a body address overrides it", async () => {
  const sent: Array<{ to: string[] }> = [];
  const api = await startTestApi({ depsOverrides: { email: { send: async (m: any) => { sent.push(m); return { ok: true }; } } } });
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057174", 50_000);
    // With nothing on file and nothing in the body, it says so rather than guessing.
    const none = await req(api, "POST", "/api/v1/marketers/me/statement/email", { token: mtok(id), body: { from: d(-2), to: d(2) } });
    assert.equal(none.status, 400);
    assert.equal((await json(none)).error.code, "NO_EMAIL_ON_FILE");

    await req(api, "POST", MAIL, { token: mtok(id), body: { email: "faith@example.com" } });
    await req(api, "POST", "/api/v1/marketers/me/statement/email", { token: mtok(id), body: { from: d(-2), to: d(2) } });
    assert.deepEqual(sent[0]!.to, ["faith@example.com"], "the address on file was not used");

    await req(api, "POST", "/api/v1/marketers/me/statement/email",
      { token: mtok(id), body: { from: d(-2), to: d(2), email: "accounts@example.com" } });
    assert.deepEqual(sent[1]!.to, ["accounts@example.com"], "a one-off address did not override the stored one");
    // …and overriding does not overwrite what is on file.
    assert.equal((await me(api, id)).email, "faith@example.com");
  } finally { await api.close(); }
});

// ── Airtime ───────────────────────────────────────────────────────────────────────────────────────

test("buying airtime moves money between the two buckets of one wallet", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057175", 50_000);
    const r = await json(await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 10_000, ref: newRef() } }));

    assert.equal(r.balanceCents, 40_000);
    assert.equal(r.airtimeBalanceCents, 10_000);
    assert.equal(r.idempotent, false);
    assert.match(r.code, /^[A-Z0-9]{10}$/);
    assert.equal(r.code, mpesaCode(r.createdAtMs, r.ledgerId));

    const p = await me(api, id);
    assert.equal(p.balance_cents, 40_000);
    assert.equal(p.airtime_balance_cents, 10_000);
    // Nothing was created or destroyed: the wallet still holds 50,000 across its two buckets.
    assert.equal(p.balance_cents + p.airtime_balance_cents, 50_000);
  } finally { await api.close(); }
});

test("a retried purchase buys exactly once", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057176", 50_000);
    const ref = newRef();
    const a = await json(await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 10_000, ref } }));
    const b = await json(await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 10_000, ref } }));
    assert.equal(a.idempotent, false);
    assert.equal(b.idempotent, true);
    assert.equal(b.ledgerId, a.ledgerId);
    assert.equal(b.createdAtMs, a.createdAtMs, "a replay reported a time the purchase did not happen");
    const p = await me(api, id);
    assert.equal(p.balance_cents, 40_000);
    assert.equal(p.airtime_balance_cents, 10_000);
  } finally { await api.close(); }
});

test("FULIZA CANNOT BUY AIRTIME, although it funds a withdrawal", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057177", 5_000);
    await req(api, "PATCH", `/api/v1/admin/marketers/${id}/fuliza`, { token: ADMIN_A, body: { amountCents: 30_000 } });

    // 10,000 is affordable only with the overdraft. This overdraft is never repaid, so spending it
    // here would mint airtime no operator granted (0207 header).
    const r = await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 10_000, ref: newRef() } });
    // 409, the established code for "the money is not there" across these routes (see the transfer suite).
    assert.equal(r.status, 409);
    assert.match((await json(r)).error.code, /INSUFFICIENT_FUNDS/);

    const p = await me(api, id);
    assert.equal(p.balance_cents, 5_000, "a refused purchase moved money");
    assert.equal(p.airtime_balance_cents, 0);

    // …while a WITHDRAWAL still spends it, unchanged by 0207.
    const w = await req(api, "POST", `/api/v1/admin/marketers/${id}/withdraw`, { token: ADMIN_A, body: { amountCents: 10_000, ref: newRef() } });
    assert.equal(w.status, 200);
  } finally { await api.close(); }
});

test("refuses more than the balance, below the minimum, and a missing ref", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057178", 1_000);
    const over = await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 5_000, ref: newRef() } });
    assert.equal(over.status, 409);
    assert.match((await json(over)).error.code, /INSUFFICIENT_FUNDS/);

    // KES 5 floor: a sub-shilling top-up is a loop writing ledger rows, not a person buying credit.
    const tiny = await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 100, ref: newRef() } });
    assert.ok(tiny.status === 400 || tiny.status === 409, `unexpected ${tiny.status}`);
    assert.match((await json(tiny)).error.code, /AMOUNT_BELOW_MINIMUM/);

    assert.equal((await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 500 } })).status, 400);
    assert.equal((await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 500, ref: "short" } })).status, 400);
    assert.equal((await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: -500, ref: newRef() } })).status, 400);

    assert.equal((await me(api, id)).balance_cents, 1_000, "a refusal moved money");
  } finally { await api.close(); }
});

test("the target number is MASKED before it is stored, and never appears in full", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057179", 50_000);
    await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 10_000, ref: newRef(), phone: "0798661090" } });

    const s = await json(await req(api, "GET", STMT, { token: mtok(id) }));
    const row = s.detail.find((r: any) => r.entryType === "airtime");
    assert.ok(row, "the purchase is missing from the statement");
    assert.match(row.details, /^Airtime Purchase for - /);
    assert.ok(row.details.includes("*"), `expected a masked number, got ${row.details}`);
    // docs/58: the ledger stores no full counterparty number anywhere, and this is no exception.
    assert.ok(!JSON.stringify(s).includes("0798661090"), "the full target number reached the statement");

    const feed = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(id) }))).items;
    assert.ok(!JSON.stringify(feed).includes("0798661090"), "the full target number reached the feed");
  } finally { await api.close(); }
});

test("airtime for the marketer's own line says so plainly", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057180", 50_000);
    await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 10_000, ref: newRef() } });
    const s = await json(await req(api, "GET", STMT, { token: mtok(id) }));
    assert.equal(s.detail.find((r: any) => r.entryType === "airtime").details, "Airtime Purchase");
  } finally { await api.close(); }
});

test("the purchase lands in OTHERS, which is where a real statement counts airtime", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057181", 50_000);
    await req(api, "POST", AIR, { token: mtok(id), body: { amountCents: 10_000, ref: newRef() } });
    const s = await json(await req(api, "GET", STMT, { token: mtok(id) }));

    const others = s.summary.find((r: any) => r.type === "OTHERS");
    assert.equal(others.paidOutCents, 10_000);
    assert.equal(others.paidInCents, 0);
    // It is not a till, not a pay bill, and not a withdrawal at an agent.
    assert.equal(s.summary.find((r: any) => r.type === "AGENT WITHDRAWAL").paidOutCents, 0);
    assert.equal(s.summary.find((r: any) => r.type === "LIPA NA M-PESA (PAYBILL)").paidOutCents, 0);
    assert.equal(s.summary.find((r: any) => r.type === "LIPA NA M-PESA (BUY GOODS)").paidOutCents, 0);
    assert.equal(s.totalPaidOutCents, 10_000);

    // The running balance on the line is the cash balance — airtime is not part of it.
    const row = s.detail.find((r: any) => r.entryType === "airtime");
    assert.equal(row.withdrawnCents, 10_000);
    assert.equal(row.paidInCents, 0);
    assert.equal(row.balanceCents, 40_000);
  } finally { await api.close(); }
});

test("authorization: anonymous 401, player 403, admin 403", async () => {
  const api = await startTestApi();
  try {
    const id = await marketer(api, "Faith Mutiso", "0748057182", 50_000);
    const body = { amountCents: 1_000, ref: newRef() };
    assert.equal((await req(api, "POST", AIR, { body })).status, 401);
    assert.equal((await req(api, "POST", AIR, { token: "u-player:player", body })).status, 403);
    // An operator cannot spend a marketer's wallet on airtime; there is no route that would let them.
    assert.equal((await req(api, "POST", AIR, { token: ADMIN_A, body })).status, 403);
    assert.equal((await me(api, id)).balance_cents, 50_000);
  } finally { await api.close(); }
});
