import type { Cents } from "@invest254/shared";

/**
 * FinoQ — the PayHero Africa / "Global" rail (api.finoq.africa).
 *
 * WHAT THIS IS, AND WHY IT IS A SEPARATE CLIENT. FinoQ is PayHero rebranded continentally:
 * finoq.africa, api.finoq.africa and backend.payhero.africa all resolve to the same host, their docs
 * link to github.com/PAY-HERO-KENYA, and both hosts accept the SAME API key. But the Global API is
 * not the Kenya V1 API with a different base URL, which is the mistake the note in payhero.ts
 * records from the 2026-09-29 incident:
 *
 *   Kenya V1   POST {base}/api/v2/payments        channel_id, provider "m-pesa", flat body
 *   Global     POST {base}/api/global/payments    discovery-driven: provider_config + vendor_config
 *                                                 + payment_config, chosen from a discovery call
 *
 * Verified against the live API on 2026-10-24 with a real KES 10 collection:
 *   POST /api/global/payments            -> 200, gateway "sasapay", merchant_reference "OJD…iI"
 *   POST /api/global/transaction-status  -> ResultCode "0", "Transaction Successful"
 *   ledger: "Received KES 10 from +254713572703", provider_reference UJOJGBAN1J
 *
 * WHY WE WANT IT. The Kenya V1 rail offers M-PESA only, through a single registered channel. Global
 * discovery on this account returns M-PESA (63902), Airtel Money (63903) and T-Kash (63907), all
 * active — Airtel is reachable ONLY here. Probing Kenya V1 for Airtel returned 404, and so did the
 * same probe for M-PESA, which is what proves the limitation is the rail and not Airtel.
 *
 * TWO TRAPS, both found by running it rather than reading about it:
 *   1. The create response's `success` field LIES. A payment that went on to settle came back
 *      {"success": false, "ResponseCode": "-1", "message": "Success"}. Never read it; poll
 *      transaction-status instead. That is why `initiate` below checks only for a usable reference.
 *   2. transaction-status keys on the MERCHANT reference. Passing the checkout_request_id — the
 *      obvious choice, since that is what create returns most prominently — gives a flat 404.
 */

/** A mobile-money / bank network discovery offers for a country, normalised. */
export interface FinoqNetwork {
  /** Network code, e.g. "63902" M-PESA, "63903" Airtel Money, "63907" T-Kash. */
  networkCode: string;
  networkId: string;
  networkName: string;
  /** "momo" | "bank" — copied into provider_config.account_type. */
  accountType: string;
  /** The discovery provider that serves it, e.g. "viewtech". */
  provider: string;
  minAmountKes: number;
  maxAmountKes: number;
}

export interface FinoqInitiateArgs {
  amountCents: Cents;
  msisdn: string;
  externalReference: string;
  /** Which network to charge. Defaults to M-PESA when the caller does not care. */
  networkCode?: string;
  customerName?: string;
  email?: string;
}
export interface FinoqInitiateResult {
  /** The MERCHANT reference. This, and only this, is what transaction-status accepts. */
  reference: string;
  checkoutRequestId: string;
  /** Which gateway FinoQ routed to (e.g. "sasapay") — recorded, never acted on. */
  gateway: string | null;
}
/** Same normalised shape the other rails return, so settlement is shared. */
export interface FinoqStatusResult {
  resultCode: number | null; processing: boolean; receipt: string | null;
  providerStatus?: string | null; detail?: string | null;
}

export interface FinoqClient {
  /** Networks this account can actually charge in `country`. Empty when none are enabled. */
  discoverNetworks(country: string): Promise<FinoqNetwork[]>;
  initiate(a: FinoqInitiateArgs): Promise<FinoqInitiateResult>;
  queryStatus(merchantReference: string): Promise<FinoqStatusResult>;
}

export const FINOQ_DEFAULT_BASE = "https://api.finoq.africa";
/** Kenya's M-PESA network code — the default when a caller names no network. */
export const FINOQ_MPESA = "63902";
export const FINOQ_AIRTEL = "63903";
export const FINOQ_TKASH = "63907";

/** Human labels for the networks we expose. Anything else falls back to its discovery name. */
export const FINOQ_NETWORK_LABELS: Readonly<Record<string, string>> = {
  [FINOQ_MPESA]: "M-Pesa",
  [FINOQ_AIRTEL]: "Airtel Money",
  [FINOQ_TKASH]: "T-Kash",
};

