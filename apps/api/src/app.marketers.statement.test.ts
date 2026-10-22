import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";
import {
  parseDay, eatDayStartMs, eatDayEndExclusiveMs, eatDayLabel, eatStamp,
  SUMMARY_ROWS, UNRECORDED_ROWS, statementQr, statementRef, isDeliverableEmail,
} from "./marketers.statement.js";

/**
 * GET /marketers/me/statement — the wallet statement the marketer app prints (docs/65).
 *
 * What is proven here is the ROUTE and the reading behind it: that the eight reference rows are
 * always present and always in order, that each ledger type lands in the bucket this system says it
 * should, that the period is an EAT day range inclusive at both ends, and that a bad date is
 * refused rather than rolled into the next month. The aggregate's behaviour at scale — the detail
 * cap biting while the summary stays complete — is proven against real Postgres in
 * packages/db/_testkit/e2e_marketer_statement.py, where rows can be backdated.
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
let n = 0;
const newRef = () => `ref-${Date.now()}-${++n}-aaaaaaaa`;

/** A wide range around today, so "now" always falls inside it. */
const d = (offsetDays: number): string => {
  const t = new Date(Date.now() + offsetDays * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};
const STMT = (from = d(-2), to = d(2)) => `/api/v1/marketers/me/statement?from=${from}&to=${to}`;

async function marketer(api: TestApi, name: string, phone: string, cents = 0): Promise<string> {
  const id = (await json(await req(api, "POST", "/api/v1/admin/marketers", { token: ADMIN_A, body: { name, phone } }))).id as string;
  if (cents) await req(api, "POST", `/api/v1/admin/marketers/${id}/credit`, { token: ADMIN_A, body: { amountCents: cents, ref: `seed-${id}` } });
  return id;
}
const rowOf = (s: any, type: string) => s.summary.find((r: any) => r.type === type);

// ── The document's shape ──────────────────────────────────────────────────────────────────────────

test("the eight reference rows are always present, always in that order", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057157");
    const s = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    assert.deepEqual(s.summary.map((r: any) => r.type), [...SUMMARY_ROWS]);
    // A marketer with no activity still gets a complete table, not an empty one.
    for (const r of s.summary) {
      assert.equal(r.paidInCents, 0);
      assert.equal(r.paidOutCents, 0);
    }
    assert.equal(s.txnCount, 0);
    assert.equal(s.truncated, false);
    assert.deepEqual(s.detail, []);
  } finally { await api.close(); }
});

test("the statement names the marketer and MASKS their number (docs/58)", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057158");
    const s = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    assert.equal(s.customerName, "Faith Mutiso");
    assert.ok(s.mobileNumber.includes("*"), `expected a masked number, got ${s.mobileNumber}`);
    assert.ok(!s.mobileNumber.includes("0748057158"), "the full number reached a marketer response");
    assert.match(s.ref, /^[A-Z0-9]{10}$/);
    assert.match(s.periodLabel, /^\d{2} [A-Z][a-z]{2} \d{4} - \d{2} [A-Z][a-z]{2} \d{4}$/);
  } finally { await api.close(); }
});

// ── The reading: which ledger entry is which M-PESA category ──────────────────────────────────────

test("a peer transfer is SEND MONEY on one statement and RECEIVED MONEY on the other", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722400001", 50_000);
    const them = await marketer(api, "Peter Muchendu", "0798661081", 0);
    await req(api, "POST", "/api/v1/marketers/me/transfer", { token: mtok(me), body: { phone: "0798661081", amountCents: 10_000, ref: newRef() } });

    const mine = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    const theirs = await json(await req(api, "GET", STMT(), { token: mtok(them) }));

    assert.equal(rowOf(mine, "SEND MONEY").paidOutCents, 10_000);
    assert.equal(rowOf(mine, "SEND MONEY").paidInCents, 0);
    assert.equal(rowOf(theirs, "RECEIVED MONEY").paidInCents, 10_000);
    assert.equal(rowOf(theirs, "RECEIVED MONEY").paidOutCents, 0);
    // The sender's seed credit is the one deposit on their statement.
    assert.equal(rowOf(mine, "AGENT DEPOSIT").paidInCents, 50_000);
    assert.equal(rowOf(theirs, "AGENT DEPOSIT").paidInCents, 0);
  } finally { await api.close(); }
});

