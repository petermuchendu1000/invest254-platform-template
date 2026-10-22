/**
 * gatewaytest.ts — SAFE, read-only "Test connection" for each deposit gateway.
 *
 * Every probe hits a NON-mutating endpoint so pressing "Test" in the console can NEVER move money or
 * fire an STK prompt:
 *   • Mega Pay  — POST /transactionstatus with a sentinel id (status query only; host follows env).
 *   • Paystack  — GET  /balance                (read-only; validates the secret key).
 *   • PayHero   — GET  /payment_channels        (read-only; validates the Basic token).
 *   • Paynicorn — POST /trade/v3/transaction/query for a sentinel order (signed; validates appKey + secret).
 *   • Binance   — POST /binancepay/openapi/v2/order/query with a sentinel id (query only; the HMAC
 *                 signature is what we're really validating — an unknown order is not an error we mind).
 *
 * `fetchImpl` is injectable so unit tests run fully offline against recorded response shapes.
 * A probe returns a normalised {ok, status, detail} — we translate provider-specific error text into
 * a stable status the UI can render, and we NEVER echo a secret back in `detail`.
 */
import { createHmac, randomBytes } from "node:crypto";
import { getSchema } from "./gatewayschema";
import { normalizeMegapayBase } from "./megapay";
import { PAYNICORN_DEFAULT_BASE, PAYNICORN_OK, encodeContent, paynicornSign } from "./paynicorn";

export type ConnStatus = "valid" | "invalid" | "unreachable" | "not_configured";
export interface ConnResult { ok: boolean; status: ConnStatus; detail: string }

type Fetch = typeof fetch;

const stripSlash = (u: string) => u.replace(/\/+$/, "");
const missing = (fields: string[]) => ({ ok: false, status: "not_configured" as const, detail: `Missing: ${fields.join(", ")}` });

/**
 * SSRF guard for a caller-supplied gateway base URL. The "test connection" path merges a draft
 * `base_url`/`api_base` over the stored config and then issues an outbound request WITH the decrypted
 * provider secret attached, so an operator (even the system owner) who points it at
 * `http://169.254.169.254/...`, `http://localhost`, or an internal host would turn this into blind
 * SSRF against cloud metadata / the internal network AND exfiltrate the live credential to a host
 * they chose. Validate the host before any probe runs: HTTPS only, and never a loopback/private/
 * link-local/metadata/`.internal` target.
 *
 * (Residual: a public hostname that later DNS-rebinds to a private address is not caught here —
 * mitigating that needs resolve-and-pin, noted in docs. This closes the direct-literal and
 * internal-hostname vectors, which is the exploit the audit demonstrated.)
 */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  return a === 10 || a === 127 || (a === 169 && b === 254) || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);           // carrier-grade NAT
}
export function assertSafeGatewayUrl(raw: string | undefined | null): void {
  const v = (raw ?? "").trim();
  if (!v) return;                                  // empty -> the provider default (a known public host) is used
  let u: URL;
  try { u = new URL(v); } catch { throw new Error("GATEWAY_URL_INVALID"); }
  if (u.protocol !== "https:") throw new Error("GATEWAY_URL_INSECURE");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local") ||
      host === "metadata.google.internal") throw new Error("GATEWAY_URL_BLOCKED");
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) throw new Error("GATEWAY_URL_BLOCKED");
  if (isPrivateIpv4(host)) throw new Error("GATEWAY_URL_BLOCKED");
}

async function safeJson(res: Response): Promise<any> { try { return await res.json(); } catch { return {}; } }

/**
 * Mega Pay: a status query for a sentinel id (never moves money). Both hosts answer HTTP 200 with
 * {ResultCode:"102", errorMessage} for a failed query, so the MESSAGE says what was wrong (recorded
 * against the live API, 2026-09-24):
 *   production /backend/v1: "Api Key does not exist!" · "Email does not exist!" ·
 *                           "Transaction request does not exist!"  ⇐ key + email ACCEPTED
 *   sandbox    /backend/v2: "Invalid Api Key. Use Test Api Key: …" · "Invalid email. Use Test Email: …"
 * The old probe only looked for "invalid … key": on production it reported a wrong key or email as
 * "valid", and on the sandbox (the old default host) a correct live key as "rejected" (BUGLOG #73).
 */
