import type { Cents } from "@invest254/shared";
import { msisdnToE164 } from "@invest254/shared";

/**
 * Daraja (Safaricom M-Pesa) provider abstraction. The engine/service depend only on this
 * interface; correctness lives in the DB RPCs, not here. StubDarajaClient is deterministic
 * for tests/dev; HttpDarajaClient talks to the real API and is selected only when credentials
 * are configured. Amounts cross the boundary as integer cents and are converted to whole KES
 * (Daraja's unit) at the edge.
 */
export interface StkPushArgs { amountCents: Cents; msisdn: string; accountRef: string; desc: string; }
export interface StkPushResult { merchantRequestId: string; checkoutRequestId: string; }
export interface B2cArgs { amountCents: Cents; msisdn: string; remarks: string; resultId?: string; }
export interface B2cResult { conversationId: string; }
/**
 * Result of an STKPushQuery. `resultCode` is Safaricom's finalized code (0 = paid) once the
 * prompt has resolved; `processing` is true while the prompt is still outstanding (Daraja
 * returns errorCode 500.001.1001), in which case the caller should retry rather than settle.
 */
export interface StkQueryResult { resultCode: number | null; processing: boolean; }

export interface DarajaClient {
  stkPush(a: StkPushArgs): Promise<StkPushResult>;
  /** Authoritative server-to-server status check for a checkout — used to verify callbacks. */
  stkPushQuery(checkoutRequestId: string): Promise<StkQueryResult>;
  b2cPayment(a: B2cArgs): Promise<B2cResult>;
}

const centsToKes = (c: Cents): number => Math.round(c / 100);

/** Deterministic in-process stub — no network. Used in tests and local dev. */
export class StubDarajaClient implements DarajaClient {
  private n = 0;
  async stkPush(_a: StkPushArgs): Promise<StkPushResult> {
    const i = ++this.n;
    return { merchantRequestId: `stub-mr-${i}`, checkoutRequestId: `stub-co-${i}` };
  }
  async stkPushQuery(_checkoutRequestId: string): Promise<StkQueryResult> {
    return { resultCode: 0, processing: false };
  }
  async b2cPayment(_a: B2cArgs): Promise<B2cResult> {
    const i = ++this.n;
    return { conversationId: `stub-conv-${i}` };
  }
}

export interface DarajaConfig {
  env: "sandbox" | "production";
  consumerKey: string; consumerSecret: string;
  shortcode: string; passkey: string; stkCallbackUrl: string;
  b2cInitiator: string; b2cSecurityCredential: string; b2cResultUrl: string; b2cTimeoutUrl: string;
  /** STK rail: 'paybill' (CustomerPayBillOnline, default) or 'till'/Buy Goods (CustomerBuyGoodsOnline). */
  transactionType?: "paybill" | "till";
  /** Till/store number used as STK PartyB when transactionType='till' (defaults to shortcode). */
  tillNumber?: string;
  /** B2C PartyA shortcode when different from the STK shortcode (defaults to shortcode). */
  b2cShortcode?: string;
  /** B2C CommandID: BusinessPayment (default), SalaryPayment, or PromotionPayment. */
  b2cCommandId?: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
}

const BASES = { sandbox: "https://sandbox.safaricom.co.ke", production: "https://api.safaricom.co.ke" } as const;
const ts = (d = new Date()): string =>
  `${d.getFullYear()}${`${d.getMonth() + 1}`.padStart(2, "0")}${`${d.getDate()}`.padStart(2, "0")}` +
  `${`${d.getHours()}`.padStart(2, "0")}${`${d.getMinutes()}`.padStart(2, "0")}${`${d.getSeconds()}`.padStart(2, "0")}`;

/**
 * Real Daraja client. OAuth token cached ~55 min; STK Push (CustomerPayBillOnline) for deposits,
 * B2C (BusinessPayment) for withdrawals — per docs/08. Network errors propagate to the caller,
 * which leaves the transaction in its pre-call state (pending) for the reconciliation job.
 */