test("game winnings are OTHERS, not an AGENT DEPOSIT — an agent did not deposit them", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722400002");
    await req(api, "POST", `/api/v1/admin/marketers/${me}/credit`,
      { token: ADMIN_A, body: { amountCents: 70_000, ref: newRef(), meta: { source: "game_withdrawal" } } });
    await req(api, "POST", `/api/v1/admin/marketers/${me}/credit`,
      { token: ADMIN_A, body: { amountCents: 5_000, ref: newRef() } });

    const s = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    assert.equal(rowOf(s, "OTHERS").paidInCents, 70_000, "a game withdrawal must not be filed as an agent deposit");
    assert.equal(rowOf(s, "AGENT DEPOSIT").paidInCents, 5_000);
    assert.equal(s.totalPaidInCents, 75_000);
    assert.equal(s.totalPaidOutCents, 0);
  } finally { await api.close(); }
});

test("a withdrawal is AGENT WITHDRAWAL, and the totals add the rows up", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722400003", 60_000);
    await req(api, "POST", `/api/v1/admin/marketers/${me}/withdraw`, { token: ADMIN_A, body: { amountCents: 20_000, ref: newRef() } });
    const s = await json(await req(api, "GET", STMT(), { token: mtok(me) }));

    assert.equal(rowOf(s, "AGENT WITHDRAWAL").paidOutCents, 20_000);
    const sumIn = s.summary.reduce((a: number, r: any) => a + r.paidInCents, 0);
    const sumOut = s.summary.reduce((a: number, r: any) => a + r.paidOutCents, 0);
    assert.equal(sumIn, s.totalPaidInCents, "the printed rows must add up to the printed total");
    assert.equal(sumOut, s.totalPaidOutCents);
  } finally { await api.close(); }
});

test("the two LIPA NA M-PESA rows are printed and are always zero — nothing records such a spend yet", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722400004", 90_000);
    await req(api, "POST", `/api/v1/admin/marketers/${me}/withdraw`, { token: ADMIN_A, body: { amountCents: 1_000, ref: newRef() } });
    const s = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    for (const type of UNRECORDED_ROWS) {
      const r = rowOf(s, type);
      assert.ok(r, `${type} must still be printed`);
      assert.equal(r.paidInCents, 0);
      assert.equal(r.paidOutCents, 0);
    }
  } finally { await api.close(); }
});

// ── The detail: "sent to who" ─────────────────────────────────────────────────────────────────────

test("the detail names the counterparty and carries the feed's own confirmation code", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722400005", 50_000);
    await marketer(api, "Peter Muchendu", "0798661082", 0);
    const t = await json(await req(api, "POST", "/api/v1/marketers/me/transfer",
      { token: mtok(me), body: { phone: "0798661082", amountCents: 10_000, ref: newRef() } }));

    const s = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    const send = s.detail.find((r: any) => r.entryType === "transfer_out");
    assert.ok(send, "the send is missing from the detail");
    assert.equal(send.details, "Customer Transfer to - PETER MUCHENDU");
    // One transaction, one code — the statement, the feed and the receipt all name it the same.
    assert.equal(send.code, t.code);
    assert.equal(send.withdrawnCents, 10_000);
    assert.equal(send.paidInCents, 0);
    assert.equal(send.balanceCents, 40_000);

    // docs/58: no counterparty number is stored, so none can be printed.
    assert.ok(!JSON.stringify(s).includes("0798661082"), "a counterparty number reached the statement");
  } finally { await api.close(); }
});

test("the detail reads newest-first, as the reference statement does", async () => {
  // 0208 ordered this ascending on the argument that a reader follows the Balance column downward.
  // The reference artifact settles it the other way: its first page opens on the most recent
  // transaction and walks backwards. A statement is read to see what happened lately, and on a long
  // one the alternative is paging to the end to find today. See docs/67 §4 and migration 0209.
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722400006", 90_000);
    await req(api, "POST", `/api/v1/admin/marketers/${me}/withdraw`, { token: ADMIN_A, body: { amountCents: 1_000, ref: newRef() } });
    await req(api, "POST", `/api/v1/admin/marketers/${me}/withdraw`, { token: ADMIN_A, body: { amountCents: 2_000, ref: newRef() } });
    const s = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    assert.equal(s.detail.length, 3);                       // the two withdrawals, then the seed credit
    assert.equal(s.detail[0].withdrawnCents, 2_000);
    assert.equal(s.detail[1].withdrawnCents, 1_000);
    assert.equal(s.detail[2].details, "Deposit of Funds");
    // The running balance is the ledger's, not recomputed here — so the NEWEST row carries the
    // latest balance, and reading upward from the bottom is what retraces how it got there.
    assert.equal(s.detail[0].balanceCents, 87_000);
  } finally { await api.close(); }
});

