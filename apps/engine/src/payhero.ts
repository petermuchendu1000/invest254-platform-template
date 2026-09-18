import type { Cents } from "@invest254/shared";

/**
 * PayHero (Lipwa API, payhero.co.ke) provider abstraction — a third deposit rail alongside Daraja + Mega Pay.
 *
 * Same shape as megapay.ts/daraja.ts: the service depends only on the `PayHeroClient` interface; money
 * correctness lives in the DB RPCs (fn_complete_deposit), not here. `StubPayHeroClient` is deterministic
 * for tests/dev; `HttpPayHeroClient` talks to the real API and is selected only when credentials are configured.
 *
 * PayHero contract (verified against the official docs, 2026-09 — docs.payhero.co.ke):
 *   Auth: Basic Auth — `Authorization: Basic <token>` (token = base64(apiUsername:apiPassword)).
 *   POST {base}/payments               {amount:int(KES), phone_number:"07…", channel_id:int, provider:"m-pesa",
 *                                        external_reference, callback_url?}
 *        -> 201 {success:true, status:"QUEUED", reference:"E8UWT7CLUW", CheckoutRequestID:"ws_CO_…"}
 *   GET  {base}/transaction-status?reference=<reference|mpesaCode>
 *        -> {status:"QUEUED"|"SUCCESS"|"FAILED", success, provider_reference:"<MPESA code>", ...}
 *
 * We store PayHero's `reference` in transactions.checkout_request_id and settle through the SAME idempotent
 * fn_complete_deposit as Daraja/Mega Pay. Amounts cross as integer cents -> whole KES at the edge; the MSISDN
 * is sent in PayHero's canonical local `07XXXXXXXX` form.
 */
export interface PayHeroStkArgs { amountCents: Cents; msisdn: string; externalReference: string; customerName?: string; }
export interface PayHeroStkResult { reference: string; checkoutRequestId: string; }
/** Normalised status: resultCode 0 when paid, non-zero when failed, null while still processing. */
export interface PayHeroStatusResult { resultCode: number | null; processing: boolean; receipt: string | null; }

export interface PayHeroClient {
  initiateStk(a: PayHeroStkArgs): Promise<PayHeroStkResult>;
  /** Authoritative server-to-server status check — used to verify callbacks and to reconcile. */
  queryStatus(reference: string): Promise<PayHeroStatusResult>;
}

const centsToKes = (c: Cents): number => Math.round(c / 100);

/** Format any Kenyan MSISDN to PayHero's local 07XXXXXXXX form (accepts 2547…, +2547…, 7…, 07…). */
export function toLocalMsisdn(raw: string): string {
  const d = String(raw ?? "").replace(/[^\d]/g, "");
  if (d.startsWith("254")) return "0" + d.slice(3);
  if (d.startsWith("0")) return d;
  if (d.length === 9) return "0" + d; // 7XXXXXXXX
  return d;
}

/** Map a PayHero `status` (+ optional MPESA receipt) to the shared {resultCode, processing, receipt}. */
export function mapPayHeroStatus(status: string, receipt: string | null): PayHeroStatusResult {
  const s = String(status ?? "").trim().toUpperCase();
  const clean = receipt && receipt !== "N/A" ? receipt : null;
  if (s === "SUCCESS" || s === "COMPLETED" || s === "SUCCESSFUL") return { resultCode: 0, processing: false, receipt: clean };
  if (s === "FAILED" || s === "CANCELLED" || s === "CANCELED" || s === "REVERSED" || s === "DECLINED") return { resultCode: 1, processing: false, receipt: null };
  // QUEUED / PENDING / unknown -> not yet resolvable; do NOT credit, retry later.
  return { resultCode: null, processing: true, receipt: null };
}