export interface FinoqConfig {
  baseUrl: string;
  /** Basic token (base64 of user:pass), WITHOUT the leading "Basic ". Shared with the Kenya rail. */
  basicAuthToken: string;
  /** vendor_config.vendor_id — the PayHero account id (12038 for this account). */
  vendorId: string;
  country: string;
  currency: string;
  callbackUrl?: string;
  /** Payer return URL; required by the schema even for momo, where it is never used. */
  redirectUrl?: string;
}

const centsToKes = (c: Cents): number => Math.round(c / 100) ;

/** FinoQ wants E.164 with the plus, e.g. +254712345678 (its own examples and our live test). */
export function toE164(raw: string): string {
  const d = String(raw ?? "").replace(/[^\d]/g, "");
  if (d.startsWith("254")) return `+${d}`;
  if (d.startsWith("0")) return `+254${d.slice(1)}`;
  if (d.length === 9) return `+254${d}`;
  return d ? `+${d}` : "";
}

/**
 * Map a FinoQ transaction-status body to the shared verdict.
 *
 * ResultCode is the field that decides, and "0" is the only value that credits. "-1" is explicitly
 * NOT a failure — the live API returns it alongside "Transaction Pending", so treating non-zero as
 * failed would mark settling deposits as failed and strand real money.
 */
export function mapFinoqStatus(body: unknown): FinoqStatusResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.ResultCode ?? b.result_code ?? null;
  const desc = b.ResultDesc ?? b.ResultDescription ?? b.ErrorMessage ?? b.message ?? null;
  const descText = desc != null && String(desc) !== "" ? String(desc) : null;
  const receiptRaw = b.provider_reference ?? b.ProviderReference ?? b.MpesaReceiptNumber ?? null;
  const receipt = receiptRaw != null && String(receiptRaw) !== "" && String(receiptRaw) !== "N/A"
    ? String(receiptRaw) : null;
  const seen = { providerStatus: raw != null ? String(raw) : null, detail: descText };

  if (raw == null || String(raw).trim() === "") return { resultCode: null, processing: true, receipt: null, ...seen };
  const code = String(raw).trim();
  if (code === "0") return { resultCode: 0, processing: false, receipt, ...seen };
  // Pending is signalled by -1 WITH a pending description. Anything else non-zero is a real failure.
  if (code === "-1" && /pending|processing/i.test(descText ?? "")) {
    return { resultCode: null, processing: true, receipt: null, ...seen };
  }
  if (code === "-1") return { resultCode: null, processing: true, receipt: null, ...seen };
  return { resultCode: 1, processing: false, receipt: null, ...seen };
}

/** Pull the networks we can charge out of a discover-rails body. */
export function parseDiscovery(body: unknown): FinoqNetwork[] {
  const b = (body ?? {}) as Record<string, any>;
  if (b.has_networks === false) return [];
  const byProvider = (b.provider_networks ?? {}) as Record<string, any[]>;
  const out: FinoqNetwork[] = [];
  const seen = new Set<string>();
  for (const [provider, nets] of Object.entries(byProvider)) {
    for (const n of Array.isArray(nets) ? nets : []) {
      // Only collection ("deposit") networks; the same network also appears with ramp_type "withdraw".
      if (n?.ramp_type !== "deposit" || n?.status !== "active") continue;
      const code = n.network_code != null ? String(n.network_code) : "";
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({
        networkCode: code,
        networkId: n.network_id != null ? String(n.network_id) : code,
        networkName: String(n.network_name ?? n.name ?? code),
        accountType: String(n.channel_type ?? "momo"),
        provider: String(n.provider ?? provider),
        minAmountKes: Number(n.min_amount ?? 1),
        maxAmountKes: Number(n.max_amount ?? 0),
      });
    }
  }
  return out;
}

export class HttpFinoqClient implements FinoqClient {
  private cache?: { at: number; country: string; nets: FinoqNetwork[] };
  constructor(private readonly cfg: FinoqConfig, private readonly fetchImpl: typeof fetch = fetch,
              private readonly now: () => number = () => Date.now()) {}
  private base(): string { return this.cfg.baseUrl.replace(/\/+$/, ""); }
  private auth(): string { return `Basic ${this.cfg.basicAuthToken.replace(/^basic\s+/i, "")}`; }
  private headers(): Record<string, string> { return { "Content-Type": "application/json", Authorization: this.auth() }; }