// ── Dates ─────────────────────────────────────────────────────────────────────────────────────────

test("a date that is not a real date is refused, not rolled into the next month", async () => {
  const api = await startTestApi();
  try {
    // Split across marketers because the statement budget is per-user and deliberately small —
    // see the 429 test below. Five asks each keeps every case under it.
    const a = await marketer(api, "Tony Angwa", "0722400007");
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "15/10/2026", "2026-2-1"]) {
      const r = await req(api, "GET", `/api/v1/marketers/me/statement?from=${encodeURIComponent(bad)}&to=2026-10-15`, { token: mtok(a) });
      assert.equal(r.status, 400, `"${bad}" was accepted`);
    }
    const b = await marketer(api, "Tony Angwa", "0722400017");
    for (const bad of ["", "yesterday"]) {
      const r = await req(api, "GET", `/api/v1/marketers/me/statement?from=${encodeURIComponent(bad)}&to=2026-10-15`, { token: mtok(b) });
      assert.equal(r.status, 400, `"${bad}" was accepted`);
    }
    // 29 February exists in 2028 and does not in 2026. A Date that silently rolls would make the
    // second of these a statement for 1 March — a period nobody asked for.
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/statement?from=2028-02-29&to=2028-03-01", { token: mtok(b) })).status, 200);
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/statement?from=2026-02-29&to=2026-03-01", { token: mtok(b) })).status, 400);
    // The same holds for the END date, which is parsed by the same function but bounded differently.
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/statement?from=2026-10-01&to=2026-09-31", { token: mtok(b) })).status, 400);
  } finally { await api.close(); }
});

test("the statement budget is per marketer, and a flood is refused rather than scanned", async () => {
  const api = await startTestApi();
  try {
    // A statement is an aggregate over a marketer's whole history; it is the one marketer-facing
    // read worth a tight budget. 6/min is generous for a person and useless for a loop.
    const me = await marketer(api, "Tony Angwa", "0722400018");
    const other = await marketer(api, "Peter Muchendu", "0798661084");
    let refused = 0;
    for (let i = 0; i < 9; i++) {
      const r = await req(api, "GET", STMT(), { token: mtok(me) });
      if (r.status === 429) refused++;
      await r.text();
    }
    assert.ok(refused > 0, "the statement route has no rate limit");
    // Per USER, not per IP: the test harness shares one address, and so does every marketer behind
    // a Kenyan carrier NAT. One marketer exhausting their budget must not lock out the next.
    assert.equal((await req(api, "GET", STMT(), { token: mtok(other) })).status, 200);
  } finally { await api.close(); }
});

test("the end date cannot precede the start, and the period is bounded", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722400008");
    const back = await req(api, "GET", "/api/v1/marketers/me/statement?from=2026-10-15&to=2026-10-14", { token: mtok(me) });
    assert.equal(back.status, 400);
    const huge = await req(api, "GET", "/api/v1/marketers/me/statement?from=2020-01-01&to=2026-10-15", { token: mtok(me) });
    assert.equal(huge.status, 400);
    assert.equal((await json(huge)).error.code, "PERIOD_TOO_LONG");
    // A single day is a legitimate statement.
    assert.equal((await req(api, "GET", "/api/v1/marketers/me/statement?from=2026-10-15&to=2026-10-15", { token: mtok(me) })).status, 200);
  } finally { await api.close(); }
});

