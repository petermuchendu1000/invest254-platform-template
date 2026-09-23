/**
 * paymentscopes.ts — PAY-1 (docs/43): per-platform and per-brand payment-gateway accounts.
 *
 * A brand's money flows through ONE payment owner: its own scope if active, else its platform's scope
 * if active, else the System ("global"). This module:
 *   - stores/validates/encrypts scoped gateway configs (M-Pesa included) — PaymentScopeService;
 *   - resolves a brand's owner scope and builds that scope's LIVE clients — the GatewayRouter used by
 *     PaymentService / AffiliateService.
 *
 * Money-safety invariants (docs/43 §3), enforced here and tested:
 *   1. no mixing across owners: a scoped client is built ONLY from that scope's config — never env,
 *      never a parent scope, never a stub (an incomplete config yields a client that FAILS LOUDLY);
 *   2. payouts follow the owner (B2C from the owner scope, else MPESA_B2C_NOT_CONFIGURED);
 *   3. verification uses the initiating scope (callers pass the transaction's recorded scope);
 *   4. a platform admin can never choose where we talk to / listen from (base URLs, callbacks, sandbox).
 */
import type { Querier } from "./wallet.js";
import { HttpDarajaClient, UnconfiguredDarajaClient, missingDarajaCredentials, missingB2cCredentials,
  type DarajaClient, type DarajaConfig, type StkPushArgs, type StkPushResult, type StkQueryResult, type B2cArgs, type B2cResult } from "./daraja.js";
import { HttpMegaPayClient, UnconfiguredMegaPayClient, missingMegaPayCredentials, resolveMegaPayConfig, type MegaPayClient } from "./megapay.js";
import { HttpPayHeroClient, UnconfiguredPayHeroClient, missingPayHeroCredentials, resolvePayHeroConfig, type PayHeroClient } from "./payhero.js";
import { GATEWAY_SCHEMAS, PLAYER_DEPOSIT_RAILS, splitSubmissionWith, validateConfigWith, type GatewaySchema, type ValidationIssue } from "./gatewayschema.js";
import { encryptSecrets, decryptSecrets, isEncryptionConfigured } from "./providercrypto.js";
import { testConnection as probeGateway, type ConnResult } from "./gatewaytest.js";

/** SAFE Daraja probe: an OAuth token request with the app's consumer key/secret (moves no money). */
export async function probeDaraja(cfg: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<ConnResult> {
  if (!cfg.consumer_key || !cfg.consumer_secret) return { ok: false, status: "not_configured", detail: "Enter the consumer key and secret first." };
  const base = cfg.environment === "sandbox" ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";
  try {
    const auth = Buffer.from(`${cfg.consumer_key}:${cfg.consumer_secret}`).toString("base64");
    const r = await fetchImpl(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { access_token?: string };
      if (j.access_token) return { ok: true, status: "valid", detail: "Connected — Safaricom issued an access token for this app." };
    }
    if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, status: "invalid", detail: "Safaricom rejected the consumer key/secret for this environment." };
    return { ok: false, status: "unreachable", detail: `Safaricom answered HTTP ${r.status}.` };
  } catch {
    return { ok: false, status: "unreachable", detail: "Could not reach Safaricom." };
  }
}