  /** Discovery changes rarely; a short cache keeps it off the deposit hot path. */
  async discoverNetworks(country = this.cfg.country): Promise<FinoqNetwork[]> {
    const c = (country || "KE").toUpperCase();
    if (this.cache && this.cache.country === c && this.now() - this.cache.at < 300_000) return this.cache.nets;
    const res = await this.fetchImpl(`${this.base()}/api/global/discovery/discover-rails?country=${encodeURIComponent(c)}`,
      { method: "GET", headers: this.headers() });
    if (!res.ok) return this.cache?.country === c ? this.cache.nets : [];
    const nets = parseDiscovery(await res.json().catch(() => ({})));
    this.cache = { at: this.now(), country: c, nets };
    return nets;
  }

  async initiate(a: FinoqInitiateArgs): Promise<FinoqInitiateResult> {
    const code = a.networkCode ?? FINOQ_MPESA;
    const nets = await this.discoverNetworks(this.cfg.country);
    const net = nets.find((n) => n.networkCode === code);
    if (!net) throw new Error(`FINOQ_NETWORK_UNAVAILABLE:${code}`);
    const amountKes = centsToKes(a.amountCents);
    if (amountKes < net.minAmountKes) throw new Error(`FINOQ_BELOW_NETWORK_MIN:${net.minAmountKes}`);
    if (net.maxAmountKes > 0 && amountKes > net.maxAmountKes) throw new Error(`FINOQ_ABOVE_NETWORK_MAX:${net.maxAmountKes}`);
    const phone = toE164(a.msisdn);
    const [first, ...rest] = String(a.customerName ?? "").trim().split(/\s+/).filter(Boolean);

    const body = {
      request_type: "payment",
      transaction_channel: net.accountType,
      provider: net.provider,
      amount: amountKes,
      currency: this.cfg.currency,
      country: this.cfg.country,
      reason: "Deposit",
      customer: {
        first_name: first || "Player", last_name: rest.join(" ") || "Deposit",
        email: a.email || "deposits@invest254.com", phone, country: this.cfg.country,
      },
      vendor_config: { vendor_id: Number(this.cfg.vendorId) },
      provider_config: {
        network_id: net.networkId, provider_id: net.provider, network_name: net.networkName,
        network_code: net.networkCode, account_type: net.accountType,
      },
      payment_config: {
        reference: a.externalReference, account_number: phone, remark: "Deposit",
        payment_category: "bill payment",
        ...(this.cfg.callbackUrl ? { callback_url: this.cfg.callbackUrl } : {}),
        ...(this.cfg.redirectUrl ? { redirect_url: this.cfg.redirectUrl } : {}),
      },
    };

    const res = await this.fetchImpl(`${this.base()}/api/global/payments`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    const j: any = await res.json().catch(() => ({}));
    // Deliberately NOT reading j.success: a settled payment returned success:false on 2026-10-24.
    // A usable merchant reference is the only thing that means "accepted".
    const reference = j.merchant_reference ?? j.conversation_id ?? j.reference;
    if (!res.ok || !reference) {
      throw new Error(`FINOQ_INITIATE_REJECTED_${res.status}:${JSON.stringify(j).slice(0, 300)}`);
    }
    return {
      reference: String(reference),
      checkoutRequestId: String(j.checkout_request_id ?? j.CheckoutRequestID ?? reference),
      gateway: j.gateway != null ? String(j.gateway) : null,
    };
  }

  async queryStatus(merchantReference: string): Promise<FinoqStatusResult> {
    const res = await this.fetchImpl(`${this.base()}/api/global/transaction-status`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ request_id: merchantReference }),
    });
    // Transient -> retry, never credit. A 404 here means "not this reference", which for a reference
    // we just stored is a provider-side lag, not a failure: treat it as still processing.
    if (!res.ok) return { resultCode: null, processing: true, receipt: null, providerStatus: null, detail: `http_${res.status}` };
    return mapFinoqStatus(await res.json().catch(() => ({})));
  }
}