test("the period is an EAT day range, inclusive at both ends", () => {
  const from = parseDay("2026-06-01")!;
  const to = parseDay("2026-10-15")!;
  // EAT is UTC+3, so an EAT day begins at 21:00 UTC the day before.
  assert.equal(new Date(eatDayStartMs(from)).toISOString(), "2026-05-31T21:00:00.000Z");
  // Inclusive of the END day means the boundary is the START of the next EAT day.
  assert.equal(new Date(eatDayEndExclusiveMs(to)).toISOString(), "2026-10-15T21:00:00.000Z");
  // A transaction at 23:30 EAT on the last day is INSIDE the range; a UTC-midnight bound would drop it.
  const lateOnTheLastDay = Date.parse("2026-10-15T20:30:00.000Z");   // 23:30 EAT
  assert.ok(lateOnTheLastDay < eatDayEndExclusiveMs(to));
  assert.ok(lateOnTheLastDay >= eatDayStartMs(from));
  assert.equal(eatDayLabel(from), "01 Jun 2026");
  assert.equal(eatDayLabel(to), "15 Oct 2026");
  assert.equal(eatStamp(Date.parse("2026-10-14T18:03:00.000Z")), "14 Oct 2026, 9:03 PM");
});

// ── The QR ────────────────────────────────────────────────────────────────────────────────────────

test("the QR is a square module matrix whose bits match its size", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057159", 50_000);
    const s = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    assert.ok(s.qr.size >= 21 && s.qr.size % 4 === 1, `not a QR version size: ${s.qr.size}`);
    assert.equal(s.qr.bits.length, s.qr.size * s.qr.size);
    assert.match(s.qr.bits, /^[01]+$/);
    // The three finder patterns: a 7x7 dark ring in each corner but the bottom-right.
    const at = (r: number, c: number) => s.qr.bits[r * s.qr.size + c];
    for (const [r0, c0] of [[0, 0], [0, s.qr.size - 7], [s.qr.size - 7, 0]]) {
      assert.equal(at(r0!, c0!), "1");
      assert.equal(at(r0! + 1, c0! + 1), "0");
      assert.equal(at(r0! + 3, c0! + 3), "1");
    }
  } finally { await api.close(); }
});

test("the QR encodes the page, so two different statements never carry the same one", () => {
  const base = { mobileNumber: "0748****157", periodLabel: "01 Jun 2026 - 15 Oct 2026", totalPaidInCents: 1000, totalPaidOutCents: 0, txnCount: 1 };
  const a = statementQr({ ...base, ref: "UJEJ0ANPDS" });
  const b = statementQr({ ...base, ref: "UJEJ0ANPDT" });
  assert.notEqual(a.bits, b.bits);
  const c = statementQr({ ...base, ref: "UJEJ0ANPDS", txnCount: 2 });
  assert.notEqual(a.bits, c.bits, "the totals must be inside the code, not decoration beside it");
  // Same inputs, same code: a reprint of one statement is not a different statement.
  assert.equal(a.bits, statementQr({ ...base, ref: "UJEJ0ANPDS" }).bits);
});

test("a statement reference is stable for one request and differs between them", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const at = Date.parse("2026-10-15T09:00:00.000Z");
  assert.equal(statementRef(id, "2026-06-01", "2026-10-15", at), statementRef(id, "2026-06-01", "2026-10-15", at));
  assert.notEqual(statementRef(id, "2026-06-01", "2026-10-15", at), statementRef(id, "2026-06-02", "2026-10-15", at));
  assert.notEqual(statementRef(id, "2026-06-01", "2026-10-15", at), statementRef(id, "2026-06-01", "2026-10-15", at + 1000));
  assert.match(statementRef(id, "2026-06-01", "2026-10-15", at), /^[A-Z0-9]{10}$/);
});

// ── Who may ask ───────────────────────────────────────────────────────────────────────────────────

test("authorization: anonymous 401, player 403, and one marketer cannot read another's", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Tony Angwa", "0722400009", 50_000);
    const other = await marketer(api, "Peter Muchendu", "0798661083", 70_000);
    assert.equal((await req(api, "GET", STMT())).status, 401);
    assert.equal((await req(api, "GET", STMT(), { token: "u-player:player" })).status, 403);

    // There is no id in the route at all — the statement is always the token's own. Asking with
    // another marketer's token returns THAT marketer's statement, never this one's.
    const mine = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    const theirs = await json(await req(api, "GET", STMT(), { token: mtok(other) }));
    assert.equal(mine.customerName, "Tony Angwa");
    assert.equal(theirs.customerName, "Peter Muchendu");
    assert.equal(rowOf(mine, "AGENT DEPOSIT").paidInCents, 50_000);
    assert.equal(rowOf(theirs, "AGENT DEPOSIT").paidInCents, 70_000);
  } finally { await api.close(); }
});