async function testMegapay(cfg: Record<string, string>, f: Fetch): Promise<ConnResult> {
  const need = ["api_key", "email"].filter((k) => !cfg[k]);
  if (need.length) return missing(need);
  const env = cfg.env === "production" ? "production" : "sandbox";
  const base = normalizeMegapayBase(cfg.api_base, env);
  const where = env === "production" ? "production" : "sandbox";
  try {
    const res = await f(`${base}/transactionstatus`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: cfg.api_key, email: cfg.email, transaction_request_id: "connectivity-probe" }),
    });
    const j = await safeJson(res);
    const msg = String(j.errorMessage ?? j.ResultDesc ?? "").split(String(cfg.api_key)).join("…");
    if (/use test api key/i.test(msg)) {
      return { ok: false, status: "invalid", detail: "Mega Pay's sandbox only accepts its public test key. For a live key, set Environment to Production." };
    }
    if (/use test email/i.test(msg)) {
      return { ok: false, status: "invalid", detail: "Mega Pay's sandbox only accepts its public test email. For a live account, set Environment to Production." };
    }
    if (/api\s*key\s*does\s*not\s*exist|invalid\s*api\s*key/i.test(msg)) {
      return { ok: false, status: "invalid", detail: `Mega Pay (${where}) does not recognise this API key.` };
    }
    if (/email\s*does\s*not\s*exist|invalid\s*email/i.test(msg)) {
      return { ok: false, status: "invalid", detail: `Mega Pay (${where}) does not recognise this email — use the email the Mega Pay account is registered with.` };
    }
    if (!res.ok) return { ok: false, status: "unreachable", detail: `Mega Pay HTTP ${res.status}` };
    if (/transaction\s*request\s*does\s*not\s*exist/i.test(msg) || j.TransactionStatus != null || String(j.ResultCode ?? "") === "200") {
      return { ok: true, status: "valid", detail: `Mega Pay (${where}) accepted the API key and email.` };
    }
    return { ok: false, status: "invalid", detail: msg ? `Mega Pay answered: ${msg.slice(0, 160)}` : "Mega Pay gave an unexpected answer." };
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

/**
 * Paynicorn: a signed status query for a sentinel order (never moves money). The envelope's responseCode
 * says whether the signature verified: 000000 = appKey + secret accepted (the unknown order is reported
 * inside the content), 204005/204004 = bad secret, 204002 = missing appKey.
 */
async function testPaynicorn(cfg: Record<string, string>, f: Fetch): Promise<ConnResult> {
  const need = ["app_key", "merchant_secret"].filter((k) => !cfg[k]);
  if (need.length) return missing(need);
  const base = stripSlash(cfg.base_url || PAYNICORN_DEFAULT_BASE);
  const content = encodeContent({ orderId: "connectivity-probe", txnType: "payment" });
  try {
    const res = await f(`${base}/trade/v3/transaction/query`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, sign: paynicornSign(content, cfg.merchant_secret as string), appKey: cfg.app_key }),
    });
    const j = await safeJson(res);
    const code = String(j.responseCode ?? "");
    if (code === PAYNICORN_OK) return { ok: true, status: "valid", detail: "PayX accepted the app key and merchant secret." };
    if (code === "204004" || code === "204005") return { ok: false, status: "invalid", detail: "PayX rejected the signature — check the merchant secret." };
    if (code === "204002" || code === "204003") return { ok: false, status: "invalid", detail: "PayX did not recognise the app key." };
    if (code === "204006") return { ok: false, status: "invalid", detail: "The PayX app used up its test-mode requests — reset them in the PayX console." };
    if (!res.ok) return { ok: false, status: "unreachable", detail: `PayX HTTP ${res.status}` };
    return { ok: false, status: "invalid", detail: `PayX answered ${code || "an unexpected response"}.` };
  } catch (e) { return { ok: false, status: "unreachable", detail: `PayX unreachable: ${String((e as Error).message).slice(0, 120)}` }; }
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
  megapay: testMegapay, paystack: testPaystack, payhero: testPayhero, binance: testBinance, paynicorn: testPaynicorn,
};

/** Run the safe probe for a provider using the merged (settings + decrypted secrets) config. */
export async function testConnection(code: string, cfg: Record<string, string>, fetchImpl: Fetch = fetch): Promise<ConnResult> {
  getSchema(code); // throws PROVIDER_NOT_CONFIGURABLE for unknown codes
  const probe = PROBES[code];
  if (!probe) return { ok: false, status: "not_configured", detail: "No connectivity test for this provider." };
  // SSRF guard: a caller-supplied base URL is the only attacker-influenced input that becomes an
  // outbound target (with the live secret attached). Reject an unsafe one up front — before the probe
  // fetches — rather than in each provider branch. Empty => the provider's known public default is used.
  try {
    assertSafeGatewayUrl(cfg.base_url);
    assertSafeGatewayUrl(cfg.api_base);
  } catch {
    return { ok: false, status: "invalid", detail: "Base URL must be a public https:// address." };
  }
  return probe(cfg, fetchImpl);
}