// ── scope references ────────────────────────────────────────────────────────────────────────────
export type ScopeType = "platform" | "site";
export type PaymentScopeRef = "global" | `${ScopeType}:${string}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scopeRef(type: ScopeType, id: string): PaymentScopeRef { return `${type}:${id}` as PaymentScopeRef; }
/** Parse a stored/requested scope; null/''/'global' -> global. Throws INVALID_SCOPE on garbage. */
export function parseScope(raw: string | null | undefined): { type: "global" } | { type: ScopeType; id: string } {
  if (!raw || raw === "global") return { type: "global" };
  const [type, id] = raw.split(":");
  if ((type === "platform" || type === "site") && id && UUID.test(id)) return { type, id };
  throw new Error("INVALID_SCOPE");
}

// ── the M-Pesa (Daraja) schema for a scoped account ───────────────────────────────────────────────
// The GLOBAL M-Pesa config lives in mpesa_config (the owner's M-Pesa page); scoped accounts use this.
// Callback URLs are NOT fields: every scope uses the System's own callback endpoints (docs/43 §3.4).
export const MPESA_SCOPED_SCHEMA: GatewaySchema = {
  code: "mpesa",
  displayName: "M-Pesa (Daraja)",
  docsUrl: "https://developer.safaricom.co.ke",
  playerAvailable: true,
  blurb: "Your own Safaricom account: players approve deposits on their phone, and withdrawals are paid from your payout shortcode.",
  fields: [
    { key: "environment", label: "Environment", kind: "select", secret: false, required: true, default: "production",
      options: [{ value: "production", label: "Live (real money)" }, { value: "sandbox", label: "Test (System owner only)" }] },
    { key: "shortcode", label: "Business shortcode", kind: "text", secret: false, required: true, pattern: "^\\d{5,7}$", placeholder: "e.g. 600000", group: "Deposits (STK)" },
    { key: "transaction_type", label: "Deposit type", kind: "select", secret: false, required: false, default: "paybill", group: "Deposits (STK)",
      options: [{ value: "paybill", label: "Pay Bill" }, { value: "till", label: "Till (Buy Goods)" }] },
    { key: "till_number", label: "Till number", kind: "text", secret: false, required: false, pattern: "^\\d{4,10}$", group: "Deposits (STK)", help: "Only for Till (Buy Goods). Leave blank for Pay Bill." },
    { key: "consumer_key", label: "Consumer key", kind: "secret", secret: true, required: true, group: "App credentials" },
    { key: "consumer_secret", label: "Consumer secret", kind: "secret", secret: true, required: true, group: "App credentials" },
    { key: "passkey", label: "Lipa na M-Pesa passkey", kind: "secret", secret: true, required: false, group: "Deposits (STK)", help: "Needed before players can deposit." },
    { key: "b2c_shortcode", label: "Payout shortcode", kind: "text", secret: false, required: false, pattern: "^\\d{4,10}$", group: "Payouts (B2C)", help: "Only if payouts use a different shortcode from deposits." },
    { key: "b2c_initiator", label: "Initiator name", kind: "text", secret: false, required: false, group: "Payouts (B2C)", help: "The API operator username from the Daraja portal." },
    { key: "b2c_security_credential", label: "Security credential", kind: "secret", secret: true, required: false, group: "Payouts (B2C)", help: "The encrypted initiator password from the Daraja portal." },
    { key: "b2c_command_id", label: "Payout type", kind: "select", secret: false, required: false, default: "BusinessPayment", group: "Payouts (B2C)",
      options: [{ value: "BusinessPayment", label: "Business payment (standard)" }, { value: "SalaryPayment", label: "Salary payment" }, { value: "PromotionPayment", label: "Promotion payment" }] },
  ],
};

/** Every gateway a scope may configure: M-Pesa + the registered gateways (minus System-owner-only fields for platform admins). */
export function scopedSchema(code: string): GatewaySchema {
  if (code === "mpesa") return MPESA_SCOPED_SCHEMA;
  const s = GATEWAY_SCHEMAS[code];
  if (!s) throw new Error("PROVIDER_NOT_CONFIGURABLE");
  return s;
}
export const SCOPED_GATEWAY_CODES = ["mpesa", ...Object.keys(GATEWAY_SCHEMAS)];

/** Settings a platform admin may never set (mirrors fn_payment_owner_only_violation, 0160). */
export const OWNER_ONLY_SETTINGS = ["api_base", "base_url", "callback_url", "callback_allowed_cidrs", "stk_callback_url", "b2c_result_url", "b2c_timeout_url"] as const;
export function ownerOnlyViolation(role: string, settings: Record<string, string>): string | null {
  if (role === "platform_superadmin") return null;
  for (const k of OWNER_ONLY_SETTINGS) if (settings[k] && settings[k]!.trim() !== "") return k;
  const env = settings.env ?? settings.environment;
  if (env && !["production", "live"].includes(env)) return "env";
  return null;
}

/** Schema as a platform admin sees it: owner-only fields removed, non-live environments removed. */
export function schemaForRole(code: string, role: string): GatewaySchema {
  const s = scopedSchema(code);
  if (role === "platform_superadmin") return s;
  return {
    ...s,
    fields: s.fields
      .filter((f) => !(OWNER_ONLY_SETTINGS as readonly string[]).includes(f.key))
      .map((f) => (f.key === "env" || f.key === "environment") && f.options
        ? { ...f, default: f.options.some((o) => o.value === "live") ? "live" : "production", options: f.options.filter((o) => o.value === "production" || o.value === "live") }
        : f),
  };
}

// ── storage ─────────────────────────────────────────────────────────────────────────────────────
export interface ScopedConfigView {
  providerCode: string; scopeType: ScopeType; scopeId: string;
  settings: Record<string, string>; secretMeta: Record<string, { set: boolean; last4: string }>;
  hasSecret: boolean; encVersion: number; updatedAt: string | null; exists: boolean;
}
export interface ScopedConfigResolved { settings: Record<string, string>; secretCiphertext: string | null; encVersion: number; updatedAt: string | null }
export interface ScopeState { scopeType: ScopeType; scopeId: string; name: string; active: boolean; payoutsEnabled: boolean; activatedAtMs: number | null }
export interface OwnerScope { scope: PaymentScopeRef; payoutsEnabled: boolean }

export interface PaymentScopeRepository {
  getConfig(actorId: string, role: string, code: string, type: ScopeType, id: string): Promise<ScopedConfigView>;
  setConfig(actorId: string, role: string, code: string, type: ScopeType, id: string, settings: Record<string, string>,
    ciphertext: string | null, meta: Record<string, { set: boolean; last4: string }>, encVersion: number): Promise<ScopedConfigView>;
  clearConfig(actorId: string, role: string, code: string, type: ScopeType, id: string): Promise<boolean>;
  /** Engine-internal: the EXACT scope's row (settings + ciphertext), no fallback. */
  resolveConfig(code: string, type: ScopeType, id: string): Promise<ScopedConfigResolved | null>;
  setActive(actorId: string, role: string, type: ScopeType, id: string, active: boolean, payoutsEnabled: boolean): Promise<void>;
  ownerScope(siteId: string): Promise<OwnerScope>;
  listScopes(actorId: string, role: string, platformId: string): Promise<ScopeState[]>;
  /** Authorization-only probe (raises NOT_AUTHORIZED / PLATFORM_SCOPE_FORBIDDEN / SCOPE_NOT_FOUND). */
  assertScope(actorId: string, role: string, type: ScopeType, id: string): Promise<void>;
  stampTransaction(txId: string, scope: PaymentScopeRef): Promise<void>;
}

function mapView(v: Record<string, unknown>, type: ScopeType, id: string, code: string): ScopedConfigView {
  return {
    providerCode: String(v.provider_code ?? code), scopeType: type, scopeId: id,
    settings: (v.settings ?? {}) as Record<string, string>,
    secretMeta: (v.secret_meta ?? {}) as Record<string, { set: boolean; last4: string }>,
    hasSecret: Boolean(v.has_secret), encVersion: Number(v.enc_version ?? 1),
    updatedAt: (v.updated_at as string) ?? null, exists: Boolean(v.exists),
  };
}

export class PgPaymentScopeRepository implements PaymentScopeRepository {
  constructor(private readonly q: Querier) {}
  async getConfig(actorId: string, role: string, code: string, type: ScopeType, id: string) {
    const r = await this.q.query("select public.fn_provider_config_get_scoped($1,$2,$3,$4,$5) as v", [actorId, role, code, type, id]);
    return mapView(r.rows[0]?.v ?? {}, type, id, code);
  }
  async setConfig(actorId: string, role: string, code: string, type: ScopeType, id: string, settings: Record<string, string>,
    ciphertext: string | null, meta: Record<string, { set: boolean; last4: string }>, encVersion: number) {
    const r = await this.q.query("select public.fn_provider_config_set_scoped($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9) as v",
      [actorId, role, code, type, id, JSON.stringify(settings), ciphertext, JSON.stringify(meta ?? {}), encVersion]);
    return mapView(r.rows[0]?.v ?? {}, type, id, code);
  }
  async clearConfig(actorId: string, role: string, code: string, type: ScopeType, id: string) {
    const r = await this.q.query("select public.fn_provider_config_clear_scoped($1,$2,$3,$4,$5) as v", [actorId, role, code, type, id]);
    return r.rows[0]?.v === true;
  }
  async resolveConfig(code: string, type: ScopeType, id: string) {
    const r = await this.q.query("select public.fn_provider_config_resolve_scoped($1,$2,$3) as v", [code, type, id]);
    const v = r.rows[0]?.v;
    if (!v) return null;
    return { settings: (v.settings ?? {}) as Record<string, string>, secretCiphertext: v.secret_ciphertext ?? null,
      encVersion: Number(v.enc_version ?? 1), updatedAt: v.updated_at ?? null };
  }
  async setActive(actorId: string, role: string, type: ScopeType, id: string, active: boolean, payoutsEnabled: boolean) {
    await this.q.query("select public.fn_payment_scope_set_active($1,$2,$3,$4,$5,$6)", [actorId, role, type, id, active, payoutsEnabled]);
  }
  async ownerScope(siteId: string): Promise<OwnerScope> {
    const r = await this.q.query("select scope, payouts_enabled from public.fn_payment_owner_scope($1)", [siteId]);
    const x = r.rows[0];
    return { scope: (x?.scope ?? "global") as PaymentScopeRef, payoutsEnabled: x?.payouts_enabled !== false };
  }
  async listScopes(actorId: string, role: string, platformId: string): Promise<ScopeState[]> {
    const r = await this.q.query("select * from public.fn_payment_scopes_list($1,$2,$3)", [actorId, role, platformId]);
    return r.rows.map((x: Record<string, unknown>) => ({
      scopeType: x.scope_type as ScopeType, scopeId: String(x.scope_id), name: String(x.name), active: x.active === true,
      payoutsEnabled: x.payouts_enabled !== false, activatedAtMs: x.activated_at ? new Date(String(x.activated_at)).getTime() : null,
    }));
  }
  async assertScope(actorId: string, role: string, type: ScopeType, id: string) {
    await this.q.query("select public.fn_payment_scope_assert($1,$2,$3,$4)", [actorId, role, type, id]);
  }
  async stampTransaction(txId: string, scope: PaymentScopeRef) {
    await this.q.query("select public.fn_set_transaction_payment_scope($1,$2)", [txId, scope]);
  }
}

/** In-memory double with the same authorization rules (actor/site -> platform maps seeded by tests). */
export class InMemoryPaymentScopeRepository implements PaymentScopeRepository {
  readonly actorPlatform = new Map<string, string>();   // platform admin -> platform
  readonly sitePlatform = new Map<string, string>();    // site -> platform
  readonly platforms = new Map<string, string>();       // platform -> name
  readonly siteNames = new Map<string, string>();
  readonly configs = new Map<string, { settings: Record<string, string>; ciphertext: string | null; meta: Record<string, { set: boolean; last4: string }>; encVersion: number; updatedAt: string }>();
  readonly scopes = new Map<string, { active: boolean; payoutsEnabled: boolean; activatedAtMs: number | null }>();
  readonly stamps = new Map<string, PaymentScopeRef>();
  readonly audit: Array<{ actorId: string; action: string; scope: string }> = [];
  private key(code: string, type: ScopeType, id: string) { return `${code}|${type}:${id}`; }
  private platformOf(type: ScopeType, id: string): string {
    const p = type === "platform" ? (this.platforms.has(id) ? id : undefined) : this.sitePlatform.get(id);
    if (!p) throw new Error("SCOPE_NOT_FOUND");
    return p;
  }
  async assertScope(actorId: string, role: string, type: ScopeType, id: string) {
    if (type !== "platform" && type !== "site") throw new Error("INVALID_SCOPE");
    const p = this.platformOf(type, id);
    if (role === "platform_superadmin") return;
    if (role !== "platform_admin" || !this.actorPlatform.has(actorId)) throw new Error("NOT_AUTHORIZED");
    if (this.actorPlatform.get(actorId) !== p) throw new Error("PLATFORM_SCOPE_FORBIDDEN");
  }
  async getConfig(actorId: string, role: string, code: string, type: ScopeType, id: string): Promise<ScopedConfigView> {
    await this.assertScope(actorId, role, type, id);
    const row = this.configs.get(this.key(code, type, id));
    if (!row) return { providerCode: code, scopeType: type, scopeId: id, settings: {}, secretMeta: {}, hasSecret: false, encVersion: 1, updatedAt: null, exists: false };
    return { providerCode: code, scopeType: type, scopeId: id, settings: { ...row.settings }, secretMeta: { ...row.meta }, hasSecret: row.ciphertext != null, encVersion: row.encVersion, updatedAt: row.updatedAt, exists: true };
  }
  async setConfig(actorId: string, role: string, code: string, type: ScopeType, id: string, settings: Record<string, string>,
    ciphertext: string | null, meta: Record<string, { set: boolean; last4: string }>, encVersion: number) {
    await this.assertScope(actorId, role, type, id);
    const bad = ownerOnlyViolation(role, settings);
    if (bad) throw new Error(`OWNER_ONLY_FIELD: ${bad}`);
    const prev = this.configs.get(this.key(code, type, id));
    this.configs.set(this.key(code, type, id), {
      settings: { ...settings },
      ciphertext: ciphertext === null ? (prev?.ciphertext ?? null) : (ciphertext === "" ? null : ciphertext),
      meta: ciphertext === null ? (prev?.meta ?? {}) : (ciphertext === "" ? {} : { ...meta }),
      encVersion, updatedAt: new Date().toISOString(),
    });
    this.audit.push({ actorId, action: "payment.scope.config", scope: `${type}:${id}` });
    return this.getConfig(actorId, role, code, type, id);
  }
  async clearConfig(actorId: string, role: string, code: string, type: ScopeType, id: string) {
    await this.assertScope(actorId, role, type, id);
    return this.configs.delete(this.key(code, type, id));
  }
  async resolveConfig(code: string, type: ScopeType, id: string) {
    const row = this.configs.get(this.key(code, type, id));
    return row ? { settings: { ...row.settings }, secretCiphertext: row.ciphertext, encVersion: row.encVersion, updatedAt: row.updatedAt } : null;
  }
  async setActive(actorId: string, role: string, type: ScopeType, id: string, active: boolean, payoutsEnabled: boolean) {
    await this.assertScope(actorId, role, type, id);
    this.scopes.set(`${type}:${id}`, { active, payoutsEnabled, activatedAtMs: active ? Date.now() : null });
    this.audit.push({ actorId, action: active ? "payment.scope.activate" : "payment.scope.deactivate", scope: `${type}:${id}` });
  }
  async ownerScope(siteId: string): Promise<OwnerScope> {
    const s = this.scopes.get(`site:${siteId}`);
    if (s?.active) return { scope: scopeRef("site", siteId), payoutsEnabled: s.payoutsEnabled };
    const p = this.sitePlatform.get(siteId);
    const ps = p ? this.scopes.get(`platform:${p}`) : undefined;
    if (p && ps?.active) return { scope: scopeRef("platform", p), payoutsEnabled: ps.payoutsEnabled };
    return { scope: "global", payoutsEnabled: true };
  }
  async listScopes(actorId: string, role: string, platformId: string): Promise<ScopeState[]> {
    await this.assertScope(actorId, role, "platform", platformId);
    const st = (type: ScopeType, id: string, name: string): ScopeState => {
      const s = this.scopes.get(`${type}:${id}`);
      return { scopeType: type, scopeId: id, name, active: s?.active ?? false, payoutsEnabled: s?.payoutsEnabled ?? true, activatedAtMs: s?.activatedAtMs ?? null };
    };
    return [st("platform", platformId, this.platforms.get(platformId) ?? platformId),
      ...[...this.sitePlatform.entries()].filter(([, p]) => p === platformId).map(([sid]) => st("site", sid, this.siteNames.get(sid) ?? sid))];
  }
  async stampTransaction(txId: string, scope: PaymentScopeRef) { this.stamps.set(txId, scope); }
}

// ── completeness (what a scope can actually do) ─────────────────────────────────────────────────
export interface GatewayStatus { configured: boolean; depositsReady: boolean; payoutsReady: boolean; missing: string[] }

function darajaConfigOf(settings: Record<string, string>, secrets: Record<string, string>, callbacks: GlobalCallbacks): DarajaConfig {
  const env = settings.environment === "sandbox" ? "sandbox" : "production";
  const cfg: DarajaConfig = {
    env, consumerKey: secrets.consumer_key ?? "", consumerSecret: secrets.consumer_secret ?? "",
    shortcode: settings.shortcode ?? "", passkey: secrets.passkey ?? "",
    stkCallbackUrl: callbacks.stkCallbackUrl, b2cInitiator: settings.b2c_initiator ?? "",
    b2cSecurityCredential: secrets.b2c_security_credential ?? "",
    b2cResultUrl: callbacks.b2cResultUrl, b2cTimeoutUrl: callbacks.b2cTimeoutUrl,
  };
  if (settings.transaction_type === "till" || settings.transaction_type === "paybill") cfg.transactionType = settings.transaction_type;
  if (settings.till_number) cfg.tillNumber = settings.till_number;
  if (settings.b2c_shortcode) cfg.b2cShortcode = settings.b2c_shortcode;
  const cmd = settings.b2c_command_id;
  if (cmd === "BusinessPayment" || cmd === "SalaryPayment" || cmd === "PromotionPayment") cfg.b2cCommandId = cmd;
  return cfg;
}

export function gatewayStatus(code: string, settings: Record<string, string>, secrets: Record<string, string>, callbacks: GlobalCallbacks, configured = true): GatewayStatus {
  if (!configured) return { configured: false, depositsReady: false, payoutsReady: false, missing: [] };
  if (code === "mpesa") {
    const cfg = darajaConfigOf(settings, secrets, callbacks);
    const stk = missingDarajaCredentials(cfg);
    const b2c = [...(cfg.consumerKey ? [] : ["consumerKey"]), ...(cfg.consumerSecret ? [] : ["consumerSecret"]),
      ...((cfg.b2cShortcode || cfg.shortcode) ? [] : ["shortcode"]), ...missingB2cCredentials(cfg)];
    return { configured: true, depositsReady: stk.length === 0, payoutsReady: b2c.length === 0, missing: [...new Set([...stk, ...b2c])] };
  }
  if (code === "megapay") {
    const m = missingMegaPayCredentials(resolveMegaPayConfig({ apiKey: secrets.api_key ?? "", email: settings.email ?? "" }, {}));
    return { configured: true, depositsReady: m.length === 0, payoutsReady: false, missing: m };
  }
  if (code === "payhero") {
    const m = missingPayHeroCredentials(resolvePayHeroConfig({ basicAuthToken: secrets.basic_auth_token ?? "", channelId: settings.channel_id ?? "" }, {}));
    return { configured: true, depositsReady: m.length === 0, payoutsReady: false, missing: m };
  }
  const issues = validateConfigWith(scopedSchema(code), { settings, secrets: {} }, Object.keys(secrets));
  return { configured: true, depositsReady: false, payoutsReady: false, missing: issues.map((i) => i.field) };
}

// ── live clients for a scope (never env, never a stub, never a parent scope) ────────────────────
export interface GlobalCallbacks { stkCallbackUrl: string; b2cResultUrl: string; b2cTimeoutUrl: string; payheroCallbackUrl?: string | undefined }

/** Daraja client for a scoped account: STK and B2C are ready independently; a missing half FAILS LOUDLY. */
export class ScopedDarajaClient implements DarajaClient {
  private readonly http: HttpDarajaClient;
  constructor(private readonly cfg: DarajaConfig, private readonly stkMissing: string[], fetchImpl?: typeof fetch) {
    this.http = fetchImpl ? new HttpDarajaClient(cfg, fetchImpl) : new HttpDarajaClient(cfg);
  }
  async stkPush(a: StkPushArgs): Promise<StkPushResult> {
    if (this.stkMissing.length) throw new Error(`MPESA_NOT_CONFIGURED:${this.stkMissing.join(",")}`);
    return this.http.stkPush(a);
  }
  async stkPushQuery(id: string): Promise<StkQueryResult> {
    if (this.stkMissing.length) throw new Error(`MPESA_NOT_CONFIGURED:${this.stkMissing.join(",")}`);
    return this.http.stkPushQuery(id);
  }
  async b2cPayment(a: B2cArgs): Promise<B2cResult> {
    if (!this.cfg.consumerKey || !this.cfg.consumerSecret) throw new Error("MPESA_B2C_NOT_CONFIGURED:consumerKey,consumerSecret");
    return this.http.b2cPayment(a);   // HttpDarajaClient refuses an incomplete B2C set (MPESA_B2C_NOT_CONFIGURED)
  }
}

export interface ScopedClients { daraja: DarajaClient; megapay: MegaPayClient; payhero: PayHeroClient }

export function buildScopedClients(
  cfgs: Record<string, { settings: Record<string, string>; secrets: Record<string, string> } | null>,
  callbacks: GlobalCallbacks, fetchImpl?: typeof fetch,
): ScopedClients {
  const m = cfgs.mpesa;
  let daraja: DarajaClient = new UnconfiguredDarajaClient(["scope has no M-Pesa account"]);
  if (m) {
    const cfg = darajaConfigOf(m.settings, m.secrets, callbacks);
    daraja = new ScopedDarajaClient(cfg, missingDarajaCredentials(cfg), fetchImpl);
  }
  const mp = cfgs.megapay;
  let megapay: MegaPayClient = new UnconfiguredMegaPayClient(["scope has no Mega Pay account"]);
  if (mp) {
    const cfg = resolveMegaPayConfig({ env: mp.settings.env === "sandbox" ? "sandbox" : "production",
      apiKey: mp.secrets.api_key ?? "", email: mp.settings.email ?? "", ...(mp.settings.api_base ? { baseUrl: mp.settings.api_base } : {}) }, {});
    const miss = missingMegaPayCredentials(cfg);
    megapay = miss.length ? new UnconfiguredMegaPayClient(miss) : (fetchImpl ? new HttpMegaPayClient(cfg, fetchImpl) : new HttpMegaPayClient(cfg));
  }
  const ph = cfgs.payhero;
  let payhero: PayHeroClient = new UnconfiguredPayHeroClient(["scope has no PayHero account"]);
  if (ph) {
    const token = ph.secrets.basic_auth_token || (ph.secrets.api_username && ph.secrets.api_password
      ? Buffer.from(`${ph.secrets.api_username}:${ph.secrets.api_password}`).toString("base64") : "");
    const cfg = resolvePayHeroConfig({ basicAuthToken: token, channelId: ph.settings.channel_id ?? "",
      ...(ph.settings.base_url ? { baseUrl: ph.settings.base_url } : {}),
      ...((ph.settings.callback_url || callbacks.payheroCallbackUrl) ? { callbackUrl: ph.settings.callback_url || callbacks.payheroCallbackUrl! } : {}) }, {});
    const miss = missingPayHeroCredentials(cfg);
    payhero = miss.length ? new UnconfiguredPayHeroClient(miss) : (fetchImpl ? new HttpPayHeroClient(cfg, fetchImpl) : new HttpPayHeroClient(cfg));
  }
  return { daraja, megapay, payhero };
}

// ── the router PaymentService / AffiliateService use ────────────────────────────────────────────
export interface GatewayRouter {
  /** The brand's payment owner (cached briefly; NOTIFY-invalidated). */
  ownerScope(siteId: string | undefined): Promise<OwnerScope>;
  /** Live clients of a NON-global scope. */
  clients(scope: Exclude<PaymentScopeRef, "global">): Promise<ScopedClients>;
  /** Deposit rails a non-global scope can actually serve (complete configs). */
  depositRails(scope: Exclude<PaymentScopeRef, "global">): Promise<Set<string>>;
  /** Whether a non-global scope's M-Pesa B2C (payout) credentials are complete. */
  payoutsReady(scope: Exclude<PaymentScopeRef, "global">): Promise<boolean>;
}

// ── the service (console + router) ──────────────────────────────────────────────────────────────
export interface PaymentScopeServiceOptions {
  callbacks: () => Promise<GlobalCallbacks>;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export class PaymentScopeService implements GatewayRouter {
  private readonly ownerCache = new Map<string, { at: number; v: OwnerScope }>();
  private readonly clientCache = new Map<string, { fp: string; at: number; clients: ScopedClients; rails: Set<string>; payouts: boolean }>();
  private readonly ttl: number;
  constructor(private readonly repo: PaymentScopeRepository, private readonly opts: PaymentScopeServiceOptions) {
    this.ttl = opts.ttlMs ?? 30_000;
  }

  /** Drop every cached owner/client (NOTIFY payment_scopes_changed / payment_providers_changed). */
  invalidate(): void { this.ownerCache.clear(); this.clientCache.clear(); }

  // ── console ──
  schemas(role: string): Record<string, GatewaySchema> {
    return Object.fromEntries(SCOPED_GATEWAY_CODES.map((c) => [c, schemaForRole(c, role)]));
  }
  getConfig(actorId: string, role: string, code: string, type: ScopeType, id: string): Promise<ScopedConfigView> {
    scopedSchema(code);
    return this.repo.getConfig(actorId, role, code, type, id);
  }
  /**
   * Validate + encrypt + persist a scoped config. Settings merge over what the scope already stores;
   * supplied secrets merge over THIS scope's decrypted secrets only (never another scope's).
   */
  async setConfig(actorId: string, role: string, code: string, type: ScopeType, id: string, values: Record<string, unknown>): Promise<ScopedConfigView> {
    const schema = scopedSchema(code);
    const split = splitSubmissionWith(schema, values);
    for (const k of Object.keys(split.secrets)) if (String(split.secrets[k]).trim() === "") delete split.secrets[k];
    const current = await this.repo.getConfig(actorId, role, code, type, id);   // authorizes the scope
    const merged = { ...current.settings, ...split.settings };
    // a platform admin's account is live-money only (docs/43 §3.4)
    if (role !== "platform_superadmin") {
      if (code === "mpesa" && !merged.environment) merged.environment = "production";
      if ((code === "megapay" || code === "binance") && !merged.env) merged.env = "production";
      if (code === "paystack" && !merged.env) merged.env = "live";
    }
    const bad = ownerOnlyViolation(role, merged);
    if (bad) throw new Error(`OWNER_ONLY_FIELD: ${bad}`);
    const existingSecretKeys = Object.keys(current.secretMeta ?? {}).filter((k) => current.secretMeta[k]?.set);
    const issues = validateConfigWith(schema, { settings: merged, secrets: split.secrets }, existingSecretKeys);
    if (issues.length) { const e = new Error("VALIDATION") as Error & { issues: ValidationIssue[] }; e.issues = issues; throw e; }
    let ciphertext: string | null = null; let meta = current.secretMeta ?? {}; let encVersion = current.encVersion || 1;
    if (Object.keys(split.secrets).length) {
      const env = this.opts.env ?? process.env;
      if (!isEncryptionConfigured(env)) throw new Error("ENC_KEY_NOT_CONFIGURED");
      let secrets: Record<string, string> = { ...split.secrets };
      const stored = await this.repo.resolveConfig(code, type, id);
      if (stored?.secretCiphertext) { try { secrets = { ...decryptSecrets(stored.secretCiphertext, env), ...split.secrets }; } catch { /* rotated/corrupt: replace */ } }
      const enc = encryptSecrets(secrets, env);
      ciphertext = enc.ciphertext; meta = enc.meta; encVersion = enc.encVersion;
    }
    const saved = await this.repo.setConfig(actorId, role, code, type, id, merged, ciphertext, meta, encVersion);
    this.invalidate();
    return saved;
  }
  async clearConfig(actorId: string, role: string, code: string, type: ScopeType, id: string): Promise<boolean> {
    scopedSchema(code);
    const ok = await this.repo.clearConfig(actorId, role, code, type, id);
    this.invalidate();
    return ok;
  }
  /** What each gateway of a scope can do right now (drives the console + the go-live check). */
  async status(actorId: string, role: string, type: ScopeType, id: string): Promise<Record<string, GatewayStatus>> {
    await this.repo.assertScope(actorId, role, type, id);
    return this.statusInternal(type, id);
  }
  private async statusInternal(type: ScopeType, id: string): Promise<Record<string, GatewayStatus>> {
    const cb = await this.opts.callbacks();
    const out: Record<string, GatewayStatus> = {};
    for (const code of SCOPED_GATEWAY_CODES) {
      const d = await this.decrypted(code, type, id);
      out[code] = gatewayStatus(code, d?.settings ?? {}, d?.secrets ?? {}, cb, d !== null);
    }
    return out;
  }
  listScopes(actorId: string, role: string, platformId: string): Promise<ScopeState[]> { return this.repo.listScopes(actorId, role, platformId); }

  /** SAFE connectivity test of a scope's stored config overlaid with unsaved draft values. Never moves money. */
  async testConnection(actorId: string, role: string, code: string, type: ScopeType, id: string, draft: Record<string, unknown> = {}): Promise<ConnResult> {
    const schema = scopedSchema(code);
    await this.repo.assertScope(actorId, role, type, id);
    const split = splitSubmissionWith(schema, draft);
    for (const k of Object.keys(split.secrets)) if (String(split.secrets[k]).trim() === "") delete split.secrets[k];
    const stored = await this.decrypted(code, type, id);
    const settings = { ...(stored?.settings ?? {}), ...split.settings };
    const bad = ownerOnlyViolation(role, settings);   // a draft may not point the probe elsewhere either
    if (bad) throw new Error(`OWNER_ONLY_FIELD: ${bad}`);
    const cfg = { ...settings, ...(stored?.secrets ?? {}), ...split.secrets };
    const f = this.opts.fetchImpl ?? fetch;
    return code === "mpesa" ? probeDaraja(cfg, f) : probeGateway(code, cfg, f);
  }

  /**
   * Go live on this scope's accounts. Refused unless at least one deposit rail is complete AND (payouts
   * are ready OR the operator explicitly accepted "deposits only" with payoutsEnabled=false).
   */
  async activate(actorId: string, role: string, type: ScopeType, id: string, payoutsEnabled = true): Promise<Record<string, GatewayStatus>> {
    await this.repo.assertScope(actorId, role, type, id);
    const st = await this.statusInternal(type, id);
    const rails = Object.entries(st).filter(([c, s]) => PLAYER_DEPOSIT_RAILS.has(c) && s.depositsReady).map(([c]) => c);
    if (!rails.length) throw new Error("NO_DEPOSIT_RAIL_READY");
    if (payoutsEnabled && !st.mpesa?.payoutsReady) throw new Error("PAYOUTS_NOT_CONFIGURED");
    await this.repo.setActive(actorId, role, type, id, true, payoutsEnabled);
    this.invalidate();
    return st;
  }
  async deactivate(actorId: string, role: string, type: ScopeType, id: string): Promise<void> {
    await this.repo.setActive(actorId, role, type, id, false, true);
    this.invalidate();
  }

  // ── router ──
  async ownerScope(siteId: string | undefined): Promise<OwnerScope> {
    if (!siteId) return { scope: "global", payoutsEnabled: true };
    const hit = this.ownerCache.get(siteId);
    if (hit && Date.now() - hit.at < this.ttl) return hit.v;
    const v = await this.repo.ownerScope(siteId);
    this.ownerCache.set(siteId, { at: Date.now(), v });
    return v;
  }
  private async decrypted(code: string, type: ScopeType, id: string): Promise<{ settings: Record<string, string>; secrets: Record<string, string>; updatedAt: string | null } | null> {
    const r = await this.repo.resolveConfig(code, type, id);
    if (!r) return null;
    let secrets: Record<string, string> = {};
    if (r.secretCiphertext) { try { secrets = decryptSecrets(r.secretCiphertext, this.opts.env ?? process.env); } catch { secrets = {}; } }
    return { settings: r.settings ?? {}, secrets, updatedAt: r.updatedAt };
  }
  private async entry(scope: Exclude<PaymentScopeRef, "global">) {
    const p = parseScope(scope);
    if (p.type === "global") throw new Error("INVALID_SCOPE");
    const cached = this.clientCache.get(scope);
    if (cached && Date.now() - cached.at < this.ttl) return cached;
    const cfgs: Record<string, { settings: Record<string, string>; secrets: Record<string, string> } | null> = {};
    let fp = "";
    for (const code of ["mpesa", "megapay", "payhero"]) {
      const d = await this.decrypted(code, p.type, p.id);
      cfgs[code] = d ? { settings: d.settings, secrets: d.secrets } : null;
      fp += `${code}:${d?.updatedAt ?? "-"}|`;
    }
    const cb = await this.opts.callbacks();
    if (cached && cached.fp === fp) { cached.at = Date.now(); return cached; }
    const clients = buildScopedClients(cfgs, cb, this.opts.fetchImpl);
    const rails = new Set<string>();
    for (const code of ["mpesa", "megapay", "payhero"]) {
      const c = cfgs[code];
      if (c && gatewayStatus(code, c.settings, c.secrets, cb).depositsReady) rails.add(code);
    }
    const payouts = !!cfgs.mpesa && gatewayStatus("mpesa", cfgs.mpesa.settings, cfgs.mpesa.secrets, cb).payoutsReady;
    const e = { fp, at: Date.now(), clients, rails, payouts };
    this.clientCache.set(scope, e);
    return e;
  }
  async clients(scope: Exclude<PaymentScopeRef, "global">): Promise<ScopedClients> { return (await this.entry(scope)).clients; }
  async depositRails(scope: Exclude<PaymentScopeRef, "global">): Promise<Set<string>> { return (await this.entry(scope)).rails; }
  async payoutsReady(scope: Exclude<PaymentScopeRef, "global">): Promise<boolean> { return (await this.entry(scope)).payouts; }
}