// ── Emailing it ───────────────────────────────────────────────────────────────────────────────────

type SentMail = { to: string[]; subject: string; html: string; text: string };
function fakeMailer(): { sent: SentMail[]; send: (m: SentMail) => Promise<{ ok: boolean }> } {
  const sent: SentMail[] = [];
  return { sent, send: async (m: SentMail) => { sent.push(m); return { ok: true }; } };
}

test("without a configured sender it SAYS so, rather than reporting a delivery nobody got", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057160", 50_000);
    const r = await req(api, "POST", "/api/v1/marketers/me/statement/email",
      { token: mtok(me), body: { from: d(-2), to: d(2), email: "faith@example.com" } });
    assert.equal(r.status, 503);
    assert.equal((await json(r)).error.code, "EMAIL_NOT_CONFIGURED");
  } finally { await api.close(); }
});

test("the emailed statement carries the same figures as the shown one", async () => {
  const mailer = fakeMailer();
  const api = await startTestApi({ depsOverrides: { email: mailer } });
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057161", 50_000);
    await marketer(api, "Peter Muchendu", "0798661085", 0);
    await req(api, "POST", "/api/v1/marketers/me/transfer",
      { token: mtok(me), body: { phone: "0798661085", amountCents: 10_000, ref: newRef() } });

    const shown = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    const r = await json(await req(api, "POST", "/api/v1/marketers/me/statement/email",
      { token: mtok(me), body: { from: d(-2), to: d(2), email: "faith@example.com" } }));

    assert.equal(r.sent, true);
    assert.equal(r.txnCount, shown.txnCount);
    assert.equal(mailer.sent.length, 1);
    const mail = mailer.sent[0]!;
    assert.deepEqual(mail.to, ["faith@example.com"]);
    assert.match(mail.subject, /M-PESA statement/);
    // The figures, not a promise of them.
    assert.match(mail.text, /SEND MONEY: 0\.00 \/ 100\.00/);
    assert.match(mail.text, /Customer Transfer to - PETER MUCHENDU/);
    assert.match(mail.html, /Customer Transfer to - PETER MUCHENDU/);
    assert.match(mail.html, /M-PESA STATEMENT/);
    // docs/58 again: the emailed copy travels furthest of all, so it masks hardest.
    assert.ok(!mail.html.includes("0748057161"), "the marketer's own number went out unmasked");
    assert.ok(!mail.html.includes("0798661085"), "a counterparty number went out in an email");
  } finally { await api.close(); }
});

test("the email route does not echo the statement — it is not a second way to read one", async () => {
  const mailer = fakeMailer();
  const api = await startTestApi({ depsOverrides: { email: mailer } });
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057162", 50_000);
    const r = await json(await req(api, "POST", "/api/v1/marketers/me/statement/email",
      { token: mtok(me), body: { from: d(-2), to: d(2), email: "faith@example.com" } }));
    assert.equal(r.summary, undefined);
    assert.equal(r.detail, undefined);
    assert.equal(r.qr, undefined);
  } finally { await api.close(); }
});

test("what counts as a deliverable address", () => {
  // The table is checked against the pure function rather than the route, because the email route's
  // budget is 3/min and a table of a dozen cases would be testing the rate limiter instead.
  for (const ok of ["faith@example.com", "f.m+stmt@sub.example.co.ke", "a@b.co", "x_y-z@mail.example.org"]) {
    assert.ok(isDeliverableEmail(ok), `${ok} should be deliverable`);
  }
  for (const bad of ["faith", "faith@", "@example.com", "faith example.com", "a@b", "a@b.", "a@-b.co",
                     "a@b..co", "two@addresses.com,one@more.com", "with;semi@colon.com", "", " "]) {
    assert.ok(!isDeliverableEmail(bad), `${bad} should be refused`);
  }
  assert.ok(!isDeliverableEmail("a".repeat(250) + "@example.com"), "an absurd length should be refused");
});