/** Deterministic in-process stub — no network. Used in tests and local dev. */
export class StubPayHeroClient implements PayHeroClient {
  private n = 0;
  async initiateStk(_a: PayHeroStkArgs): Promise<PayHeroStkResult> {
    const i = ++this.n;
    return { reference: `stub-ph-ref-${i}`, checkoutRequestId: `ws_CO_stub_${i}` };
  }
  async queryStatus(_reference: string): Promise<PayHeroStatusResult> {
    return { resultCode: 0, processing: false, receipt: "STUBRCPT" };
  }
}

export interface PayHeroConfig {
  /** API base (no trailing slash). Default backend.payhero.co.ke/api/v2; override via env/DB. */
  baseUrl: string;
  /** Ready-to-use Basic Auth token (base64 of apiUsername:apiPassword), WITHOUT the leading "Basic ". */
  basicAuthToken: string;
  /** Registered payment channel id (required to route the STK). */
  channelId: string;
  /** Optional callback URL PayHero posts the result to. */
  callbackUrl?: string;
}

const DEFAULT_BASE = "https://backend.payhero.co.ke/api/v2";

/**
 * Real PayHero client. Basic-auth (token in the Authorization header). Network errors propagate to the
 * caller, which leaves the transaction pending for the reconcile job — exactly like Daraja/Mega Pay.
 */
export class HttpPayHeroClient implements PayHeroClient {
  constructor(private readonly cfg: PayHeroConfig, private readonly fetchImpl: typeof fetch = fetch) {}
  private base(): string { return this.cfg.baseUrl.replace(/\/+$/, ""); }
  private authHeader(): string { const t = this.cfg.basicAuthToken.replace(/^basic\s+/i, ""); return `Basic ${t}`; }

