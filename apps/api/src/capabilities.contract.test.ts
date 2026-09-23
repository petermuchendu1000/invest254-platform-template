import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_CAPABILITIES, can, type Capability, type Tier } from "@invest254/shared";
import { startTestApi, SITE_A, type TestApi } from "./testutil.js";

/**
 * docs/42 P2 — the UI capability list (packages/shared/src/capabilities.ts) and the API must agree.
 *
 * For EVERY capability, a representative request is sent as EVERY tier against the real router. The
 * gate is judged by status: 401/403 = refused, anything else (2xx, or 400/404/409 after the gate) =
 * allowed. The test fails if `can(tier, cap)` differs from what the API did — so a control can no longer
 * be shown to a tier the API refuses (dead control) or hidden from a tier the API allows. Adding a
 * capability without a probe here also fails (exhaustiveness check).
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}/api/v1${path}`, init);
}

const DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001";
const TOKENS: Record<Tier, string> = {
  player: `t-player:player:${SITE_A}`,
  marketer: `t-marketer:marketer:${SITE_A}`,
  admin: `t-admin:admin:${SITE_A}`,
  platform_admin: `t-pa:platform_admin:${SITE_A}:${DEFAULT_PLATFORM}`,
  platform_superadmin: `t-owner:platform_superadmin:${SITE_A}`,
};
const OWNER_SETUP = "setup-owner:platform_superadmin";
const TIERS = Object.keys(TOKENS) as Tier[];

interface Fx { player: (n: string) => Promise<string>; adminTarget: () => Promise<string>; marketer: () => Promise<string> }
function fixtures(api: TestApi): Fx {
  let seq = 0;
  const reg = async (tag: string): Promise<string> => {
    const n = String(++seq).padStart(3, "0");
    const r = await req(api, "POST", "/auth/register", undefined, { phone: `0711${n}${tag.length}${n.slice(-2)}`.slice(0, 10), username: `${tag}${n}`, password: "Password1", site: "invest254" });
    assert.equal(r.status, 201, `register ${tag}${n}`);
    return (await json(r)).userId as string;
  };
  return {
    player: reg,
    adminTarget: async () => {
      const u = await reg("adm");
      assert.equal((await req(api, "POST", `/admin/users/${u}/role`, OWNER_SETUP, { role: "admin" })).status, 200, "seed an admin target");
      return u;
    },
    marketer: async () => {
      const u = await reg("mkt");
      assert.equal((await req(api, "POST", "/affiliate/enroll", `${u}:player:${SITE_A}`)).status, 200, "seed a marketer");
      return u;
    },
  };
}

/** One representative request per capability. Bodies are valid where it matters. */
type Probe = (api: TestApi, token: string, fx: Fx) => Promise<Response>;
const PROBES: Record<Capability, Probe | { exempt: string }> = {
  "backoffice.enter": (api, t) => req(api, "GET", "/admin/overview", t),
  "backoffice.users.edit_details": async (api, t, fx) => req(api, "POST", `/admin/users/${await fx.player("det")}/details`, t, { username: `renamed${Date.now() % 100000}` }),
  "backoffice.users.set_role_basic": async (api, t, fx) => req(api, "POST", `/admin/users/${await fx.player("rb")}/role`, t, { role: "marketer" }),
  "backoffice.users.set_role_admin": async (api, t, fx) => req(api, "POST", `/admin/users/${await fx.player("ra")}/role`, t, { role: "admin" }),
  "backoffice.users.delete": async (api, t, fx) => req(api, "POST", `/admin/users/${await fx.player("del")}/delete`, t),
  "backoffice.users.delete_admin": async (api, t, fx) => req(api, "POST", `/admin/users/${await fx.adminTarget()}/delete`, t),
  "backoffice.users.overrides_write": async (api, t, fx) => req(api, "POST", `/admin/users/${await fx.player("ov")}/overrides`, t, {}),
  "backoffice.marketers.default": async (api, t, fx) => req(api, "POST", `/admin/marketers/${await fx.marketer()}/make-default`, t),
  "backoffice.economy_integrity": (api, t) => req(api, "GET", "/admin/real-cash-rtp", t),
  "backoffice.audit": (api, t) => req(api, "GET", "/admin/audit", t),
  "backoffice.logs": (api, t) => req(api, "GET", "/admin/logs", t),
  "backoffice.governance": (api, t) => req(api, "PATCH", "/admin/game-config", t, {}),
  "console.enter": (api, t) => req(api, "GET", "/platform/overview", t),
  "console.brands": (api, t) => req(api, "GET", "/platform/sites", t),
  "console.system": (api, t) => req(api, "GET", "/platform/platforms", t),
  "console.site.owner_settings": (api, t) => req(api, "PATCH", `/platform/sites/${SITE_A}/owner`, t, { ownerUserId: null }),
  "console.performance": (api, t) => req(api, "GET", "/platform/performance", t),
  "earn.referrals": (api, t) => req(api, "GET", "/me/referral", t),
  "earn.marketer_dashboard": (api, t) => req(api, "GET", "/affiliate/advances", t),
  "console.live": { exempt: "engine WebSocket (multiengine `subscribe_platform`), not an API route — covered by multiengine tests" },
};

test("docs/42 P2: every capability has a probe (exhaustive)", () => {
  assert.deepEqual(Object.keys(PROBES).sort(), [...ALL_CAPABILITIES].sort());
});

for (const tier of TIERS) {
  test(`docs/42 P2: API gates == capability list for ${tier}`, async () => {
    const api = await startTestApi();
    const fx = fixtures(api);
    const mismatches: string[] = [];
    try {
      for (const cap of ALL_CAPABILITIES) {
        const probe = PROBES[cap];
        if (typeof probe !== "function") continue;
        const res = await probe(api, TOKENS[tier], fx);
        const allowed = res.status !== 401 && res.status !== 403;
        if (allowed !== can(tier, cap)) {
          let code = ""; try { code = (await json(res)).error?.code ?? ""; } catch { /* no body */ }
          mismatches.push(`${cap}: list says ${can(tier, cap) ? "ALLOW" : "DENY"}, API returned ${res.status} ${code}`);
        }
      }
    } finally { await api.close(); }
    assert.deepEqual(mismatches, [], `UI capability list disagrees with the API for ${tier}`);
  });
}
