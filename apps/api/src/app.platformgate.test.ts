import { test } from "node:test";
import assert from "node:assert/strict";
import { PlatformGate } from "@invest254/shared";
import { startTestApi, TEST_USER } from "./testutil.js";

// e2e: prove the platform master switches (migration 0092) HARD-BLOCK each system at the HTTP layer.
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(base: string, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  return fetch(`${base}${path}`, init);
}
const gateWith = (flags: Record<string, unknown>) =>
  new PlatformGate(async () => ({ rows: [flags] }), 0);
const ALL_OFF = {
  deposits_enabled: false, withdrawals_enabled: false, play_enabled: false,
  marketers_enabled: false, registrations_enabled: false, maintenance_message: "Down for maintenance", version: 9,
};

test("global switches OFF → every guarded endpoint returns 403 SYSTEM_DISABLED", async () => {
  const api = await startTestApi({ depsOverrides: { platformGate: gateWith(ALL_OFF) } });
  try {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["/api/v1/deposits",             TEST_USER, { amount: 50_000, phone: "0712345678" }],
      ["/api/v1/withdrawals",          TEST_USER, { amount: 50_000, phone: "0712345678" }],
    ];
    for (const [path, token, body] of cases) {
      const res = await req(api.baseUrl, "POST", path, { token, body });
      assert.equal(res.status, 403, `${path} should be 403 when disabled`);
      assert.equal((await json(res)).error.code, "SYSTEM_DISABLED", `${path} code`);
    }
    // unauthenticated public flows
    const reg = await req(api.baseUrl, "POST", "/api/v1/auth/register", { body: { phone: "+254700000001", username: "newbie", password: "supersecret1" } });
    assert.equal(reg.status, 403); assert.equal((await json(reg)).error.code, "SYSTEM_DISABLED");
    const mlog = await req(api.baseUrl, "POST", "/api/v1/marketers/auth/login", { body: { phone: "+254700000002", pin: "1234" } });
    assert.equal(mlog.status, 403); assert.equal((await json(mlog)).error.code, "SYSTEM_DISABLED");
    // public /config reflects the off state (web reads this for the banner + disabled buttons)
    const cfg = await json(await req(api.baseUrl, "GET", "/api/v1/config"));
    assert.equal(cfg.depositsEnabled, false);
    assert.equal(cfg.withdrawalsEnabled, false);
    assert.equal(cfg.maintenanceMessage, "Down for maintenance");
  } finally { await api.close(); }
});

test("selective switch: withdrawals OFF blocks withdrawals but deposits still work", async () => {
  const api = await startTestApi({
    startingBalanceCents: 1_000_000,
    depsOverrides: { platformGate: gateWith({ ...ALL_OFF, deposits_enabled: true, withdrawals_enabled: false, marketers_enabled: true, registrations_enabled: true }) },
  });
  try {
    const dep = await req(api.baseUrl, "POST", "/api/v1/deposits", { token: TEST_USER, body: { amount: 50_000, phone: "0712345678" } });
    assert.equal(dep.status, 202, "deposits allowed → 202");
    const wd = await req(api.baseUrl, "POST", "/api/v1/withdrawals", { token: TEST_USER, body: { amount: 50_000, phone: "0712345678" } });
    assert.equal(wd.status, 403, "withdrawals blocked → 403");
    assert.equal((await json(wd)).error.code, "SYSTEM_DISABLED");
  } finally { await api.close(); }
});

test("no gate configured (test default) → nothing blocked; /config is all-ON", async () => {
  const api = await startTestApi();
  try {
    const cfg = await json(await req(api.baseUrl, "GET", "/api/v1/config"));
    assert.equal(cfg.depositsEnabled, true);
    assert.equal(cfg.playEnabled, true);
    const dep = await req(api.baseUrl, "POST", "/api/v1/deposits", { token: TEST_USER, body: { amount: 50_000, phone: "0712345678" } });
    assert.equal(dep.status, 202);
  } finally { await api.close(); }
});
