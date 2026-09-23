import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi } from "./testutil.js";

/** PAY-0 (BUGLOG #62): PATCH /admin/mpesa-config silently dropped the Till / B2C fields the M-Pesa page sends. */
const OWNER = "own:platform_superadmin";
async function call(base: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${OWNER}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(`${base}/api/v1${path}`, init);
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, body: j, code: j?.error?.code as string | undefined };
}

test("PAY-0: Till number, rail, B2C shortcode and CommandID are saved and read back", async () => {
  const api = await startTestApi();
  try {
    const saved = await call(api.baseUrl, "PATCH", "/admin/mpesa-config", { transactionType: "till", tillNumber: "5555555", b2cShortcode: "3000111", b2cCommandId: "SalaryPayment" });
    assert.equal(saved.status, 200, `${saved.status} ${saved.code}`);
    const back = (await call(api.baseUrl, "GET", "/admin/mpesa-config")).body;
    assert.deepEqual([back.transactionType, back.tillNumber, back.b2cShortcode, back.b2cCommandId], ["till", "5555555", "3000111", "SalaryPayment"]);
    // clearing a number back to "use the shortcode"
    assert.equal((await call(api.baseUrl, "PATCH", "/admin/mpesa-config", { b2cShortcode: "" })).status, 200);
    assert.equal((await call(api.baseUrl, "GET", "/admin/mpesa-config")).body.b2cShortcode, "");
  } finally { await api.close(); }
});

test("PAY-0: invalid Till / B2C values are refused with 400", async () => {
  const api = await startTestApi();
  try {
    for (const body of [{ transactionType: "buygoods" }, { b2cCommandId: "Refund" }, { tillNumber: "12ab" }, { b2cShortcode: "1" }, { tillNumber: 5555555 }]) {
      const r = await call(api.baseUrl, "PATCH", "/admin/mpesa-config", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`); assert.equal(r.code, "VALIDATION");
    }
  } finally { await api.close(); }
});
