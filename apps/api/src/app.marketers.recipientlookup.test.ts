import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";

/**
 * POST /marketers/recipients/lookup — "who is this number?" for the marketer app's Send Money screen.
 *
 * The screen exists so a marketer who has run out of funny money can be sent some by a colleague
 * instead of waiting on an admin, and this route is the only thing that stops the send going to a
 * typo. It is also a name oracle keyed on a phone number, so most of what is asserted below is what
 * it REFUSES to say.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const LOOKUP = "/api/v1/marketers/recipients/lookup";
const SITE_A = "00000000-0000-0000-0000-000000000001";   // the default brand
const SITE_B = "00000000-0000-0000-0000-0000000000b2";
const ADMIN_A = `u-admin:admin:${SITE_A}`;
const PLATFORM = "u-plat:platform_admin";
const mtok = (id: string) => `${id}:marketer`;

async function newMarketer(api: TestApi, name: string, phone: string, token = ADMIN_A): Promise<string> {
  const r = await json(await req(api, "POST", "/api/v1/admin/marketers", { token, body: { name, phone } }));
  assert.ok(r.id, `marketer not created: ${JSON.stringify(r)}`);
  return r.id as string;
}

test("resolves a fellow marketer's registered name from the database", async () => {
  const api = await startTestApi();
  try {
    const me = await newMarketer(api, "Tony Angwa", "0722200001");
    await newMarketer(api, "Peter Muchendu", "0798661061");
    const r = await json(await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: "0798661061" } }));
    assert.equal(r.name, "Peter Muchendu", "the name comes from the marketers row, not the client");
    assert.equal(r.self, false);
  } finally { await api.close(); }
});

test("accepts every format a human types: 07.., 7.., 254.., +254.., spaced, dashed", async () => {
  const api = await startTestApi();
  try {
    const me = await newMarketer(api, "Tony Angwa", "0722200002");
    await newMarketer(api, "Peter Muchendu", "0798661061");
    for (const typed of ["0798661061", "798661061", "254798661061", "+254798661061", "0798 661 061", "0798-661-061"]) {
      const res = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: typed } });
      assert.equal(res.status, 200, `rejected ${typed}`);
      assert.equal((await json(res)).name, "Peter Muchendu", `wrong name for ${typed}`);
    }
  } finally { await api.close(); }
});

test("the response carries the name and NOTHING else — no phone, id, balance or status", async () => {
  const api = await startTestApi();
  try {
    const me = await newMarketer(api, "Tony Angwa", "0722200003");
    const them = await newMarketer(api, "Peter Muchendu", "0798661062");
    const res = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: "0798661062" } });
    const raw = await res.text();
    // docs/58: the full number of anyone but the caller never leaves the server on a marketer
    // response. This route is the obvious place for that to regress, so assert on the raw body.
    assert.ok(!raw.includes("0798661062"), `recipient phone leaked: ${raw}`);
    assert.ok(!raw.includes("798661062"), `recipient phone leaked: ${raw}`);
    assert.ok(!raw.includes(them), `recipient id leaked: ${raw}`);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["name", "self"]);
  } finally { await api.close(); }
});

test("send-to-self is flagged by the server, because the app cannot tell", async () => {
  const api = await startTestApi();
  try {
    // /me masks the marketer's own number (docs/58), so the app holds 0722****004 and literally
    // cannot compare it with what was typed. The server is the only one that can answer this.
    const me = await newMarketer(api, "Tony Angwa", "0722200004");
    const r = await json(await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: "0722200004" } }));
    assert.equal(r.self, true);
    assert.equal(r.name, "Tony Angwa");
  } finally { await api.close(); }
});

test("another brand's marketer is invisible — same refusal as a number nobody holds", async () => {
  const api = await startTestApi();
  try {
    // Same escape hatch the other marketer tests use: `_setBrandName` is a seam on the in-memory
    // repo, not part of the MarketerRepo contract the API is typed against.
    (api.deps.marketers as any)._setBrandName(SITE_B, "Madolar");
    const me = await newMarketer(api, "Tony Angwa", "0722200005");
    // Created by a PLATFORM admin so it genuinely lands on the other brand.
    await json(await req(api, "POST", "/api/v1/admin/marketers",
      { token: PLATFORM, body: { name: "Other Brand Rep", phone: "0733300001", site: SITE_B } }));
    const other = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: "0733300001" } });
    const nobody = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: "0711999999" } });
    assert.equal(other.status, 404, "a sibling brand's marketer must not resolve");
    assert.equal(nobody.status, 404);
    assert.equal((await json(other)).error.code, (await json(nobody)).error.code,
      "the two refusals must be indistinguishable, or the route tells you which brand a number is on");
  } finally { await api.close(); }
});

test("a suspended marketer is not a destination, and says so no differently", async () => {
  const api = await startTestApi();
  try {
    const me = await newMarketer(api, "Tony Angwa", "0722200006");
    const them = await newMarketer(api, "Peter Muchendu", "0798661063");
    const ok = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: "0798661063" } });
    assert.equal(ok.status, 200, "active first, so the change below is what moves it");
    await req(api, "PATCH", `/api/v1/admin/marketers/${them}/status`, { token: ADMIN_A, body: { status: "suspended" } });
    const res = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: "0798661063" } });
    assert.equal(res.status, 404, "money must not be sendable into a wallet that is switched off");
    assert.equal((await json(res)).error.code, "RECIPIENT_NOT_FOUND");
  } finally { await api.close(); }
});

test("a malformed number is a 400, and the refusal does not echo what was typed", async () => {
  const api = await startTestApi();
  try {
    const me = await newMarketer(api, "Tony Angwa", "0722200007");
    for (const bad of ["", "   ", "0712", "abcdefghij", "0812345678", "07123456789"]) {
      const res = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: bad } });
      assert.ok(res.status === 400, `expected 400 for ${JSON.stringify(bad)}, got ${res.status}`);
      const raw = await res.text();
      // normalizeMsisdn throws with the input inside the message; it must not reach the body.
      if (bad.trim()) assert.ok(!raw.includes(bad), `the refusal echoed the typed number: ${raw}`);
    }
  } finally { await api.close(); }
});

test("authorization: anonymous 401, player 403, suspended caller 403", async () => {
  const api = await startTestApi();
  try {
    await newMarketer(api, "Peter Muchendu", "0798661064");
    const anon = await req(api, "POST", LOOKUP, { body: { phone: "0798661064" } });
    assert.equal(anon.status, 401, "the directory is not public");
    const player = await req(api, "POST", LOOKUP, { token: "u-player:player", body: { phone: "0798661064" } });
    assert.equal(player.status, 403, "a player must not be able to resolve marketer names");
    const admin = await req(api, "POST", LOOKUP, { token: ADMIN_A, body: { phone: "0798661064" } });
    assert.equal(admin.status, 403, "this is the marketer app's route; admins have their own");

    const me = await newMarketer(api, "Tony Angwa", "0722200008");
    await req(api, "PATCH", `/api/v1/admin/marketers/${me}/status`, { token: ADMIN_A, body: { status: "suspended" } });
    const off = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: "0798661064" } });
    assert.equal(off.status, 403, "a switched-off marketer keeps no read access");
  } finally { await api.close(); }
});

test("sweeping the number space runs out of budget", async () => {
  const api = await startTestApi();
  try {
    const me = await newMarketer(api, "Tony Angwa", "0722200009");
    // The per-marketer budget is 20/min. Walk past it and the route must start refusing: this is
    // the only thing bounding how fast one account can enumerate 07xx for names.
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await req(api, "POST", LOOKUP, { token: mtok(me), body: { phone: `07110000${String(i).padStart(2, "0")}` } });
      if (res.status === 429) limited++;
      await res.text();
    }
    assert.ok(limited > 0, "40 lookups in a minute went through unthrottled");
  } finally { await api.close(); }
});
