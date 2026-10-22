import { createHash, timingSafeEqual } from "node:crypto";
import type { Cents } from "@invest254/shared";

/**
 * Paynicorn (paynicorn.com, Transsion) provider abstraction — a hosted-cashier deposit rail.
 *
 * Same shape as payhero.ts/megapay.ts: the service depends only on the `PaynicornClient` interface; money
 * correctness lives in the DB RPCs (fn_complete_deposit), not here. `StubPaynicornClient` is deterministic
 * for tests/dev; `HttpPaynicornClient` talks to the real API and is selected only when credentials are set.
 *
 * Paynicorn contract (verified against the official docs, 2026-10 — paynicorn.com/docs):
 *   Every call is POST {base}/trade/v3/transaction/<op>, Content-Type: application/json, body
 *     { content: base64(JSON(bizReq)), sign: md5(content + merchantSecret), appKey }
 *   and answers { responseCode:"000000", responseMessage, content, sign } (failures carry only the code).
 *   The response `sign` is verified the same way before `content` is decoded (docs/overview/authorization).
 *   method {countryCode, currency, txnType:"payment"} -> methodInfo[] — the methods this merchant may
 *         collect with in that country, each carrying the `inputs` it needs (name/type/regex). This is
 *         the ONLY source of truth: the published method appendix is empty, and a country outside the
 *         merchant's console country scope answers with an empty list (code 101016).
 *   pay   {amount, countryCode, currency, orderId, orderDescription, payMethod?, phone?, email?}
 *         -> {code, message, txnId, status:"1"|"-1"|"0", webUrl:null}
 *         Naming the method AND the payer's phone skips Paynicorn's cashier page entirely: Paynicorn
 *         sends the M-Pesa prompt itself and webUrl comes back null (verified live, 2026-10-09). Players
 *         therefore never load a Paynicorn page — the gateway stays invisible to them (docs/53).
 *   query {orderId, txnType:"payment"} -> {code, message, txnId, status, completeTime?}
 *   Postback: Paynicorn POSTs {content, sign} (same signature) to the app's callback address and needs
 *   HTTP 200 with the body `success_{txnId}`; anything else is retried up to 7 times.
 *
 * Kenya: KES has no decimals on Paynicorn (appendix "Country and Currency Comparison Table"), so the
 * amount crosses as whole shillings ("200"). A new app is in TEST mode: same host, MOCK payment method.
 * We store our txId as the Paynicorn `orderId` (and as checkout_request_id), so query + settle key on it.
 */
export const PAYNICORN_DEFAULT_BASE = "https://api.paynicorn.com";
export const PAYNICORN_OK = "000000";

export interface PaynicornPayArgs {
  /** Local-currency MAJOR amount, already formatted to the country's decimals (formatPaynicornAmount). */
  amount: string;
  /** ISO-2 country the collection happens in. */
  countryCode: string;
  /** That country's local currency. */
  currency: string;
  orderId: string;
  description: string;
  /** Payment method code, e.g. "MPESA". Set it to skip Paynicorn's method-selection page. */
  payMethod?: string;
  /** Payer's phone WITHOUT the country code. Supplying it skips the cashier's phone page. */
  phone?: string;
  /** Payer's email. Supplying it skips the cashier's email page. */
  email?: string;
  /** Where the cashier (when one is used) sends the browser after payment. */
  frontPage?: string;
}

/** One field a method needs from the payer, as Paynicorn's own cashier would collect it. */
export interface PaynicornMethodInput {
  /** Field key, e.g. "Phone_KE". */
  name: string;
  /** Field kind, e.g. "Phone", "Email". Drives which control we render. */
  type: string;
  /** Validation regex Paynicorn supplies for this field, when it supplies one. */
  pattern?: string;
}

/** A payment method available for one country+currency, as the live `method` endpoint reports it. */
export interface PaynicornMethod {
  code: string;
  name: string;
  /** WALLET | BANK | CARD | OTHERS … */
  methodType: string;
  iconUrl?: string;
  /** Local-currency MAJOR bounds, when Paynicorn states them. */
  minAmount?: number | null;
  maxAmount?: number | null;
  inputs: PaynicornMethodInput[];
}
export interface PaynicornPayResult { txnId: string; webUrl: string; status: string }
/** Normalised status: resultCode 0 when paid, non-zero when failed, null while still processing. */
export interface PaynicornStatusResult { resultCode: number | null; processing: boolean; txnId: string | null }

