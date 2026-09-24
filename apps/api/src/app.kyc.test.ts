import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";
import { InMemoryKycStore } from "./app.kyc.js";

/** ACCT-1 — identity verification API: player submit, file rules, staff review scoped by brand. */
const SITE_B = "00000000-0000-0000-0000-00000000000b";
const P = `p1:player:${SITE_A}`;
const ADMIN_A = `adm:admin:${SITE_A}`;
const ADMIN_B = `admb:admin:${SITE_B}`;
async function call(api: TestApi, method: string, path: string, token: string | null, body?: unknown, raw?: { type: string; data: Buffer }) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (raw) { headers["content-type"] = raw.type; init.body = raw.data; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${api.baseUrl}/api/v1${path}`, init);
  const ct = r.headers.get("content-type") ?? "";
  const j = ct.includes("json") ? ((await r.json().catch(() => ({}))) as any) : null;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined, bytes: j ? null : Buffer.from(await r.arrayBuffer()), type: ct };
}
const img = (n = 64) => ({ type: "image/jpeg", data: Buffer.alloc(n, 7) });

test("ACCT-1 API: submit documents, one pending at a time, staff of the brand review with a note", async () => {
  const store = new InMemoryKycStore();
  store.users.set("p1", { siteId: SITE_A, username: "alice" });
  const api = await startTestApi({ depsOverrides: { kyc: { store, mediaSecret: "s" } } });
  try {
    assert.deepEqual((await call(api, "GET", "/kyc", P)).body, { status: "none", latest: null });
    assert.equal((await call(api, "GET", "/kyc", ADMIN_A)).code, "CUSTOMERS_ONLY");
    assert.equal((await call(api, "POST", "/kyc/files", P, undefined, { type: "text/plain", data: Buffer.from("x") })).code, "UNSUPPORTED_FILE");
    assert.equal((await call(api, "POST", "/kyc/files", P, undefined, { type: "image/png", data: Buffer.alloc(6 * 1024 * 1024 + 1) })).status, 413);
    const front = (await call(api, "POST", "/kyc/files", P, undefined, img())).body.id;
    const selfie = (await call(api, "POST", "/kyc/files", P, undefined, img(80))).body.id;
    const pdf = (await call(api, "POST", "/kyc/files", P, undefined, { type: "application/pdf", data: Buffer.from("%PDF-1.4") })).body.id;
    const base = { docType: "national_id", fullName: "Alice Wanjiku", idNumber: "12345678", dateOfBirth: "1990-05-01", frontId: front, selfieId: selfie };
    assert.equal((await call(api, "POST", "/kyc", P, { ...base, docType: "library_card" })).code, "INVALID_DOC_TYPE");
    assert.equal((await call(api, "POST", "/kyc", P, { ...base, dateOfBirth: "2015-01-01" })).code, "INVALID_DOB", "under-18s are refused");
    assert.equal((await call(api, "POST", "/kyc", P, { ...base, selfieId: pdf })).code, "SELFIE_MUST_BE_PHOTO");
    assert.equal((await call(api, "POST", "/kyc", P, { ...base, selfieId: front })).code, "FILE_REUSED");
    const sub = await call(api, "POST", "/kyc", P, base);
    assert.equal(sub.status, 201);
    assert.equal((await call(api, "GET", "/kyc", P)).body.status, "pending");
    assert.equal((await call(api, "POST", "/kyc", P, base)).code, "ALREADY_PENDING");

    // staff: brand A sees it with file links; brand B does not
    const list = await call(api, "GET", "/admin/kyc", ADMIN_A);
    assert.equal(list.body.items.length, 1); assert.equal(list.body.items[0].files, undefined, "the list carries no file links");
    assert.equal((await call(api, "GET", "/admin/kyc", ADMIN_B)).body.items.length, 0);
    assert.equal((await call(api, "GET", `/admin/kyc/${sub.body.id}`, ADMIN_B)).status, 404);
    const det = await call(api, "GET", `/admin/kyc/${sub.body.id}`, ADMIN_A);
    assert.equal(det.body.submission.idNumber, "12345678");
    const f = await call(api, "GET", det.body.submission.files.front.replace("/api/v1", ""), null);
    assert.equal(f.status, 200); assert.equal(f.type, "image/jpeg"); assert.equal(f.bytes!.length, 64);
    assert.equal((await call(api, "GET", `/kyc/file/${front}?t=1.x`, null)).status, 404, "files need a signed link");

    // reject needs a note; the player sees it; they can submit again; then approval sticks
    assert.equal((await call(api, "POST", `/admin/kyc/${sub.body.id}/decision`, ADMIN_A, { decision: "rejected" })).code, "NOTE_REQUIRED");
    assert.equal((await call(api, "POST", `/admin/kyc/${sub.body.id}/decision`, ADMIN_A, { decision: "rejected", note: "Photo is blurry" })).status, 200);
    const me = (await call(api, "GET", "/kyc", P)).body;
    assert.equal(me.status, "rejected"); assert.equal(me.latest.reviewNote, "Photo is blurry");
    assert.equal((await call(api, "POST", `/admin/kyc/${sub.body.id}/decision`, ADMIN_A, { decision: "approved" })).code, "ALREADY_REVIEWED");
    const f2 = (await call(api, "POST", "/kyc/files", P, undefined, img(90))).body.id;
    const s2 = (await call(api, "POST", "/kyc/files", P, undefined, img(91))).body.id;
    assert.equal((await call(api, "POST", "/kyc", P, { ...base, frontId: front, selfieId: s2 })).code, "FILE_NOT_FOUND", "a used file can't be reused");
    const sub2 = await call(api, "POST", "/kyc", P, { ...base, frontId: f2, selfieId: s2 });
    await call(api, "POST", `/admin/kyc/${sub2.body.id}/decision`, ADMIN_A, { decision: "approved" });
    assert.equal((await call(api, "GET", "/kyc", P)).body.status, "approved");
    assert.equal((await call(api, "GET", `/admin/kyc?userId=p1`, ADMIN_A)).status, 200);
  } finally { await api.close(); }
});