  async initiateStk(a: PayHeroStkArgs): Promise<PayHeroStkResult> {
    const body: Record<string, unknown> = {
      amount: centsToKes(a.amountCents),
      phone_number: toLocalMsisdn(a.msisdn),
      channel_id: Number(this.cfg.channelId),
      provider: "m-pesa",
      external_reference: a.externalReference,
    };
    if (a.customerName) body.customer_name = a.customerName;
    if (this.cfg.callbackUrl) body.callback_url = this.cfg.callbackUrl;
    const res = await this.fetchImpl(`${this.base()}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authHeader() },
      body: JSON.stringify(body),
    });
    const j: any = await res.json().catch(() => ({}));
    const reference = j.reference ?? j.Reference;
    if (!res.ok || j.success === false || !reference) {
      throw new Error(`PAYHERO_INITIATE_REJECTED_${res.status}:${JSON.stringify(j).slice(0, 300)}`);
    }
    return { reference: String(reference), checkoutRequestId: String(j.CheckoutRequestID ?? j.checkoutRequestId ?? reference) };
  }

  async queryStatus(reference: string): Promise<PayHeroStatusResult> {
    const res = await this.fetchImpl(`${this.base()}/transaction-status?reference=${encodeURIComponent(reference)}`, {
      method: "GET", headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) return { resultCode: null, processing: true, receipt: null }; // transient -> retry, never credit
    const status = String(j.status ?? "");
    const receipt = j.provider_reference != null && j.provider_reference !== "" ? String(j.provider_reference) : null;
    return mapPayHeroStatus(status, receipt);
  }
}

/**
 * Fail-on-use client for env=configured-but-incomplete (mirrors UnconfiguredMegaPayClient): every call fails
 * loudly with PAYHERO_NOT_CONFIGURED so a deposit surfaces an error / reconcile records an error — NEVER a
 * phantom credit — until an admin supplies the missing secret.
 */
export class UnconfiguredPayHeroClient implements PayHeroClient {
  constructor(private readonly missing: readonly string[] = []) {}
  private fail(): never { throw new Error(`PAYHERO_NOT_CONFIGURED${this.missing.length ? `:${this.missing.join(",")}` : ""}`); }
  async initiateStk(_a: PayHeroStkArgs): Promise<PayHeroStkResult> { return this.fail(); }
  async queryStatus(_r: string): Promise<PayHeroStatusResult> { return this.fail(); }
}

/** The credentials the real PayHero path cannot run without. Empty array = fully configured. */
export function missingPayHeroCredentials(cfg: PayHeroConfig): string[] {
  const missing: string[] = [];
  if (!cfg.basicAuthToken) missing.push("basic_auth_token");
  if (!cfg.channelId) missing.push("channel_id");
  return missing;
}

export function resolvePayHeroConfig(over: Partial<PayHeroConfig> = {}, env: NodeJS.ProcessEnv = process.env): PayHeroConfig {
  const callbackUrl = over.callbackUrl ?? env.PAYHERO_CALLBACK_URL;
  return {
    baseUrl: over.baseUrl ?? env.PAYHERO_API_BASE ?? DEFAULT_BASE,
    basicAuthToken: over.basicAuthToken ?? env.PAYHERO_BASIC_AUTH_TOKEN ?? "",
    channelId: over.channelId ?? env.PAYHERO_CHANNEL_ID ?? "",
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

/** Build the real client when credentials resolve; else Unconfigured (fails loudly) / Stub (dev). */
export function makePayHeroClientFromConfig(over: Partial<PayHeroConfig> = {}, env: NodeJS.ProcessEnv = process.env): PayHeroClient {
  const cfg = resolvePayHeroConfig(over, env);
  const missing = missingPayHeroCredentials(cfg);
  if (missing.length === 0) return new HttpPayHeroClient(cfg);
  if (env.NODE_ENV === "production") {
    console.error(`[payments] PayHero credentials incomplete (missing: ${missing.join(", ")}) — refusing the stub; PayHero deposits fail until configured.`);
    return new UnconfiguredPayHeroClient(missing);
  }
  console.warn(`[payments] PayHero credentials not configured (missing: ${missing.join(", ")}) — using StubPayHeroClient.`);
  return new StubPayHeroClient();
}

export function makePayHeroClient(env: NodeJS.ProcessEnv = process.env): PayHeroClient {
  return makePayHeroClientFromConfig({}, env);
}

/** Resolver returning a partial PayHero config (e.g. from the encrypted DB config store). */
export type PayHeroConfigResolver = () => Promise<Partial<PayHeroConfig> | null>;

/**
 * PayHero client that layers DB config OVER env with env as the guaranteed fallback (mirrors
 * ConfiguredMegaPayClient): no DB row / resolver error -> env; complete DB override -> DB config drives
 * the live rail. The built client is cached by a config fingerprint so the hot path doesn't rebuild it.
 */
export class ConfiguredPayHeroClient implements PayHeroClient {
  private cache?: { fp: string; client: PayHeroClient };
  constructor(private readonly resolver: PayHeroConfigResolver, private readonly env: NodeJS.ProcessEnv = process.env) {}
  private async pick(): Promise<PayHeroClient> {
    let over: Partial<PayHeroConfig> = {};
    try { over = (await this.resolver()) ?? {}; } catch { over = {}; }
    const clean: Partial<PayHeroConfig> = {};
    if (over.baseUrl) clean.baseUrl = over.baseUrl;
    if (over.basicAuthToken) clean.basicAuthToken = over.basicAuthToken;
    if (over.channelId) clean.channelId = over.channelId;
    if (over.callbackUrl) clean.callbackUrl = over.callbackUrl;
    const cfg = resolvePayHeroConfig(clean, this.env);
    const fp = `${cfg.baseUrl}|${cfg.basicAuthToken}|${cfg.channelId}|${cfg.callbackUrl ?? ""}`;
    if (!this.cache || this.cache.fp !== fp) this.cache = { fp, client: makePayHeroClientFromConfig(clean, this.env) };
    return this.cache.client;
  }
  async initiateStk(a: PayHeroStkArgs): Promise<PayHeroStkResult> { return (await this.pick()).initiateStk(a); }
  async queryStatus(reference: string): Promise<PayHeroStatusResult> { return (await this.pick()).queryStatus(reference); }
}