export class HttpDarajaClient implements DarajaClient {
  private token?: { value: string; expiresAtMs: number };
  constructor(private readonly cfg: DarajaConfig, private readonly fetchImpl: typeof fetch = fetch) {}
  private base(): string { return BASES[this.cfg.env]; }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAtMs) return this.token.value;
    const auth = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`DARAJA_OAUTH_${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in?: string };
    this.token = { value: j.access_token, expiresAtMs: Date.now() + 55 * 60_000 };
    return this.token.value;
  }
  private async post(path: string, body: unknown): Promise<any> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.base()}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`DARAJA_${path}_${res.status}:${JSON.stringify(j)}`);
    return j;
  }

  async stkPush(a: StkPushArgs): Promise<StkPushResult> {
    const t = ts();
    const e164 = msisdnToE164(a.msisdn); // Safaricom requires 254XXXXXXXXX
    const password = Buffer.from(`${this.cfg.shortcode}${this.cfg.passkey}${t}`).toString("base64");
    const isTill = this.cfg.transactionType === "till";
    const j = await this.post("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: this.cfg.shortcode, Password: password, Timestamp: t,
      TransactionType: isTill ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline", Amount: centsToKes(a.amountCents),
      PartyA: e164, PartyB: isTill ? (this.cfg.tillNumber || this.cfg.shortcode) : this.cfg.shortcode, PhoneNumber: e164,
      CallBackURL: this.cfg.stkCallbackUrl, AccountReference: a.accountRef, TransactionDesc: a.desc,
    });
    return { merchantRequestId: String(j.MerchantRequestID), checkoutRequestId: String(j.CheckoutRequestID) };
  }
  /**
   * STKPushQuery — the authoritative status of a checkout, straight from Safaricom. Used to
   * verify STK callbacks: a client can forge a POST to the public callback URL, but it cannot
   * make this query return success for a prompt that was never paid. While the prompt is still
   * outstanding Daraja replies with errorCode 500.001.1001 (often HTTP 500) -> `processing`.
   */
  async stkPushQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const t = ts();
    const password = Buffer.from(`${this.cfg.shortcode}${this.cfg.passkey}${t}`).toString("base64");
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.base()}/mpesa/stkpushquery/v1/query`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ BusinessShortCode: this.cfg.shortcode, Password: password, Timestamp: t, CheckoutRequestID: checkoutRequestId }),
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (j && j.ResultCode != null) return { resultCode: Number(j.ResultCode), processing: false };
    if (j && String(j.errorCode ?? "") === "500.001.1001") return { resultCode: null, processing: true };
    throw new Error(`DARAJA_STKQUERY_${res.status}:${JSON.stringify(j)}`);
  }
  async b2cPayment(a: B2cArgs): Promise<B2cResult> {
    // B2C payouts need their OWN initiator + security credential (separate from the STK-Push creds).
    // If they're not set, FAIL LOUDLY here instead of POSTing empty creds to Safaricom — which is
    // silently rejected and strands the withdrawal in 'processing' with no result callback (BUGLOG #36).
    const missB2c = missingB2cCredentials(this.cfg);
    if (missB2c.length) throw new Error(`MPESA_B2C_NOT_CONFIGURED:${missB2c.join(",")}`);
    // The B2C result route is keyed by transaction id (`/withdrawals/mpesa/result/:txId`), so when a
    // resultId is supplied we append it to the configured base URL and Safaricom POSTs the result to
    // that exact path. Without a resultId we fall back to the raw configured URL (legacy behaviour).
    const base = this.cfg.b2cResultUrl.replace(/\/+$/, "");
    const resultUrl = a.resultId ? `${base}/${encodeURIComponent(a.resultId)}` : this.cfg.b2cResultUrl;
    const j = await this.post("/mpesa/b2c/v1/paymentrequest", {
      InitiatorName: this.cfg.b2cInitiator, SecurityCredential: this.cfg.b2cSecurityCredential,
      CommandID: this.cfg.b2cCommandId || "BusinessPayment", Amount: centsToKes(a.amountCents),
      PartyA: this.cfg.b2cShortcode || this.cfg.shortcode, PartyB: msisdnToE164(a.msisdn), Remarks: a.remarks,
      QueueTimeOutURL: this.cfg.b2cTimeoutUrl, ResultURL: resultUrl, Occasion: "Withdrawal",
    });
    return { conversationId: String(j.ConversationID) };
  }
}