/** A verified, decoded postback. `null` from verifyPostback means the signature did not match. */
export interface PaynicornPostback {
  txnId: string; orderId: string; amount: string; currency: string; status: string; code: string; message: string;
}

export interface PaynicornClient {
  /** The methods this merchant may collect with in a country. Empty = country not in scope / none open. */
  listMethods(countryCode: string, currency: string): Promise<PaynicornMethod[]>;
  pay(a: PaynicornPayArgs): Promise<PaynicornPayResult>;
  /** Authoritative server-to-server status check — used to verify postbacks and to reconcile. */
  queryPayment(orderId: string): Promise<PaynicornStatusResult>;
  /** Check a postback's signature with OUR merchant secret and decode it; null when it does not verify. */
  verifyPostback(body: unknown): Promise<PaynicornPostback | null>;
}

// ── wire helpers (pure; unit-tested against the official vector) ────────────────────────────────
export function paynicornSign(contentBase64: string, merchantSecret: string): string {
  return createHash("md5").update(contentBase64 + merchantSecret, "utf8").digest("hex");
}
export function encodeContent(bizReq: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(bizReq), "utf8").toString("base64");
}
/** Constant-shape comparison of a received sign against the expected one (case-insensitive hex). */
export function signMatches(content: string, sign: string, merchantSecret: string): boolean {
  if (!content || !sign || !merchantSecret) return false;
  // Constant-time hex compare (both sides are md5 hex). A plain === leaks the expected signature a
  // character at a time by timing; equal-length buffers are required by timingSafeEqual.
  const expected = Buffer.from(paynicornSign(content, merchantSecret), "utf8");
  const got = Buffer.from(String(sign).trim().toLowerCase(), "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
export function decodeContent(contentBase64: string): Record<string, unknown> {
  const j = JSON.parse(Buffer.from(contentBase64, "base64").toString("utf8"));
  if (!j || typeof j !== "object") throw new Error("PAYNICORN_BAD_CONTENT");
  return j as Record<string, unknown>;
}

/** Whole KES on the wire (KES has no decimals on Paynicorn). Cents that are not whole shillings are refused. */
export function centsToPaynicornAmount(c: Cents): string {
  if (!Number.isInteger(c) || c <= 0 || c % 100 !== 0) throw new Error("PAYNICORN_AMOUNT_NOT_WHOLE_KES");
  return String(c / 100);
}

/** Map one raw `methodInfo` entry onto our shape, dropping anything unusable. */
export function toPaynicornMethod(row: any): PaynicornMethod | null {
  const code = row?.code == null ? "" : String(row.code).trim();
  if (!code) return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const inputs: PaynicornMethodInput[] = Array.isArray(row.inputs)
    ? row.inputs.flatMap((i: any) => {
        const name = i?.name == null ? "" : String(i.name).trim();
        if (!name) return [];
        const pattern = i?.reg == null || String(i.reg) === "" ? undefined : String(i.reg);
        return [{ name, type: String(i?.type ?? "Text"), ...(pattern ? { pattern } : {}) }];
      })
    : [];
  return {
    code,
    name: row.name == null || String(row.name).trim() === "" ? code : String(row.name).trim(),
    methodType: String(row.methodType ?? "OTHERS"),
    ...(row.icon ? { iconUrl: String(row.icon) } : {}),
    minAmount: num(row.minAmount),
    maxAmount: num(row.maxAmount),
    inputs,
  };
}

/**
 * True when every field this method needs is something our own form can collect (a phone and/or an
 * email). Those are the ONLY two payer inputs the collection API accepts, so any other field — a bank
 * account, a card — can only be entered on Paynicorn's hosted cashier. docs/53.
 */
export function methodIsDirect(m: PaynicornMethod): boolean {
  return m.inputs.every((i) => /phone/i.test(i.type) || /email/i.test(i.type));
}

/** Paynicorn wants the payer's phone without the country code: a Kenyan MSISDN as its 9 local digits. */
export function toPaynicornPhone(msisdn: string): string {
  const d = String(msisdn ?? "").replace(/\D/g, "");
  const local = d.startsWith("254") ? d.slice(3) : d.startsWith("0") ? d.slice(1) : d;
  if (!/^[17]\d{8}$/.test(local)) throw new Error("INVALID_PHONE");
  return local;
}

/** Map Paynicorn's "1" / "-1" / "0" order status to the shared {resultCode, processing}. */
export function mapPaynicornStatus(status: unknown, txnId: string | null = null): PaynicornStatusResult {
  const s = String(status ?? "").trim();
  if (s === "1") return { resultCode: 0, processing: false, txnId };
  if (s === "0") return { resultCode: 1, processing: false, txnId };
  // "-1" (processing) / unknown -> not yet resolvable; never credit, retry later.
  return { resultCode: null, processing: true, txnId };
}

/** Accept the postback as parsed JSON, a raw Buffer/string (JSON or form-encoded), or a plain object. */
export function readPostbackEnvelope(body: unknown): { content: string; sign: string } | null {
  let o: unknown = body;
  if (Buffer.isBuffer(o)) o = o.toString("utf8");
  if (typeof o === "string") {
    const t = o.trim();
    if (!t) return null;
    if (t.startsWith("{")) { try { o = JSON.parse(t); } catch { return null; } }
    else o = Object.fromEntries(new URLSearchParams(t));
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const content = typeof r.content === "string" ? r.content : "";
  const sign = typeof r.sign === "string" ? r.sign : "";
  return content && sign ? { content, sign } : null;
}

function toPostback(j: Record<string, unknown>): PaynicornPostback {
  const s = (k: string) => (j[k] == null ? "" : String(j[k]));
  return { txnId: s("txnId"), orderId: s("orderId"), amount: s("amount"), currency: s("currency"), status: s("status"), code: s("code"), message: s("message") };
}

export interface PaynicornConfig {
  baseUrl: string;
  appKey: string;
  merchantSecret: string;
  /** Default cashier return page (overridden per deposit when the API knows the brand's domain). */
  frontPage?: string;
}

/** Deterministic in-process stub — no network. Signs with a fixed test secret so postbacks round-trip. */
export const STUB_PAYNICORN_SECRET = "stub-paynicorn-secret";
export class StubPaynicornClient implements PaynicornClient {
  private n = 0;
  /** Status the stub reports for every query ("1" paid by default). */
  constructor(public queryStatus: "1" | "-1" | "0" = "1") {}
  /** Methods the stub reports. Tests overwrite it to model any country. */
  methods: PaynicornMethod[] = [
    { code: "MPESA", name: "M-Pesa", methodType: "WALLET", minAmount: 1, maxAmount: null,
      inputs: [{ name: "Phone_KE", type: "Phone", pattern: "^[0]?\\d{9}$" }] },
  ];
  async listMethods(_countryCode: string, _currency: string): Promise<PaynicornMethod[]> {
    return this.methods.map((m) => ({ ...m, inputs: [...m.inputs] }));
  }
  async pay(a: PaynicornPayArgs): Promise<PaynicornPayResult> {
    const i = ++this.n;
    // A direct push (method + the inputs it needs) has no page to open, exactly like the live API.
    const direct = Boolean(a.payMethod && (a.phone || a.email));
    const webUrl = direct ? "" : `https://cashier.paynicorn.stub/pay?order=${encodeURIComponent(a.orderId)}`;
    return { txnId: `stub-pn-${i}`, webUrl, status: "-1" };
  }
  async queryPayment(orderId: string): Promise<PaynicornStatusResult> {
    return mapPaynicornStatus(this.queryStatus, `stub-pn-${orderId}`);
  }
  async verifyPostback(body: unknown): Promise<PaynicornPostback | null> {
    const env = readPostbackEnvelope(body);
    if (!env || !signMatches(env.content, env.sign, STUB_PAYNICORN_SECRET)) return null;
    return toPostback(decodeContent(env.content));
  }
}

/**
 * Real Paynicorn client. Network errors propagate to the caller, which leaves the transaction pending for
 * the reconcile job — exactly like the other rails. A response whose signature does not verify is treated
 * as a failure (never trusted), and its body is never echoed (it could carry our appKey).
 */
export class HttpPaynicornClient implements PaynicornClient {
  constructor(private readonly cfg: PaynicornConfig, private readonly fetchImpl: typeof fetch = fetch) {}
  private base(): string { return this.cfg.baseUrl.replace(/\/+$/, ""); }

  private async call(op: string, bizReq: Record<string, unknown>): Promise<Record<string, unknown>> {
    const content = encodeContent(bizReq);
    const res = await this.fetchImpl(`${this.base()}/trade/v3/transaction/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, sign: paynicornSign(content, this.cfg.merchantSecret), appKey: this.cfg.appKey }),
    });
    const j: any = await res.json().catch(() => ({}));
    const code = String(j.responseCode ?? "");
    if (!res.ok || code !== PAYNICORN_OK) {
      throw new Error(`PAYNICORN_${op.toUpperCase()}_REJECTED_${res.status}:${code}:${String(j.responseMessage ?? "").slice(0, 120)}`);
    }
    if (typeof j.content !== "string" || !signMatches(j.content, j.sign, this.cfg.merchantSecret)) {
      throw new Error(`PAYNICORN_${op.toUpperCase()}_BAD_SIGNATURE`);
    }
    return decodeContent(j.content);
  }

  /**
   * The methods open to this merchant in a country. A country outside the console's country scope
   * answers 000000 with an empty list (business code 101016), which we surface as [] rather than an
   * error: "no methods here" is a normal answer the deposit sheet handles by offering nothing.
   */
  async listMethods(countryCode: string, currency: string): Promise<PaynicornMethod[]> {
    const out = await this.call("method", { countryCode, currency, txnType: "payment" });
    const rows: any[] = Array.isArray(out.methodInfo) ? out.methodInfo : [];
    return rows.map(toPaynicornMethod).filter((m): m is PaynicornMethod => m !== null);
  }

  async pay(a: PaynicornPayArgs): Promise<PaynicornPayResult> {
    const req: Record<string, unknown> = {
      amount: a.amount,
      countryCode: a.countryCode,
      currency: a.currency,
      orderId: a.orderId,
      orderDescription: a.description,
    };
    // Direct = we supplied the method AND an input that lets Paynicorn skip its own page.
    const direct = Boolean(a.payMethod && (a.phone || a.email));
    if (a.payMethod) req.payMethod = a.payMethod;
    if (a.phone) req.phone = a.phone;
    if (a.email) req.email = a.email;
    const front = a.frontPage ?? this.cfg.frontPage;
    if (front && !direct) req.cpFrontPage = front;
    const out = await this.call("pay", req);
    const status = String(out.status ?? "");
    const webUrl = out.webUrl == null ? "" : String(out.webUrl);
    // A direct push has no page; a cashier order without one cannot be completed.
    if (status === "0" || (!direct && !webUrl)) {
      throw new Error(`PAYNICORN_PAY_REFUSED:${String(out.code ?? "")}:${String(out.message ?? "").slice(0, 120)}`);
    }
    return { txnId: String(out.txnId ?? ""), webUrl, status };
  }

  async queryPayment(orderId: string): Promise<PaynicornStatusResult> {
    let out: Record<string, unknown>;
    try { out = await this.call("query", { orderId, txnType: "payment" }); }
    catch { return { resultCode: null, processing: true, txnId: null }; } // transient -> retry, never credit
    return mapPaynicornStatus(out.status, out.txnId == null ? null : String(out.txnId));
  }

  async verifyPostback(body: unknown): Promise<PaynicornPostback | null> {
    const env = readPostbackEnvelope(body);
    if (!env || !signMatches(env.content, env.sign, this.cfg.merchantSecret)) return null;
    return toPostback(decodeContent(env.content));
  }
}

/**
 * Fail-on-use client for configured-but-incomplete deployments: every money call fails loudly with
 * PAYNICORN_NOT_CONFIGURED (never a phantom credit) and no postback ever verifies.
 */
export class UnconfiguredPaynicornClient implements PaynicornClient {
  constructor(private readonly missing: readonly string[] = []) {}
  private fail(): never { throw new Error(`PAYNICORN_NOT_CONFIGURED${this.missing.length ? `:${this.missing.join(",")}` : ""}`); }
  /** Nothing configured => no methods anywhere; the sheet simply offers none (never throws). */
  async listMethods(): Promise<PaynicornMethod[]> { return []; }
  async pay(_a: PaynicornPayArgs): Promise<PaynicornPayResult> { return this.fail(); }
  async queryPayment(_o: string): Promise<PaynicornStatusResult> { return this.fail(); }
  async verifyPostback(_b: unknown): Promise<PaynicornPostback | null> { return null; }
}

/** The credentials the real Paynicorn path cannot run without. Empty array = fully configured. */
export function missingPaynicornCredentials(cfg: PaynicornConfig): string[] {
  const missing: string[] = [];
  if (!cfg.appKey) missing.push("app_key");
  if (!cfg.merchantSecret) missing.push("merchant_secret");
  return missing;
}

export function resolvePaynicornConfig(over: Partial<PaynicornConfig> = {}, env: NodeJS.ProcessEnv = process.env): PaynicornConfig {
  const frontPage = over.frontPage ?? env.PAYNICORN_FRONT_PAGE;
  return {
    baseUrl: over.baseUrl ?? env.PAYNICORN_API_BASE ?? PAYNICORN_DEFAULT_BASE,
    appKey: over.appKey ?? env.PAYNICORN_APP_KEY ?? "",
    merchantSecret: over.merchantSecret ?? env.PAYNICORN_MERCHANT_SECRET ?? "",
    ...(frontPage ? { frontPage } : {}),
  };
}

/** Build the real client when credentials resolve; else Unconfigured (production) / Stub (dev). */
export function makePaynicornClientFromConfig(over: Partial<PaynicornConfig> = {}, env: NodeJS.ProcessEnv = process.env): PaynicornClient {
  const cfg = resolvePaynicornConfig(over, env);
  const missing = missingPaynicornCredentials(cfg);
  if (missing.length === 0) return new HttpPaynicornClient(cfg);
  if (env.NODE_ENV === "production") {
    console.error(`[payments] Paynicorn credentials incomplete (missing: ${missing.join(", ")}) — refusing the stub; Paynicorn deposits fail until configured.`);
    return new UnconfiguredPaynicornClient(missing);
  }
  console.warn(`[payments] Paynicorn credentials not configured (missing: ${missing.join(", ")}) — using StubPaynicornClient.`);
  return new StubPaynicornClient();
}

/** Resolver returning a partial Paynicorn config (e.g. from the encrypted DB config store). */
export type PaynicornConfigResolver = () => Promise<Partial<PaynicornConfig> | null>;

/**
 * Paynicorn client that layers DB config OVER env with env as the guaranteed fallback (mirrors
 * ConfiguredPayHeroClient). The built client is cached by a config fingerprint so the hot path doesn't
 * rebuild it; the fingerprint holds a hash of the secret, never the secret itself.
 */
export class ConfiguredPaynicornClient implements PaynicornClient {
  private cache?: { fp: string; client: PaynicornClient };
  constructor(private readonly resolver: PaynicornConfigResolver, private readonly env: NodeJS.ProcessEnv = process.env) {}
  private async pick(): Promise<PaynicornClient> {
    let over: Partial<PaynicornConfig> = {};
    try { over = (await this.resolver()) ?? {}; } catch { over = {}; }
    const clean: Partial<PaynicornConfig> = {};
    if (over.baseUrl) clean.baseUrl = over.baseUrl;
    if (over.appKey) clean.appKey = over.appKey;
    if (over.merchantSecret) clean.merchantSecret = over.merchantSecret;
    if (over.frontPage) clean.frontPage = over.frontPage;
    const cfg = resolvePaynicornConfig(clean, this.env);
    const fp = `${cfg.baseUrl}|${cfg.appKey}|${createHash("sha256").update(cfg.merchantSecret).digest("hex")}|${cfg.frontPage ?? ""}`;
    if (!this.cache || this.cache.fp !== fp) this.cache = { fp, client: makePaynicornClientFromConfig(clean, this.env) };
    return this.cache.client;
  }
  async listMethods(countryCode: string, currency: string): Promise<PaynicornMethod[]> { return (await this.pick()).listMethods(countryCode, currency); }
  async pay(a: PaynicornPayArgs): Promise<PaynicornPayResult> { return (await this.pick()).pay(a); }
  async queryPayment(orderId: string): Promise<PaynicornStatusResult> { return (await this.pick()).queryPayment(orderId); }
  async verifyPostback(body: unknown): Promise<PaynicornPostback | null> { return (await this.pick()).verifyPostback(body); }
}
