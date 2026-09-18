/**
 * gatewaytest.ts — SAFE, read-only "Test connection" for each deposit gateway.
 *
 * Every probe hits a NON-mutating endpoint so pressing "Test" in the console can NEVER move money or
 * fire an STK prompt:
 *   • Mega Pay  — POST /transactionstatus with a sentinel id (status query only).
 *   • Paystack  — GET  /balance                (read-only; validates the secret key).
 *   • PayHero   — GET  /payment_channels        (read-only; validates the Basic token).
 *   • Binance   — POST /binancepay/openapi/v2/order/query with a sentinel id (query only; the HMAC
 *                 signature is what we're really validating — an unknown order is not an error we mind).
 *
 * `fetchImpl` is injectable so unit tests run fully offline against recorded response shapes.
 * A probe returns a normalised {ok, status, detail} — we translate provider-specific error text into
 * a stable status the UI can render, and we NEVER echo a secret back in `detail`.
 */
import { createHmac, randomBytes } from "node:crypto";
import { getSchema } from "./gatewayschema";

export type ConnStatus = "valid" | "invalid" | "unreachable" | "not_configured";
export interface ConnResult { ok: boolean; status: ConnStatus; detail: string }

type Fetch = typeof fetch;

const stripSlash = (u: string) => u.replace(/\/+$/, "");
const missing = (fields: string[]) => ({ ok: false, status: "not_configured" as const, detail: `Missing: ${fields.join(", ")}` });

async function safeJson(res: Response): Promise<any> { try { return await res.json(); } catch { return {}; } }

/** Mega Pay: a status query with a sentinel id. "Invalid Api Key" in the body ⇒ bad key. */
async function testMegapay(cfg: Record<string, string>, f: Fetch): Promise<ConnResult> {
  const need = ["api_key", "email"].filter((k) => !cfg[k]);
  if (need.length) return missing(need);
  const base = stripSlash(cfg.api_base || "https://megapay.co.ke/backend/v2");
  try {
    const res = await f(`${base}/transactionstatus`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: cfg.api_key, email: cfg.email, transaction_request_id: "connectivity-probe" }),
    });
    const j = await safeJson(res);
    const errMsg = String(j.errorMessage ?? j.ResultDesc ?? "");
    if (/invalid\s*api\s*key/i.test(errMsg) || /invalid.*key/i.test(errMsg)) {
      return { ok: false, status: "invalid", detail: "Mega Pay rejected the API key." };
    }
    if (!res.ok) return { ok: false, status: "unreachable", detail: `Mega Pay HTTP ${res.status}` };
    return { ok: true, status: "valid", detail: "Mega Pay accepted the credentials (status endpoint reachable)." };
  } catch (e) { return { ok: false, status: "unreachable", detail: `Mega Pay unreachable: ${String((e as Error).message).slice(0, 120)}` }; }
}

/** Paystack: GET /balance with the secret key. 200 ⇒ valid, 401 ⇒ bad key. */
async function testPaystack(cfg: Record<string, string>, f: Fetch): Promise<ConnResult> {
  if (!cfg.secret_key) return missing(["secret_key"]);
  const base = stripSlash(cfg.base_url || "https://api.paystack.co");
  try {
    const res = await f(`${base}/balance`, { method: "GET", headers: { Authorization: `Bearer ${cfg.secret_key}`, "Content-Type": "application/json" } });
    const j = await safeJson(res);
    if (res.status === 401 || j.status === false && /invalid.*key|authorization/i.test(String(j.message ?? ""))) {
      return { ok: false, status: "invalid", detail: "Paystack rejected the secret key." };
    }
    if (res.ok && j.status === true) return { ok: true, status: "valid", detail: "Paystack secret key is valid (balance read)." };
    if (res.ok) return { ok: true, status: "valid", detail: "Paystack reachable and authorized." };
    return { ok: false, status: "unreachable", detail: `Paystack HTTP ${res.status}` };
  } catch (e) { return { ok: false, status: "unreachable", detail: `Paystack unreachable: ${String((e as Error).message).slice(0, 120)}` }; }
}