/** Resolve the full Daraja config by layering DB overrides over env defaults (DB wins per field). */
export function resolveDarajaConfig(over: Partial<DarajaConfig>, env: NodeJS.ProcessEnv): DarajaConfig {
  const pick = (k: keyof DarajaConfig, envKey: string): string =>
    (over[k] as string | undefined) ?? env[envKey] ?? "";
  return {
    env: over.env ?? (env.MPESA_ENV as DarajaConfig["env"]) ?? "sandbox",
    consumerKey: pick("consumerKey", "MPESA_CONSUMER_KEY"),
    consumerSecret: pick("consumerSecret", "MPESA_CONSUMER_SECRET"),
    shortcode: pick("shortcode", "MPESA_SHORTCODE"),
    passkey: pick("passkey", "MPESA_PASSKEY"),
    stkCallbackUrl: pick("stkCallbackUrl", "MPESA_STK_CALLBACK_URL"),
    b2cInitiator: pick("b2cInitiator", "MPESA_B2C_INITIATOR"),
    b2cSecurityCredential: pick("b2cSecurityCredential", "MPESA_B2C_SECURITY_CREDENTIAL"),
    b2cResultUrl: pick("b2cResultUrl", "MPESA_B2C_RESULT_URL"),
    b2cTimeoutUrl: pick("b2cTimeoutUrl", "MPESA_B2C_TIMEOUT_URL"),
    // PAY-0 (BUGLOG #62): the Paybill/Till rail, till number, separate B2C shortcode and B2C CommandID
    // were loaded from mpesa_config but DROPPED here, so a Till brand's STK went out as a Paybill
    // request and B2C always paid from the STK shortcode. Carried through now (DB, else env, else the
    // client's defaults).
    ...optionalDaraja(over, env),
  };
}

function optionalDaraja(over: Partial<DarajaConfig>, env: NodeJS.ProcessEnv): Partial<DarajaConfig> {
  const out: Partial<DarajaConfig> = {};
  const tt = over.transactionType ?? env.MPESA_TRANSACTION_TYPE;
  if (tt === "paybill" || tt === "till") out.transactionType = tt;
  const till = over.tillNumber ?? env.MPESA_TILL_NUMBER;
  if (till) out.tillNumber = till;
  const b2cSc = over.b2cShortcode ?? env.MPESA_B2C_SHORTCODE;
  if (b2cSc) out.b2cShortcode = b2cSc;
  const cmd = over.b2cCommandId ?? env.MPESA_B2C_COMMAND_ID;
  if (cmd === "BusinessPayment" || cmd === "SalaryPayment" || cmd === "PromotionPayment") out.b2cCommandId = cmd;
  return out;
}

/**
 * Fail-on-use client for the DANGEROUS state where the resolved environment is `production` but the
 * Daraja credentials are incomplete (e.g. an admin rotated the shortcode/consumer keys but never set
 * the matching Lipa na M-Pesa passkey). Returning the deterministic StubDarajaClient here would be
 * catastrophic: its `stkPushQuery` reports success, so the reconciliation sweep (`reconcileDeposits`)
 * would CREDIT deposits that were never paid, and `initiateDeposit` would return a fake checkout id
 * with no prompt ever sent. Instead every call fails loudly with `MPESA_NOT_CONFIGURED`, so a deposit
 * surfaces an error to the player and reconcile records an error — never a phantom credit — until an
 * admin supplies the missing secret. Preferred over the stub ONLY in production; sandbox/dev keep the
 * stub so tests and local runs stay deterministic and offline.
 */
export class UnconfiguredDarajaClient implements DarajaClient {
  constructor(private readonly missing: readonly string[] = []) {}
  private fail(): never {
    throw new Error(`MPESA_NOT_CONFIGURED${this.missing.length ? `:${this.missing.join(",")}` : ""}`);
  }
  async stkPush(_a: StkPushArgs): Promise<StkPushResult> { return this.fail(); }
  async stkPushQuery(_checkoutRequestId: string): Promise<StkQueryResult> { return this.fail(); }
  async b2cPayment(_a: B2cArgs): Promise<B2cResult> { return this.fail(); }
}

/** The four credentials the real STK-Push / B2C path cannot run without. Empty array = fully configured. */
export function missingDarajaCredentials(cfg: DarajaConfig): string[] {
  const missing: string[] = [];
  if (!cfg.consumerKey) missing.push("consumerKey");
  if (!cfg.consumerSecret) missing.push("consumerSecret");
  if (!cfg.shortcode) missing.push("shortcode");
  if (!cfg.passkey) missing.push("passkey");
  return missing;
}

/**
 * The B2C-specific credentials a withdrawal PAYOUT cannot run without. These are separate from the
 * STK-Push creds above: a brand can have STK (deposits) fully working while B2C (payouts) is
 * unconfigured, in which case every approved withdrawal would strand in 'processing'. Empty = ready.
 */
export function missingB2cCredentials(cfg: DarajaConfig): string[] {
  const missing: string[] = [];
  if (!cfg.b2cInitiator) missing.push("b2cInitiator");
  if (!cfg.b2cSecurityCredential) missing.push("b2cSecurityCredential");
  if (!cfg.b2cResultUrl) missing.push("b2cResultUrl");
  if (!cfg.b2cTimeoutUrl) missing.push("b2cTimeoutUrl");
  return missing;
}