/** Deterministic stub for tests/dev — no network. */
export class StubFinoqClient implements FinoqClient {
  private n = 0;
  constructor(private readonly nets: FinoqNetwork[] = [
    { networkCode: FINOQ_MPESA, networkId: FINOQ_MPESA, networkName: "M-PESA", accountType: "momo", provider: "viewtech", minAmountKes: 1, maxAmountKes: 150000 },
    { networkCode: FINOQ_AIRTEL, networkId: FINOQ_AIRTEL, networkName: "Airtel Money", accountType: "momo", provider: "viewtech", minAmountKes: 1, maxAmountKes: 150000 },
  ]) {}
  async discoverNetworks(_country?: string): Promise<FinoqNetwork[]> { return [...this.nets]; }
  async initiate(a: FinoqInitiateArgs): Promise<FinoqInitiateResult> {
    const code = a.networkCode ?? FINOQ_MPESA;
    if (!this.nets.some((n) => n.networkCode === code)) throw new Error(`FINOQ_NETWORK_UNAVAILABLE:${code}`);
    const i = ++this.n;
    return { reference: `stub-fq-ref-${i}`, checkoutRequestId: `stub-fq-co-${i}`, gateway: "sasapay" };
  }
  async queryStatus(_r?: string): Promise<FinoqStatusResult> {
    return { resultCode: 0, processing: false, receipt: "STUBFQRCPT", providerStatus: "0", detail: "Transaction Successful" };
  }
}

/** Fails loudly when configured-but-incomplete — never a phantom credit. */
export class UnconfiguredFinoqClient implements FinoqClient {
  constructor(private readonly missing: readonly string[] = []) {}
  private fail(): never { throw new Error(`FINOQ_NOT_CONFIGURED${this.missing.length ? `:${this.missing.join(",")}` : ""}`); }
  /** A discovery call simply finds nothing, so the rail is not offered rather than erroring. */
  async discoverNetworks(_country?: string): Promise<FinoqNetwork[]> { return []; }
  async initiate(_a: FinoqInitiateArgs): Promise<FinoqInitiateResult> { return this.fail(); }
  async queryStatus(_r: string): Promise<FinoqStatusResult> { return this.fail(); }
}

export function missingFinoqConfig(cfg: FinoqConfig): string[] {
  const missing: string[] = [];
  if (!cfg.basicAuthToken) missing.push("basic_auth_token");
  if (!cfg.vendorId) missing.push("vendor_id");
  return missing;
}

export function resolveFinoqConfig(over: Partial<FinoqConfig> = {}, env: NodeJS.ProcessEnv = process.env): FinoqConfig {
  const callbackUrl = over.callbackUrl ?? env.FINOQ_CALLBACK_URL ?? env.PAYHERO_CALLBACK_URL;
  const redirectUrl = over.redirectUrl ?? env.FINOQ_REDIRECT_URL;
  return {
    baseUrl: over.baseUrl ?? env.FINOQ_API_BASE ?? FINOQ_DEFAULT_BASE,
    basicAuthToken: over.basicAuthToken ?? env.FINOQ_BASIC_AUTH_TOKEN ?? env.PAYHERO_BASIC_AUTH_TOKEN ?? "",
    vendorId: over.vendorId ?? env.FINOQ_VENDOR_ID ?? env.PAYHERO_ACCOUNT_ID ?? "",
    country: (over.country ?? env.FINOQ_COUNTRY ?? "KE").toUpperCase(),
    currency: (over.currency ?? env.FINOQ_CURRENCY ?? "KES").toUpperCase(),
    ...(callbackUrl ? { callbackUrl } : {}),
    ...(redirectUrl ? { redirectUrl } : {}),
  };
}

export function makeFinoqClientFromConfig(over: Partial<FinoqConfig> = {}, env: NodeJS.ProcessEnv = process.env): FinoqClient {
  const cfg = resolveFinoqConfig(over, env);
  const missing = missingFinoqConfig(cfg);
  if (missing.length === 0) return new HttpFinoqClient(cfg);
  if (env.NODE_ENV === "production") {
    console.error(`[payments] FinoQ config incomplete (missing: ${missing.join(", ")}) — the Global rail is not offered.`);
    return new UnconfiguredFinoqClient(missing);
  }
  console.warn(`[payments] FinoQ not configured (missing: ${missing.join(", ")}) — using StubFinoqClient.`);
  return new StubFinoqClient();
}
