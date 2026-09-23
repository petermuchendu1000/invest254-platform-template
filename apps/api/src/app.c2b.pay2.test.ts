import { test } from "node:test";
import assert from "node:assert/strict";
import { C2bConfigService, type C2bConfig, type C2bConfigRepository, type C2bPatch } from "@invest254/engine";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";

/** PAY-2 (docs/45) — the C2B settings API: owner tier only, validated, and registration goes to Daraja. */
const OWNER = "own:platform_superadmin";
const ADMIN = `adm:admin:${SITE_A}`;
const PA = `pa:platform_admin:${SITE_A}:10000000-0000-0000-0000-000000000001`;

class Mem implements C2bConfigRepository {
  c: C2bConfig = { enabled: true, shortcode: "600999", accountNumber: "TRIO", businessName: "Trio", instructions: "",
    confirmationUrl: "https://api.example.com/api/v1/deposits/c2b/confirmation", validationUrl: "", responseType: "Completed",
    registeredAtMs: null, registeredShortcode: null, registeredConfirmationUrl: null, lastRegisterAtMs: null, lastRegisterOk: null,
    lastRegisterMessage: null, received7d: 0, unclaimed: 0, lastReceivedAtMs: null, updatedAtMs: null, registrationCurrent: false };
  async get() { return { ...this.c }; }
  async update(_a: string, _r: string, p: C2bPatch) {
    if (p.confirmationUrl && /mpesa/i.test(p.confirmationUrl)) throw new Error("INVALID_C2B_URL");
    Object.assign(this.c, p);
  }
  async recordRegistration(_a: string, _r: string, _s: string, _u: string, ok: boolean, message: string) { Object.assign(this.c, { lastRegisterOk: ok, lastRegisterMessage: message }); }
}
async function call(api: TestApi, method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${api.baseUrl}/api/v1${path}`, init);
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined };
}

test("PAY-2: only the System owner reads/changes C2B settings; bad input is refused with a plain message", async () => {
  const repo = new Mem();
  const fetchImpl = (async (u: string | URL) => new Response(JSON.stringify(String(u).includes("oauth") ? { access_token: "t" } : { ResponseCode: "0", ResponseDescription: "Success" }), { status: 200 })) as unknown as typeof fetch;
  const c2b = new C2bConfigService(repo, { darajaConfig: async () => ({ env: "sandbox", consumerKey: "k", consumerSecret: "s" }), fetchImpl });
  const api = await startTestApi({ depsOverrides: { c2b } });
  try {
    for (const t of [ADMIN, PA]) {
      assert.equal((await call(api, "GET", "/admin/c2b-config", t)).status, 403);
      assert.equal((await call(api, "POST", "/admin/c2b-config/register", t)).status, 403);
    }
    const g = await call(api, "GET", "/admin/c2b-config", OWNER);
    assert.equal(g.status, 200); assert.equal(g.body.shortcode, "600999");
    const p = await call(api, "PATCH", "/admin/c2b-config", OWNER, { accountNumber: " NEW ", responseType: "Cancelled" });
    assert.equal(p.status, 200); assert.equal(p.body.accountNumber, "NEW"); assert.equal(p.body.responseType, "Cancelled");
    assert.equal((await call(api, "PATCH", "/admin/c2b-config", OWNER, { responseType: "Maybe" })).status, 400);
    assert.equal((await call(api, "PATCH", "/admin/c2b-config", OWNER, { enabled: "yes" })).status, 400);
    assert.equal((await call(api, "PATCH", "/admin/c2b-config", OWNER, {})).status, 400);
    const bad = await call(api, "PATCH", "/admin/c2b-config", OWNER, { confirmationUrl: "https://x.com/mpesa/c" });
    assert.equal(bad.status, 400); assert.equal(bad.code, "INVALID_C2B_URL"); assert.match(bad.body.error.message, /Safaricom rejects them/);
    const r = await call(api, "POST", "/admin/c2b-config/register", OWNER);
    assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(repo.c.lastRegisterOk, true);
    repo.c.shortcode = "";
    const r2 = await call(api, "POST", "/admin/c2b-config/register", OWNER);
    assert.equal(r2.status, 409); assert.equal(r2.code, "C2B_SHORTCODE_REQUIRED");
  } finally { await api.close(); }
});