/**
 * Build the real client when the four required credentials resolve (DB config preferred, env as
 * fallback). When incomplete: in `production` return a client that FAILS LOUDLY on use (never a
 * silent stub that could phantom-credit unpaid deposits); in sandbox/dev return the deterministic
 * stub. `over` carries admin-managed DB values; pass `{}` (the default) for pure env behaviour.
 */
export function makeDarajaClientFromConfig(over: Partial<DarajaConfig> = {}, env: NodeJS.ProcessEnv = process.env): DarajaClient {
  const cfg = resolveDarajaConfig(over, env);
  const missing = missingDarajaCredentials(cfg);
  if (missing.length === 0) {
    // STK is ready; warn (once per build/reload) if B2C payouts are NOT — surfaces in System logs so
    // an operator sees WHY withdrawals stall instead of a silent Safaricom rejection (BUGLOG #36).
    const missB2c = missingB2cCredentials(cfg);
    if (missB2c.length) {
      console.warn(`[payments] Daraja STK is configured but B2C payouts are NOT (missing: ${missB2c.join(", ")}) — approved withdrawals will fail with MPESA_B2C_NOT_CONFIGURED until these are set (Admin → M-Pesa).`);
    }
    return new HttpDarajaClient(cfg);
  }
  if (cfg.env === "production") {
    console.error(
      `[payments] Daraja env=production but credentials incomplete (missing: ${missing.join(", ")}) — ` +
      `refusing to fall back to the stub. Deposits/withdrawals will fail with MPESA_NOT_CONFIGURED ` +
      `until the missing secret(s) are set, so no unpaid deposit can be credited.`,
    );
    return new UnconfiguredDarajaClient(missing);
  }
  console.warn(`[payments] Daraja credentials not configured (missing: ${missing.join(", ")}) — using StubDarajaClient (no real M-Pesa calls).`);
  return new StubDarajaClient();
}

/** Build the real client from env only when fully configured; otherwise the deterministic stub. */
export function makeDarajaClient(env: NodeJS.ProcessEnv = process.env): DarajaClient {
  return makeDarajaClientFromConfig({}, env);
}

/**
 * PAY-2 (docs/45): register the C2B Confirmation / Validation URLs for a Pay Bill or Till with Safaricom
 * (Daraja C2B RegisterURL v2). Without this, Safaricom never tells us about payments made from the M-PESA
 * menu, so the manual Pay Bill rail cannot verify anything. Uses the app's consumer key/secret (the same
 * Daraja app that owns the shortcode). Returns Safaricom's verdict; never throws for a Safaricom "no".
 */
export interface C2bRegisterArgs { shortCode: string; responseType: "Completed" | "Cancelled"; confirmationUrl: string; validationUrl: string; }
export interface C2bRegisterResult { ok: boolean; message: string }
export async function registerC2bUrls(cfg: Pick<DarajaConfig, "env" | "consumerKey" | "consumerSecret">, a: C2bRegisterArgs, fetchImpl: typeof fetch = fetch): Promise<C2bRegisterResult> {
  if (!cfg.consumerKey || !cfg.consumerSecret) return { ok: false, message: "The M-Pesa consumer key and secret are not set (M-Pesa defaults → Credentials)." };
  const base = BASES[cfg.env];
  const auth = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString("base64");
  let token: string;
  try {
    const t = await fetchImpl(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
    if (!t.ok) return { ok: false, message: `Safaricom refused the app credentials (HTTP ${t.status}).` };
    token = String(((await t.json()) as { access_token?: string }).access_token ?? "");
    if (!token) return { ok: false, message: "Safaricom returned no access token." };
  } catch (e) {
    return { ok: false, message: `Could not reach Safaricom: ${(e as Error).message}` };
  }
  try {
    const res = await fetchImpl(`${base}/mpesa/c2b/v2/registerurl`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ShortCode: a.shortCode, ResponseType: a.responseType, ConfirmationURL: a.confirmationUrl, ValidationURL: a.validationUrl || a.confirmationUrl }),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const code = String(j.ResponseCode ?? j.responseCode ?? "");
    const desc = String(j.ResponseDescription ?? j.errorMessage ?? j.ResponseDesc ?? `HTTP ${res.status}`);
    return res.ok && (code === "0" || code === "00000000" || /success/i.test(desc)) ? { ok: true, message: desc } : { ok: false, message: desc };
  } catch (e) {
    return { ok: false, message: `Could not reach Safaricom: ${(e as Error).message}` };
  }
}
