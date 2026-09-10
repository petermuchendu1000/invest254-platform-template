import type { Cents } from "@invest254/shared";

/**
 * Mega Pay (megapay.co.ke) provider abstraction — a second deposit rail alongside Daraja.
 *
 * Same shape as daraja.ts: the service depends only on the `MegaPayClient` interface; money
 * correctness lives in the DB RPCs, not here. `StubMegaPayClient` is deterministic for tests/dev;
 * `HttpMegaPayClient` talks to the real API and is selected only when credentials are configured.
 *
 * Mega Pay contract (verified against the live sandbox on 2026-09-10):
 *   POST {base}/initiatestk        {api_key, email, amount, msisdn, reference}
 *        -> {ResponseCode:"0", success:"200", transaction_request_id, CheckoutRequestID, MerchantRequestID, environment}
 *   POST {base}/transactionstatus  {api_key, email, transaction_request_id}
 *        -> {ResultCode, ResultDesc, TransactionStatus:"Pending"|"Completed"|..., TransactionCode, TransactionReceipt, ...}
 * NOTE: `ResultCode` on the STATUS endpoint reports whether the QUERY succeeded (200), NOT the payment
 * outcome — the payment outcome is `TransactionStatus`. We map it to the same {resultCode, processing}
 * shape Daraja's stkPushQuery uses so the settlement/reconcile code paths stay identical.
 *
 * Amounts cross the boundary as integer cents and are converted to WHOLE KES (Mega Pay's unit) at the
 * edge. The Kenyan MSISDN is sent in the canonical local `07XXXXXXXX` form (Mega Pay accepts it and
 * echoes back the 2547… form).
 */
export interface MegaStkArgs { amountCents: Cents; msisdn: string; reference: string; }
export interface MegaStkResult { transactionRequestId: string; checkoutRequestId: string; merchantRequestId: string; }
/**
 * Normalised status of a Mega Pay checkout. `resultCode` is 0 when paid (TransactionStatus=Completed),
 * a non-zero sentinel when definitively failed/cancelled, and null while still processing. `processing`
 * is true while the prompt is outstanding (Pending) or the status is not yet resolvable — in which case
 * the caller must NOT credit and should retry (mirrors Daraja's `StkQueryResult`).
 */
export interface MegaStatusResult { resultCode: number | null; processing: boolean; receipt: string | null; }

export interface MegaPayClient {
  initiateStk(a: MegaStkArgs): Promise<MegaStkResult>;
  /** Authoritative server-to-server status check — used to verify callbacks and to reconcile. */
  queryStatus(transactionRequestId: string): Promise<MegaStatusResult>;
}

const centsToKes = (c: Cents): number => Math.round(c / 100);

/** Terminal Mega Pay statuses that mean the money did NOT arrive. */
const FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "timeout", "timedout", "reversed", "declined", "insufficient"]);

/** Map a Mega Pay `TransactionStatus` (+ optional receipt) to the shared {resultCode, processing}. */
export function mapMegaStatus(transactionStatus: string, receipt: string | null): MegaStatusResult {
  const s = String(transactionStatus ?? "").trim().toLowerCase();
  const cleanReceipt = receipt && receipt !== "N/A" ? receipt : null;
  if (s === "completed" || s === "success" || s === "successful" || s === "paid") {
    return { resultCode: 0, processing: false, receipt: cleanReceipt };
  }
  if (FAILED_STATUSES.has(s)) return { resultCode: 1, processing: false, receipt: null };
  // pending / processing / queued / unknown / not-yet-found -> do NOT credit; retry later.
  return { resultCode: null, processing: true, receipt: null };
}

/** Deterministic in-process stub — no network. Used in tests and local dev. */
export class StubMegaPayClient implements MegaPayClient {
  private n = 0;
  async initiateStk(_a: MegaStkArgs): Promise<MegaStkResult> {
    const i = ++this.n;
    return { transactionRequestId: `stub-mp-trid-${i}`, checkoutRequestId: `stub-mp-co-${i}`, merchantRequestId: `stub-mp-mr-${i}` };
  }
  async queryStatus(_transactionRequestId: string): Promise<MegaStatusResult> {
    return { resultCode: 0, processing: false, receipt: "STUBRCPT" };
  }
}

export interface MegaPayConfig {
  env: "sandbox" | "production";
  apiKey: string;
  email: string;
  /** API base (no trailing slash). Sandbox + production both verified at .../backend/v2; override via env. */
  baseUrl: string;
}

const DEFAULT_BASE = "https://megapay.co.ke/backend/v2";

/**
 * Real Mega Pay client. No OAuth — the api_key + email travel in each JSON body. Network errors
 * propagate to the caller, which leaves the transaction in its pre-call state (pending) for the
 * reconciliation job — exactly like the Daraja client.
 */