test("an undeliverable address is refused before anything is built or sent", async () => {
  const mailer = fakeMailer();
  const api = await startTestApi({ depsOverrides: { email: mailer } });
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057163");
    assert.equal((await req(api, "POST", "/api/v1/marketers/me/statement/email",
      { token: mtok(me), body: { from: d(-2), to: d(2), email: "faith example.com" } })).status, 400);
    assert.equal((await req(api, "POST", "/api/v1/marketers/me/statement/email",
      { token: mtok(me), body: { from: d(-2), to: d(2) } })).status, 400);   // none at all
    assert.equal(mailer.sent.length, 0, "a refused address still produced a send");
  } finally { await api.close(); }
});

test("a counterparty name containing markup cannot inject into the emailed HTML", async () => {
  const mailer = fakeMailer();
  const api = await startTestApi({ depsOverrides: { email: mailer } });
  try {
    // The name reaches the ledger from a registration form; it is the one field on this page that
    // is not the server's own arithmetic.
    const me = await marketer(api, "Faith Mutiso", "0748057164", 50_000);
    await marketer(api, "<script>alert(1)</script>", "0798661086", 0);
    await req(api, "POST", "/api/v1/marketers/me/transfer",
      { token: mtok(me), body: { phone: "0798661086", amountCents: 10_000, ref: newRef() } });
    await req(api, "POST", "/api/v1/marketers/me/statement/email",
      { token: mtok(me), body: { from: d(-2), to: d(2), email: "faith@example.com" } });

    const mail = mailer.sent[0]!;
    assert.ok(!mail.html.includes("<script>"), "an unescaped tag reached the emailed HTML");
    assert.ok(mail.html.includes("&lt;SCRIPT&gt;"), "the name should be present, escaped");
  } finally { await api.close(); }
});

test("the email carries the statement as a PDF attachment, and the body is a preview of it", async () => {
  const mailer = fakeMailer();
  const api = await startTestApi({ depsOverrides: { email: mailer } });
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057165", 50_000);
    await req(api, "POST", "/api/v1/marketers/me/email", { token: mtok(me), body: { email: "faith@example.com" } });
    await req(api, "POST", "/api/v1/marketers/me/statement/email", { token: mtok(me), body: { from: d(-2), to: d(2) } });

    const mail = mailer.sent[0]! as any;
    assert.equal(mail.attachments?.length, 1, "no PDF was attached");
    const att = mail.attachments[0];
    assert.match(att.filename, /^M-PESA-Statement-[A-Z0-9]{10}\.pdf$/);
    const pdf = Buffer.from(att.content, "base64");
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(pdf.length > 3_000, `attachment is only ${pdf.length} bytes`);

    // The body says the attachment is the deliverable rather than leaving it to be noticed.
    assert.match(mail.text, /attached as a PDF/);
    assert.match(mail.html, /attached as a PDF/);
    // Both halves name the address the statement is on file against.
    assert.match(mail.text, /Email Address: faith@example\.com/);
  } finally { await api.close(); }
});

test("the statement reports an address and a status for every row", async () => {
  const api = await startTestApi();
  try {
    const me = await marketer(api, "Faith Mutiso", "0748057166", 50_000);
    const before = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    assert.equal(before.emailAddress, null, "no address is on file yet");

    await req(api, "POST", "/api/v1/marketers/me/email", { token: mtok(me), body: { email: "faith@example.com" } });
    const after = await json(await req(api, "GET", STMT(), { token: mtok(me) }));
    assert.equal(after.emailAddress, "faith@example.com");
    // Every row settled, because the ledger records nothing else.
    assert.ok(after.detail.length > 0);
    for (const r of after.detail) assert.equal(r.status, "Completed");
  } finally { await api.close(); }
});

test("the statement carries the stamp's two dates, formatted by the SERVER", async () => {
  const api = await startTestApi();
  try {
    // Both strings exist so the in-app page and the emailed PDF print the same stamp. Deriving
    // them in two places is how a mirror quietly stops agreeing with the thing it mirrors (#147).
    const me = await marketer(api, "Faith Mutiso", "0748057167", 50_000);
    const s = await json(await req(api, "GET", STMT("2026-06-01", "2026-10-15"), { token: mtok(me) }));
    assert.equal(s.periodLabel, "01 Jun 2026 - 15 Oct 2026");
    assert.equal(s.periodOrdinal, "1st Jun 2026 - 15th Oct 2026");
    assert.match(s.approvalDate, /^\d{1,2}(st|nd|rd|th) [A-Z][a-z]+ \d{4}$/);
  } finally { await api.close(); }
});
