import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A } from "./testutil.js";

/**
 * docs/42 UI-12 (owner decision 2026-09-23: "hide for all operators"). An operator earning revenue
 * share on players they can manage is a conflict of interest, so NO operator tier — site admin
 * (including a platform/system admin who opened a brand: an `admin` token), platform admin or system
 * admin — may enrol as an affiliate, read/share a referral code, or use the marketer earning routes
 * (payout / advance requests). Players and marketers are unaffected.
 */
const PLATFORM = "10000000-0000-0000-0000-000000000001";
const OPERATORS: Record<string, string> = {
  "site admin": `u-op-admin:admin:${SITE_A}`,
  "opened brand (impersonation token)": `u-op-owner:admin:${SITE_A}`,
  "platform admin": `u-op-pa:platform_admin:${SITE_A}:${PLATFORM}`,
  "system admin": `u-op-owner:platform_superadmin:${SITE_A}`,
};

const EARNING_ROUTES: Array<[string, string, unknown?]> = [
  ["POST", "/affiliate/enroll"],
  ["GET", "/me/referral"],
  ["GET", "/me/referral/commissions"],
  ["POST", "/me/referral/payouts"],
  ["GET", "/me/referral/payouts"],
  ["GET", "/affiliate/summary"],
  ["GET", "/affiliate/referrals"],
  ["GET", "/affiliate/commissions"],
  ["GET", "/affiliate/expenses"],
  ["POST", "/affiliate/payouts"],
  ["POST", "/affiliate/advances", { amountCents: 50_000 }],
  ["GET", "/affiliate/advances"],
];

async function call(baseUrl: string, method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${baseUrl}/api/v1${path}`, init);
  let code = ""; try { code = ((await r.json()) as any)?.error?.code ?? ""; } catch { /* empty */ }
  return { status: r.status, code };
}

test("UI-12: every operator tier is refused every affiliate/referral earning route (OPERATOR_NOT_ELIGIBLE)", async () => {
  const api = await startTestApi();
  const wrong: string[] = [];
  try {
    for (const [who, token] of Object.entries(OPERATORS)) {
      for (const [method, path, body] of EARNING_ROUTES) {
        const r = await call(api.baseUrl, method, path, token, body);
        if (r.status !== 403 || r.code !== "OPERATOR_NOT_ELIGIBLE") wrong.push(`${who} ${method} ${path} -> ${r.status} ${r.code}`);
      }
    }
  } finally { await api.close(); }
  assert.deepEqual(wrong, []);
});

test("UI-12: players and marketers keep their earning routes", async () => {
  const api = await startTestApi();
  try {
    const reg = await fetch(`${api.baseUrl}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "0711120012", username: "ui12player", password: "Password1", site: "invest254" }) });
    assert.equal(reg.status, 201);
    const uid = ((await reg.json()) as any).userId as string;
    const player = `${uid}:player:${SITE_A}`;
    const ref = await call(api.baseUrl, "GET", "/me/referral", player);
    assert.equal(ref.status, 200, "a player reads their invite code");
    const enrol = await call(api.baseUrl, "POST", "/affiliate/enroll", player);
    assert.equal(enrol.status, 200, "a player may apply to the programme");
    const marketer = `${uid}:marketer:${SITE_A}`;
    for (const path of ["/me/referral", "/affiliate/summary", "/affiliate/advances"]) {
      const r = await call(api.baseUrl, "GET", path, marketer);
      assert.ok(r.status !== 401 && r.status !== 403, `marketer ${path} -> ${r.status} ${r.code}`);
    }
  } finally { await api.close(); }
});

test("UI-12: operators keep the ADMIN side of the programme (queues, approvals)", async () => {
  const api = await startTestApi();
  try {
    const admin = OPERATORS["site admin"]!;
    for (const path of ["/admin/commission-payouts", "/admin/affiliate/advances"]) {
      const r = await call(api.baseUrl, "GET", path, admin);
      assert.equal(r.status, 200, `${path} -> ${r.status} ${r.code}`);
    }
  } finally { await api.close(); }
});
