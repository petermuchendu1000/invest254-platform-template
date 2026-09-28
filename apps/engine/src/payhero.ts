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
export interface PayHeroStkArgs {
  amountCents: Cents; msisdn: string; externalReference: string; customerName?: string;
  /** Mobile-money rail: "m-pesa" (default) or "sasapay" — PayHero routes by provider (official sample). */
  provider?: string;
  /** Optional network code (e.g. "63902" Safaricom) when a channel needs it. */
  networkCode?: string;
}
export interface PayHeroStkResult { reference: string; checkoutRequestId: string; }
/** Normalised status: resultCode 0 when paid, non-zero when failed, null while still processing. */
export interface PayHeroStatusResult { resultCode: number | null; processing: boolean; receipt: string | null; }

/**
 * A settled inbound payment on the PayHero account ledger (GET {base}/transactions). This is the
 * AUTHORITATIVE source for C2B (manual paybill) deposits: a customer pays the PayHero paybill directly,
 * PayHero records it here, and we ingest it — we never trust an unverified callback to mint balance.
 */
export interface PayHeroInboundPayment {
  /** provider_reference — the M-PESA confirmation code (globally unique; the claim key). */
  mpesaCode: string;
  amountCents: Cents;                 // whole KES on the wire -> integer cents
  msisdn: string | null;              // payer phone, parsed from the description
  externalReference: string | null;   // our txId for STK-initiated rows; the customer ref for manual C2B
  reference: string | null;            // PayHero's transaction_reference
  at: string;                          // created_at (ISO)
}

export interface PayHeroClient {
  initiateStk(a: PayHeroStkArgs): Promise<PayHeroStkResult>;
  /** Authoritative server-to-server status check — used to verify callbacks and to reconcile. */
  queryStatus(reference: string): Promise<PayHeroStatusResult>;
  /** Read recent inbound payments from PayHero's authoritative ledger (C2B ingest/reconcile). */
  listInboundPayments(opts?: { page?: number }): Promise<PayHeroInboundPayment[]>;
  /** Build the hosted Lipwa checkout URL for a multi-channel deposit, or null when not configured. */
  lipwaLink(opts: { amountKes?: number; reference: string }): Promise<string | null>;
}

/** Extract the payer MSISDN from PayHero's inbound description, e.g. "Received KES 200 from 0798661061". */
export function parsePayerMsisdn(description: string | null | undefined): string | null {
  const m = /from\s+(\+?\d{9,15})/i.exec(String(description ?? ""));
  return m ? m[1]! : null;
}

