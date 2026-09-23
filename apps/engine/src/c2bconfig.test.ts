import { test } from "node:test";
import assert from "node:assert/strict";
import { C2bConfigService, type C2bConfig, type C2bConfigRepository, type C2bPatch } from "./c2bconfig.js";
import { registerC2bUrls } from "./daraja.js";

const base = (): C2bConfig => ({
  enabled: true, shortcode: "600999", accountNumber: "TRIO", businessName: "Trio", instructions: "",
  confirmationUrl: "https://api.example.com/api/v1/deposits/c2b/confirmation", validationUrl: "", responseType: "Completed",
  registeredAtMs: null, registeredShortcode: null, registeredConfirmationUrl: null, lastRegisterAtMs: null, lastRegisterOk: null,
  lastRegisterMessage: null, received7d: 0, unclaimed: 0, lastReceivedAtMs: null, updatedAtMs: null, registrationCurrent: false,
});
class Mem implements C2bConfigRepository {
  c = base(); recorded: Array<[string, string, boolean, string]> = [];
  async get() { return { ...this.c }; }
  async update(_a: string, _r: string, p: C2bPatch) { Object.assign(this.c, p); }
  async recordRegistration(_a: string, _r: string, sc: string, url: string, ok: boolean, msg: string) {
    this.recorded.push([sc, url, ok, msg]);
    if (ok) Object.assign(this.c, { registeredAtMs: 1, registeredShortcode: sc, registeredConfirmationUrl: url });
  }
}
function mockFetch(reply: { status?: number; body: unknown }, calls: Array<{ url: string; body?: any }>) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url); calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const res = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/oauth/")) return res({ access_token: "tok" });
    return res(reply.body, reply.status ?? 200);
  }) as typeof fetch;
}
const creds = async () => ({ env: "production" as const, consumerKey: "K", consumerSecret: "S" });

test("PAY-2: RegisterURL sends the saved Pay Bill + URLs to Daraja v2 and records success", async () => {
  const repo = new Mem(); const calls: Array<{ url: string; body?: any }> = [];
  const svc = new C2bConfigService(repo, { darajaConfig: creds, fetchImpl: mockFetch({ body: { ResponseCode: "0", ResponseDescription: "Success" } }, calls) });
  const r = await svc.register("owner", "platform_superadmin");
  assert.equal(r.ok, true);
  const reg = calls.find((c) => c.url.includes("/mpesa/c2b/v2/registerurl"))!;
  assert.ok(reg.url.startsWith("https://api.safaricom.co.ke"), "production base");
  assert.deepEqual(reg.body, { ShortCode: "600999", ResponseType: "Completed", ConfirmationURL: base().confirmationUrl, ValidationURL: base().confirmationUrl });
  assert.deepEqual(repo.recorded, [["600999", base().confirmationUrl, true, "Success"]]);
});

test("PAY-2: a Safaricom rejection is recorded (never thrown) and does not mark the Pay Bill registered", async () => {
  const repo = new Mem(); const calls: Array<{ url: string }> = [];
  const svc = new C2bConfigService(repo, { darajaConfig: creds, fetchImpl: mockFetch({ status: 400, body: { errorMessage: "Invalid ValidationURL" } }, calls) });
  const r = await svc.register("owner", "platform_superadmin");
  assert.equal(r.ok, false); assert.equal(r.message, "Invalid ValidationURL");
  assert.equal(repo.recorded[0]![2], false);
  assert.equal(r.config.registeredAtMs, null);
});

test("PAY-2: registration needs a Pay Bill, a confirmation URL and app credentials", async () => {
  const repo = new Mem(); repo.c.shortcode = "";
  const svc = new C2bConfigService(repo, { darajaConfig: creds, fetchImpl: mockFetch({ body: {} }, []) });
  await assert.rejects(() => svc.register("o", "platform_superadmin"), /C2B_SHORTCODE_REQUIRED/);
  repo.c.shortcode = "600999"; repo.c.confirmationUrl = "";
  await assert.rejects(() => svc.register("o", "platform_superadmin"), /C2B_CONFIRMATION_URL_REQUIRED/);
  const noCreds = await registerC2bUrls({ env: "sandbox", consumerKey: "", consumerSecret: "" },
    { shortCode: "1", responseType: "Completed", confirmationUrl: "https://x", validationUrl: "" }, mockFetch({ body: {} }, []));
  assert.equal(noCreds.ok, false); assert.match(noCreds.message, /consumer key/);
});
