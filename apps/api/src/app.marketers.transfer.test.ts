import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";
import { mpesaCode } from "./mpesa.js";

/**
 * POST /marketers/me/transfer — one marketer sending funny money to another (docs/63, BUGLOG #140).
 *
 * The RPC's own guarantees (atomicity, row locks, deadlock order, concurrent idempotency) are
 * proven against real Postgres in packages/db/_testkit/e2e_marketer_transfer.py. What is proven
 * HERE is the route: that the sender cannot be forged, that the recipient is resolved inside the
 * sender's own brand, that a ref is compulsory, and that every refusal reaches the app as something
 * it can act on.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const XFER = "/api/v1/marketers/me/transfer";
const SITE_A = "00000000-0000-0000-0000-000000000001";
const SITE_B = "00000000-0000-0000-0000-0000000000b2";
const ADMIN_A = `u-admin:admin:${SITE_A}`;
const PLATFORM = "u-plat:platform_admin";
const mtok = (id: string) => `${id}:marketer`;
let n = 0;
const newRef = () => `ref-${Date.now()}-${++n}-aaaaaaaa`;

async function marketer(api: TestApi, name: string, phone: string, cents = 0, token = ADMIN_A): Promise<string> {
  const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token, body: { name, phone } }))).id as string;
  if (cents) await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN_A, body: { amountCents: cents, ref: `seed-${id}` } });
  return id;
}
const balanceOf = async (api: TestApi, id: string): Promise<number> =>
  (await json(await req(api, "GET", "/api/v1/marketers/me", { token: mtok(id) }))).balance_cents as number;

test("sends: the money moves, and the receipt names who the SERVER paid", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300001", 50_000);
    const them = await marketer(api, "Peter Muchendu", "0798661061", 10_000);
    const r = await json(await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661061", amountCents: 10_000, ref: newRef() } }));
    assert.equal(r.sentCents, 10_000);
    assert.equal(r.balanceCents, 40_000, "the sender's own new balance comes back for the receipt");
    // Taken from the row the RPC actually credited, never echoed from the request.
    assert.equal(r.recipientName, "Peter Muchendu");
    assert.equal(await balanceOf(api, me), 40_000);
    assert.equal(await balanceOf(api, them), 20_000);
  } finally { await api.close(); }
});

test("the sender is the token, not the body — a forged `from` is ignored", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300002", 50_000);
    const victim = await marketer(api, "Rich Rep", "0722300003", 900_000);
    const them = await marketer(api, "Peter Muchendu", "0798661062", 0);
    await req(api, "POST", XFER, {
      token: mtok(me),
      body: { phone: "0798661062", amountCents: 10_000, ref: newRef(), from: victim, fromMarketerId: victim, marketerId: victim },
    });
    assert.equal(await balanceOf(api, victim), 900_000, "the named victim was not debited");
    assert.equal(await balanceOf(api, me), 40_000, "the authenticated sender was");
  } finally { await api.close(); }
});

test("a retried send with the same ref moves money exactly once", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300004", 50_000);
    const them = await marketer(api, "Peter Muchendu", "0798661063", 0);
    const ref = newRef();
    const a = await json(await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661063", amountCents: 10_000, ref } }));
    const b = await json(await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661063", amountCents: 10_000, ref } }));
    assert.equal(a.idempotent, false);
    assert.equal(b.idempotent, true, "the replay says so, so the app can tell a retry from a second send");
    assert.equal(await balanceOf(api, me), 40_000);
    assert.equal(await balanceOf(api, them), 10_000);
  } finally { await api.close(); }
});

test("a ref is compulsory and must be substantial", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300005", 50_000);
    await marketer(api, "Peter Muchendu", "0798661064", 0);
    // Idempotency the client may omit is idempotency the client WILL omit.
    for (const bad of [undefined, "", "short", "x".repeat(81)]) {
      const body: Record<string, unknown> = { phone: "0798661064", amountCents: 1_000 };
      if (bad !== undefined) body.ref = bad;
      const res = await req(api, "POST", XFER, { token: mtok(me), body });
      assert.ok(res.status === 400, `expected 400 for ref=${JSON.stringify(bad)}, got ${res.status}`);
      await res.text();
    }
    assert.equal(await balanceOf(api, me), 50_000, "none of those moved anything");
  } finally { await api.close(); }
});

test("refuses to send to yourself", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300006", 50_000);
    const res = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0722300006", amountCents: 1_000, ref: newRef() } });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "TRANSFER_TO_SELF");
    assert.equal(await balanceOf(api, me), 50_000);
  } finally { await api.close(); }
});

test("refuses more than the balance, and says which", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300007", 5_000);
    await marketer(api, "Peter Muchendu", "0798661065", 0);
    const res = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661065", amountCents: 50_000, ref: newRef() } });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).error.code, "INSUFFICIENT_FUNDS");
    assert.equal(await balanceOf(api, me), 5_000);
  } finally { await api.close(); }
});

test("Fuliza cannot fund a transfer, although it funds a withdrawal", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300008", 1_000);
    await req(api, "PATCH", `/api/v1/admin/marketers/${me}/fuliza`, { token: ADMIN_A, body: { amountCents: 30_000 } });
    await marketer(api, "Peter Muchendu", "0798661066", 0);
    // The overdraft is granted by an operator and repaid by nobody; spending it INTO another live
    // wallet would mint funny money nobody granted. See migration 0203's header.
    const res = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661066", amountCents: 5_000, ref: newRef() } });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).error.code, "INSUFFICIENT_FUNDS");
    assert.equal(await balanceOf(api, me), 1_000);
  } finally { await api.close(); }
});

test("another brand's marketer is unreachable, with the lookup's own words", async () => {
  const api = await startTestApi();
  try {
    (api.deps.marketers as any)._setBrandName(SITE_B, "Madolar");
    const me = await marketer(api, "Tony Angwa", "0722300009", 50_000);
    await json(await req(api, "POST", "/api/v1/admin/marketers",
      { token: PLATFORM, body: { name: "Other Brand Rep", phone: "0733300002", site: SITE_B } }));
    const cross = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0733300002", amountCents: 1_000, ref: newRef() } });
    const ghost = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0711999998", amountCents: 1_000, ref: newRef() } });
    assert.equal(cross.status, 404);
    assert.equal(ghost.status, 404);
    assert.equal((await json(cross)).error.code, (await json(ghost)).error.code,
      "a cross-brand send and a send to nobody must be indistinguishable");
    assert.equal(await balanceOf(api, me), 50_000);
  } finally { await api.close(); }
});

test("a suspended recipient cannot be paid; a suspended sender cannot pay", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300010", 50_000);
    const them = await marketer(api, "Peter Muchendu", "0798661067", 0);
    await req(api, "PATCH", `/api/v1/admin/marketers/${them}/status`, { token: ADMIN_A, body: { status: "suspended" } });
    const toOff = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661067", amountCents: 1_000, ref: newRef() } });
    assert.equal(toOff.status, 404, "money must not land in a wallet that is switched off");
    await toOff.text();

    await req(api, "PATCH", `/api/v1/admin/marketers/${me}/status`, { token: ADMIN_A, body: { status: "suspended" } });
    const fromOff = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661067", amountCents: 1_000, ref: newRef() } });
    assert.equal(fromOff.status, 403, "a switched-off marketer loses the route entirely");
    await fromOff.text();
  } finally { await api.close(); }
});

test("the daily cap holds, and is per sender", async () => {
  const api = await startTestApi();
  try {
    process.env.MARKETER_TRANSFER_DAILY_CAP_CENTS = "20000";
    const api2 = await startTestApi();
    try {
      const me = await marketer(api2, "Tony Angwa", "0722300011", 100_000);
      const other = await marketer(api2, "Second Sender", "0722300012", 100_000);
      const them = await marketer(api2, "Peter Muchendu", "0798661068", 0);
      await req(api2, "POST", XFER, { token: mtok(me), body: { phone: "0798661068", amountCents: 15_000, ref: newRef() } });
      const over = await req(api2, "POST", XFER, { token: mtok(me), body: { phone: "0798661068", amountCents: 10_000, ref: newRef() } });
      assert.equal(over.status, 409);
      assert.equal((await json(over)).error.code, "TRANSFER_DAILY_CAP");
      // Not a shared pot: the next marketer has their own allowance.
      const fresh = await req(api2, "POST", XFER, { token: mtok(other), body: { phone: "0798661068", amountCents: 15_000, ref: newRef() } });
      assert.equal(fresh.status, 200, "another sender has their own budget");
      await fresh.text();
    } finally { await api2.close(); }
  } finally {
    delete process.env.MARKETER_TRANSFER_DAILY_CAP_CENTS;
    await api.close();
  }
});

test("authorization: anonymous 401, player 403, admin 403", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300013", 50_000);
    await marketer(api, "Peter Muchendu", "0798661069", 0);
    const body = { phone: "0798661069", amountCents: 1_000, ref: newRef() };
    assert.equal((await req(api, "POST", XFER, { body })).status, 401);
    assert.equal((await req(api, "POST", XFER, { token: "u-player:player", body })).status, 403);
    assert.equal((await req(api, "POST", XFER, { token: ADMIN_A, body })).status, 403,
      "an admin has their own credit route; this one is the marketer's");
    assert.equal(await balanceOf(api, me), 50_000);
  } finally { await api.close(); }
});

test("a malformed amount is refused before anything moves", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300014", 50_000);
    await marketer(api, "Peter Muchendu", "0798661070", 0);
    for (const amt of [0, -500, 1.5, "abc", null]) {
      const res = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661070", amountCents: amt, ref: newRef() } });
      assert.ok(res.status === 400, `expected 400 for amountCents=${JSON.stringify(amt)}, got ${res.status}`);
      await res.text();
    }
    // Sub-shilling dust is a loop writing ledger rows, not a payment.
    const dust = await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661070", amountCents: 1, ref: newRef() } });
    assert.equal(dust.status, 400);
    assert.equal((await json(dust)).error.code, "AMOUNT_BELOW_MINIMUM");
    assert.equal(await balanceOf(api, me), 50_000);
  } finally { await api.close(); }
});

test("both wallets' statements tell the same story, from each side", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300015", 50_000);
    const them = await marketer(api, "Peter Muchendu", "0798661071", 0);
    await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661071", amountCents: 10_000, ref: newRef(), chargeCents: 1_100 } });

    const mine = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(me) }))).items;
    const theirs = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(them) }))).items;
    const out = mine.find((t: any) => t.entryType === "transfer_out");
    const inn = theirs.find((t: any) => t.entryType === "transfer_in");

    assert.ok(out, "the sender's feed carries the send");
    assert.ok(inn, "the recipient's feed carries the receipt");
    assert.equal(out.direction, "out");
    assert.equal(inn.direction, "in");
    // The counterparty's NAME is what the M-PESA confirmation reads, so each side names the other.
    assert.equal(out.mpesa.party, "PETER MUCHENDU");
    assert.equal(inn.mpesa.party, "TONY ANGWA");
    assert.match(out.mpesa.message, /sent to PETER MUCHENDU/);
    assert.match(inn.mpesa.message, /received Ksh10\.00 from TONY ANGWA|received .* from TONY ANGWA/);
    // docs/58: neither feed may carry the other party's number.
    const raw = JSON.stringify({ mine, theirs });
    assert.ok(!raw.includes("0798661071"), "the recipient's number leaked into a feed");
    assert.ok(!raw.includes("0722300015"), "the sender's number leaked into a feed");
  } finally { await api.close(); }
});

// ── The receipt (0205) ────────────────────────────────────────────────────────────────────────────
//
// The app prints a confirmation screen and a downloadable M-PESA receipt from this response. Both
// carry an ID and a timestamp, and the only acceptable source for either is the server: a handset
// clock can be wrong or set deliberately, and a client-side code generator would mint a second name
// for a transfer that already has one. These prove the two fields are the database's answer and
// that they survive the retry that is the whole reason idempotency exists.

test("the response carries a receipt: a server timestamp and a code derived from it", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300016", 50_000);
    await marketer(api, "Peter Muchendu", "0798661072", 0);
    const before = Date.now();
    const r = await json(await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661072", amountCents: 10_000, ref: newRef() } }));
    const after = Date.now();

    assert.equal(typeof r.createdAtMs, "number");
    assert.ok(r.createdAtMs >= before - 1000 && r.createdAtMs <= after + 1000,
      `createdAtMs ${r.createdAtMs} is not the commit time of this transfer`);
    // Safaricom's shape: 10 characters, uppercase letters and digits only.
    assert.match(r.code, /^[A-Z0-9]{10}$/);
    assert.equal(r.code, mpesaCode(r.createdAtMs, r.ledgerId),
      "the code must be a function of the commit time and the out-ledger id, not a random string");
  } finally { await api.close(); }
});

test("a replay reprints the ORIGINAL receipt — same code, same time, not today's", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300017", 50_000);
    await marketer(api, "Peter Muchendu", "0798661073", 0);
    const ref = newRef();
    const a = await json(await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661073", amountCents: 10_000, ref } }));
    // Long enough that a fresh clock reading would differ: this is the assertion's whole point.
    await new Promise((res) => setTimeout(res, 30));
    const b = await json(await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661073", amountCents: 10_000, ref } }));

    assert.equal(b.idempotent, true);
    assert.equal(b.createdAtMs, a.createdAtMs, "the replay printed a time the money did not move");
    assert.equal(b.code, a.code, "one transfer, one confirmation code");
    assert.equal(b.ledgerId, a.ledgerId);
  } finally { await api.close(); }
});

test("the code on the receipt is the code in the sender's own statement", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300018", 50_000);
    await marketer(api, "Peter Muchendu", "0798661074", 0);
    const r = await json(await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661074", amountCents: 10_000, ref: newRef() } }));

    const mine = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(me) }))).items;
    const out = mine.find((t: any) => t.entryType === "transfer_out");
    assert.ok(out);
    // A receipt whose ID cannot be found in the statement is a receipt nobody can act on.
    assert.equal(out.mpesa.code, r.code);
    assert.equal(out.id, r.ledgerId);
  } finally { await api.close(); }
});

test("both sides of one transfer carry ONE confirmation code", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722300019", 50_000);
    const them = await marketer(api, "Peter Muchendu", "0798661075", 0);
    const r = await json(await req(api, "POST", XFER, { token: mtok(me), body: { phone: "0798661075", amountCents: 10_000, ref: newRef() } }));

    const mine = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(me) }))).items;
    const theirs = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(them) }))).items;
    const out = mine.find((t: any) => t.entryType === "transfer_out");
    const inn = theirs.find((t: any) => t.entryType === "transfer_in");
    assert.ok(out && inn);

    // Real M-PESA gives the payer and the payee the same code. Before 0205 each side derived one
    // from its own ledger id, so two marketers comparing phones saw two codes for one transfer.
    assert.equal(inn.mpesa.code, out.mpesa.code, "the two halves of one transfer disagree on its code");
    assert.equal(inn.mpesa.code, r.code);
    // Both messages must quote the code they are stamped with, or the SMS and the receipt diverge.
    assert.ok(out.mpesa.message.startsWith(r.code));
    assert.ok(inn.mpesa.message.startsWith(r.code));
    // Identical timestamps: in Postgres both rows take created_at from the same transaction's now().
    assert.equal(inn.createdAtMs, out.createdAtMs);
  } finally { await api.close(); }
});

test("a credit that is not a transfer still takes its code from its own row", async () => {
  const api = await startTestApi();
  try {
    // The pairing is read from meta.pair_ledger_id. Rows that have none — every credit and
    // withdrawal, and every transfer written before 0205 — must keep their existing code.
    const me = await marketer(api, "Tony Angwa", "0722300020", 50_000);
    const mine = (await json(await req(api, "GET", "/api/v1/marketers/me/transactions", { token: mtok(me) }))).items;
    const credit = mine.find((t: any) => t.entryType === "credit");
    assert.ok(credit);
    assert.equal(credit.mpesa.code, mpesaCode(credit.createdAtMs, credit.id));
  } finally { await api.close(); }
});