/** Map a raw PayHero /transactions row to a normalised inbound payment, or null when it is not one. */
export function toInboundPayment(row: any): PayHeroInboundPayment | null {
  if (!row || row.transaction_type !== "inbound_payment") return null;
  const amt = Number(row.amount);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  const code = row.provider_reference != null ? String(row.provider_reference).trim() : "";
  if (!code) return null;
  const ext = row.external_reference != null && String(row.external_reference) !== "" ? String(row.external_reference) : null;
  return {
    mpesaCode: code,
    amountCents: Math.round(amt * 100) as Cents,
    msisdn: parsePayerMsisdn(row.description),
    externalReference: ext,
    reference: row.transaction_reference != null ? String(row.transaction_reference) : null,
    at: String(row.created_at ?? ""),
  };
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
  async listInboundPayments(): Promise<PayHeroInboundPayment[]> { return []; }
  async lipwaLink(opts: { amountKes?: number; reference: string }): Promise<string | null> {
    return `https://lipwa.stub/pay?amount=${opts.amountKes ?? 0}&reference=${encodeURIComponent(opts.reference)}`;
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
  /** Optional hosted Lipwa checkout link for this account, e.g. https://app.payhero.africa/lipwa/12038.
   *  When set, card / bank / other-country deposits route through it (embedded in-app), settling via the
   *  same authoritative ledger. Absent => the Lipwa (multi-channel) option is simply not offered. */
  lipwaUrl?: string;
}

/**
 * Build a ready-to-open Lipwa checkout URL for a hosted multi-channel (card/bank/mobile-money) payment.
 * `reference` is echoed back by PayHero as the ledger row's external_reference, which is how we match the
 * completed payment to our pending transaction. `amountKes` (whole KES) pre-fills the amount when given.
 */
export function buildLipwaUrl(lipwaUrl: string, opts: { amountKes?: number; reference: string }): string {
  const base = String(lipwaUrl ?? "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const q = new URLSearchParams();
  if (opts.amountKes != null && Number.isFinite(opts.amountKes) && opts.amountKes > 0) q.set("amount", String(Math.round(opts.amountKes)));
  if (opts.reference) q.set("reference", opts.reference);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
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
      provider: a.provider ?? "m-pesa",
      external_reference: a.externalReference,
    };
    if (a.networkCode) body.network_code = a.networkCode;
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

  async listInboundPayments(opts: { page?: number } = {}): Promise<PayHeroInboundPayment[]> {
    const page = opts.page ?? 1;
    const res = await this.fetchImpl(`${this.base()}/transactions?page=${page}`, {
      method: "GET", headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
    });
    if (!res.ok) return []; // transient — never invent a payment we cannot read authoritatively
    const j: any = await res.json().catch(() => ({}));
    const rows: any[] = Array.isArray(j?.transactions) ? j.transactions : [];
    const chan = Number(this.cfg.channelId);
    return rows
      // keep inbound payments on OUR channel (a row missing channel_id is kept — never drop real money)
      .filter((r) => !Number.isFinite(chan) || r?.channel_id == null || Number(r.channel_id) === chan)
      .map(toInboundPayment)
      .filter((x): x is PayHeroInboundPayment => x !== null);
  }

  async lipwaLink(opts: { amountKes?: number; reference: string }): Promise<string | null> {
    if (!this.cfg.lipwaUrl) return null;
    return buildLipwaUrl(this.cfg.lipwaUrl, opts);
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
  /** A poller over an unconfigured client simply finds nothing (never throws to spam the reconcile loop). */
  async listInboundPayments(): Promise<PayHeroInboundPayment[]> { return []; }
  /** Not configured => the Lipwa (multi-channel) option is simply not offered. */
  async lipwaLink(): Promise<string | null> { return null; }
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
  const lipwaUrl = over.lipwaUrl ?? env.PAYHERO_LIPWA_URL;
  return {
    baseUrl: over.baseUrl ?? env.PAYHERO_API_BASE ?? DEFAULT_BASE,
    basicAuthToken: over.basicAuthToken ?? env.PAYHERO_BASIC_AUTH_TOKEN ?? "",
    channelId: over.channelId ?? env.PAYHERO_CHANNEL_ID ?? "",
    ...(callbackUrl ? { callbackUrl } : {}),
    ...(lipwaUrl ? { lipwaUrl } : {}),
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
    if (over.lipwaUrl) clean.lipwaUrl = over.lipwaUrl;
    const cfg = resolvePayHeroConfig(clean, this.env);
    const fp = `${cfg.baseUrl}|${cfg.basicAuthToken}|${cfg.channelId}|${cfg.callbackUrl ?? ""}|${cfg.lipwaUrl ?? ""}`;
    if (!this.cache || this.cache.fp !== fp) this.cache = { fp, client: makePayHeroClientFromConfig(clean, this.env) };
    return this.cache.client;
  }
  async initiateStk(a: PayHeroStkArgs): Promise<PayHeroStkResult> { return (await this.pick()).initiateStk(a); }
  async queryStatus(reference: string): Promise<PayHeroStatusResult> { return (await this.pick()).queryStatus(reference); }
  async listInboundPayments(opts?: { page?: number }): Promise<PayHeroInboundPayment[]> { return (await this.pick()).listInboundPayments(opts); }
  async lipwaLink(opts: { amountKes?: number; reference: string }): Promise<string | null> { return (await this.pick()).lipwaLink(opts); }
}