export class HttpMegaPayClient implements MegaPayClient {
  constructor(private readonly cfg: MegaPayConfig, private readonly fetchImpl: typeof fetch = fetch) {}
  private base(): string { return this.cfg.baseUrl.replace(/\/+$/, ""); }

  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`${this.base()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.cfg.apiKey, email: this.cfg.email, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`MEGAPAY_${path}_${res.status}:${JSON.stringify(j)}`);
    return j;
  }

  async initiateStk(a: MegaStkArgs): Promise<MegaStkResult> {
    const j = await this.post("/initiatestk", {
      amount: String(centsToKes(a.amountCents)),
      msisdn: a.msisdn,
      reference: a.reference,
    });
    // Success is ResponseCode "0" (string). Anything else is a provider-side rejection.
    const code = String(j.ResponseCode ?? j.responseCode ?? "");
    const trid = j.transaction_request_id ?? j.TransactionRequestID ?? j.transactionRequestId;
    if (code !== "0" || !trid) {
      throw new Error(`MEGAPAY_INITIATE_REJECTED:${JSON.stringify(j).slice(0, 300)}`);
    }
    return {
      transactionRequestId: String(trid),
      checkoutRequestId: String(j.CheckoutRequestID ?? j.checkoutRequestId ?? trid),
      merchantRequestId: String(j.MerchantRequestID ?? j.merchantRequestId ?? ""),
    };
  }

  async queryStatus(transactionRequestId: string): Promise<MegaStatusResult> {
    const j = await this.post("/transactionstatus", { transaction_request_id: transactionRequestId });
    // ResultCode "102" (and similar) = the query itself failed / tx not found yet -> treat as processing.
    const queryCode = String(j.ResultCode ?? "");
    const status = String(j.TransactionStatus ?? "");
    if (queryCode === "102" || (!status && !j.TransactionStatus)) {
      return { resultCode: null, processing: true, receipt: null };
    }
    return mapMegaStatus(status, j.TransactionReceipt != null ? String(j.TransactionReceipt) : null);
  }
}

/**
 * Fail-on-use client for the DANGEROUS state where env=production but Mega Pay credentials are
 * incomplete. Mirrors `UnconfiguredDarajaClient`: returning the stub here would be catastrophic
 * (its `queryStatus` reports success, so reconcile would CREDIT unpaid deposits). Instead every call
 * fails loudly with `MEGAPAY_NOT_CONFIGURED`, so a deposit surfaces an error and reconcile records an
 * error — never a phantom credit — until an admin supplies the missing secret.
 */
export class UnconfiguredMegaPayClient implements MegaPayClient {
  constructor(private readonly missing: readonly string[] = []) {}
  private fail(): never { throw new Error(`MEGAPAY_NOT_CONFIGURED${this.missing.length ? `:${this.missing.join(",")}` : ""}`); }
  async initiateStk(_a: MegaStkArgs): Promise<MegaStkResult> { return this.fail(); }
  async queryStatus(_t: string): Promise<MegaStatusResult> { return this.fail(); }
}

/** Resolve Mega Pay config from env (DB per-brand overrides can layer on later, like Daraja). */
export function resolveMegaPayConfig(over: Partial<MegaPayConfig> = {}, env: NodeJS.ProcessEnv = process.env): MegaPayConfig {
  return {
    env: over.env ?? (env.MEGAPAY_ENV as MegaPayConfig["env"]) ?? "sandbox",
    apiKey: over.apiKey ?? env.MEGAPAY_API_KEY ?? "",
    email: over.email ?? env.MEGAPAY_EMAIL ?? "",
    baseUrl: over.baseUrl ?? env.MEGAPAY_API_BASE ?? DEFAULT_BASE,
  };
}

/** The two credentials the real Mega Pay path cannot run without. Empty array = fully configured. */
export function missingMegaPayCredentials(cfg: MegaPayConfig): string[] {
  const missing: string[] = [];
  if (!cfg.apiKey) missing.push("apiKey");
  if (!cfg.email) missing.push("email");
  return missing;
}

/**
 * Build the real client when credentials resolve. When incomplete: in `production` return a client
 * that FAILS LOUDLY on use (never a silent stub that could phantom-credit); in sandbox/dev return the
 * deterministic stub so tests and local runs stay offline and deterministic.
 */
export function makeMegaPayClientFromConfig(over: Partial<MegaPayConfig> = {}, env: NodeJS.ProcessEnv = process.env): MegaPayClient {
  const cfg = resolveMegaPayConfig(over, env);
  const missing = missingMegaPayCredentials(cfg);
  if (missing.length === 0) return new HttpMegaPayClient(cfg);
  if (cfg.env === "production") {
    console.error(
      `[payments] Mega Pay env=production but credentials incomplete (missing: ${missing.join(", ")}) — ` +
      `refusing to fall back to the stub. Mega Pay deposits will fail with MEGAPAY_NOT_CONFIGURED ` +
      `until the missing secret(s) are set, so no unpaid deposit can be credited.`,
    );
    return new UnconfiguredMegaPayClient(missing);
  }
  console.warn(`[payments] Mega Pay credentials not configured (missing: ${missing.join(", ")}) — using StubMegaPayClient (no real Mega Pay calls).`);
  return new StubMegaPayClient();
}

/** Build the Mega Pay client from env only when fully configured; otherwise the deterministic stub. */
export function makeMegaPayClient(env: NodeJS.ProcessEnv = process.env): MegaPayClient {
  return makeMegaPayClientFromConfig({}, env);
}