/** PayHero: GET /payment_channels with the Basic token. 200 ⇒ valid, 401/403 ⇒ bad token. */
async function testPayhero(cfg: Record<string, string>, f: Fetch): Promise<ConnResult> {
  // Prefer the ready-made Basic Auth token; else derive it from API username + password (PayHero's own scheme).
  let token = (cfg.basic_auth_token || "").trim();
  if (!token && cfg.api_username && cfg.api_password) token = Buffer.from(`${cfg.api_username}:${cfg.api_password}`).toString("base64");
  if (!token) return missing(["basic_auth_token"]);
  const bare = /^basic\s+/i.test(token) ? token.replace(/^basic\s+/i, "") : token;
  const base = stripSlash(cfg.base_url || "https://backend.payhero.co.ke/api/v2");
  try {
    const res = await f(`${base}/payment_channels`, { method: "GET", headers: { Authorization: `Basic ${bare}`, "Content-Type": "application/json" } });
    if (res.status === 401 || res.status === 403) return { ok: false, status: "invalid", detail: "PayHero rejected the Basic Auth token." };
    if (res.ok) return { ok: true, status: "valid", detail: "PayHero token is valid (payment channels read)." };
    return { ok: false, status: "unreachable", detail: `PayHero HTTP ${res.status}` };
  } catch (e) { return { ok: false, status: "unreachable", detail: `PayHero unreachable: ${String((e as Error).message).slice(0, 120)}` }; }
}

/** Binance Pay: HMAC-SHA512 signed query of a sentinel order. Signature errors ⇒ invalid creds. */
export function binancePaySignature(secret: string, timestamp: string, nonce: string, body: string): string {
  const payload = `${timestamp}\n${nonce}\n${body}\n`;
  return createHmac("sha512", secret).update(payload).digest("hex").toUpperCase();
}

async function testBinance(cfg: Record<string, string>, f: Fetch): Promise<ConnResult> {
  const need = ["api_key", "api_secret"].filter((k) => !cfg[k]);
  if (need.length) return missing(need);
  const apiKey = cfg.api_key as string;
  const apiSecret = cfg.api_secret as string;
  const base = stripSlash(cfg.base_url || "https://bpay.binanceapi.com");
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex").slice(0, 32);
  const body = JSON.stringify({ merchantTradeNo: "connectivityprobe0000000000" });
  const sig = binancePaySignature(apiSecret, ts, nonce, body);
  try {
    const res = await f(`${base}/binancepay/openapi/v2/order/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "BinancePay-Timestamp": ts, "BinancePay-Nonce": nonce,
        "BinancePay-Certificate-SN": apiKey, "BinancePay-Signature": sig,
      },
      body,
    });
    const j = await safeJson(res);
    const code = String(j.code ?? "");
    const errMsg = String(j.errorMessage ?? "");
    // Auth/signature failures Binance surfaces with these codes / messages.
    if (["400201", "400202", "400203", "400002"].includes(code) || /signature|certificate|api key|unauthor/i.test(errMsg)) {
      return { ok: false, status: "invalid", detail: "Binance Pay rejected the API key / signature." };
    }
    if (res.ok) return { ok: true, status: "valid", detail: "Binance Pay accepted the signature (order query reachable)." };
    return { ok: false, status: "unreachable", detail: `Binance Pay HTTP ${res.status}` };
  } catch (e) { return { ok: false, status: "unreachable", detail: `Binance Pay unreachable: ${String((e as Error).message).slice(0, 120)}` }; }
}

const PROBES: Record<string, (cfg: Record<string, string>, f: Fetch) => Promise<ConnResult>> = {
  megapay: testMegapay, paystack: testPaystack, payhero: testPayhero, binance: testBinance,
};

/** Run the safe probe for a provider using the merged (settings + decrypted secrets) config. */
export async function testConnection(code: string, cfg: Record<string, string>, fetchImpl: Fetch = fetch): Promise<ConnResult> {
  getSchema(code); // throws PROVIDER_NOT_CONFIGURABLE for unknown codes
  const probe = PROBES[code];
  if (!probe) return { ok: false, status: "not_configured", detail: "No connectivity test for this provider." };
  return probe(cfg, fetchImpl);
}
