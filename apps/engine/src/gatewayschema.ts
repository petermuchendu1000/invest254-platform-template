/**
 * gatewayschema.ts — the SINGLE SOURCE OF TRUTH for every deposit-gateway's configurable fields.
 *
 * Grounded in each provider's official API docs (verified 2026-09):
 *   • Mega Pay   — megapay.co.ke/backend/v2 ; body carries {api_key,email}. (apps/engine/src/megapay.ts)
 *   • Paystack   — https://api.paystack.co ; `Authorization: Bearer <secret_key>`; keys are prefixed
 *                  sk_test_/sk_live_ + pk_test_/pk_live_. (docs-v2.paystack.com/docs/api/authentication)
 *   • Binance Pay— https://bpay.binanceapi.com ; merchant apiKey + secretKey, HMAC-SHA512 signing.
 *                  (developers.binance.com — Merchant APIs, /binancepay/openapi/v2/order[/query])
 *   • PayHero    — https://backend.payhero.co.ke/api/v2 ; `Authorization: Basic <token>`; STK needs a
 *                  channel_id. (docs.payhero.co.ke/docs/authorization, .../get-payment-channels)
 *
 * The API serialises this registry to the browser so the config form renders exactly the fields the
 * backend validates — no drift, no guesswork. `secret:true` fields are AES-encrypted at rest and are
 * NEVER sent back to the browser (only a masked last-4 hint). Non-secret fields live in `settings`.
 */

export type FieldKind = "text" | "secret" | "select" | "url" | "email" | "number";

export interface GatewayField {
  key: string;
  label: string;
  kind: FieldKind;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string;
  /** Optional client+server format guard (serialised as a string so the UI can mirror it). */
  pattern?: string;
  group?: string;
}

export interface GatewaySchema {
  code: string;
  displayName: string;
  docsUrl: string;
  /** Short, human summary shown atop the config card. */
  blurb: string;
  /**
   * True only when a real PLAYER deposit rail is implemented for this gateway (an initiate endpoint +
   * a deposit-page tab). When false the gateway is CONFIG-ONLY: an admin can store & test credentials,
   * but it can NOT be switched "Live for players" and never appears on the player deposit sheet — so
   * the console never promises a deposit path the system can't actually serve.
   */
  playerAvailable: boolean;
  fields: GatewayField[];
}

/**
 * Provider codes with a working PLAYER deposit rail (initiate + settle + a deposit-page tab). Only these
 * may be enabled for players or returned by GET /deposits/providers. `mpesa` (Daraja) + `megapay` ship
 * today; paystack/binance/payhero are config-only until their rails land.
 */
export const PLAYER_DEPOSIT_RAILS = new Set<string>(["mpesa", "megapay", "payhero"]);

const ENV_SANDBOX_PROD: GatewayField["options"] = [
  { value: "sandbox", label: "Sandbox (test)" },
  { value: "production", label: "Production (live money)" },
];

export const GATEWAY_SCHEMAS: Record<string, GatewaySchema> = {
  megapay: {
    code: "megapay",
    displayName: "Mega Pay",
    docsUrl: "https://megapay.co.ke",
    playerAvailable: true,
    blurb: "M-Pesa STK deposit rail via Mega Pay. Both the API key and the account email travel in every request.",
    fields: [
      { key: "env", label: "Environment", kind: "select", secret: false, required: true, default: "sandbox", options: ENV_SANDBOX_PROD, help: "Production sends real STK prompts and moves real money." },
      { key: "email", label: "Account email", kind: "email", secret: false, required: true, placeholder: "billing@yourbrand.co.ke", help: "The email registered on your Mega Pay merchant account." },
      { key: "api_key", label: "API key", kind: "secret", secret: true, required: true, placeholder: "MGPY…", help: "Mega Pay API key. Stored encrypted; only the last 4 are ever shown." },
      { key: "api_base", label: "API base URL", kind: "url", secret: false, required: false, default: "https://megapay.co.ke/backend/v2", help: "Override only if Mega Pay gives you a different host." },
      { key: "callback_allowed_cidrs", label: "Callback allow-list (CIDRs)", kind: "text", secret: false, required: false, placeholder: "e.g. 41.90.0.0/16, 197.248.0.0/16", help: "Optional. Restrict which IPs may hit the webhook. Comma-separated." },
    ],
  },
  paystack: {
    code: "paystack",
    displayName: "Paystack",
    docsUrl: "https://docs-v2.paystack.com/docs/api/authentication",
    playerAvailable: false,
    blurb: "Cards, bank & mobile-money via Paystack. The secret key authenticates every server call and signs webhooks (HMAC-SHA512); the public key is safe for the browser.",
    fields: [
      { key: "env", label: "Environment", kind: "select", secret: false, required: true, default: "test", options: [ { value: "test", label: "Test" }, { value: "live", label: "Live" } ], help: "Must match your key prefixes (sk_test_/pk_test_ vs sk_live_/pk_live_)." },
      { key: "secret_key", label: "Secret key", kind: "secret", secret: true, required: true, placeholder: "sk_live_… / sk_test_…", pattern: "^sk_(test|live)_[A-Za-z0-9]+$", help: "Server-side key. Stored encrypted; never exposed to the browser." },
      { key: "public_key", label: "Public key", kind: "text", secret: false, required: true, placeholder: "pk_live_… / pk_test_…", pattern: "^pk_(test|live)_[A-Za-z0-9]+$", help: "Publishable key used by Paystack Inline in the browser." },
      { key: "callback_url", label: "Callback URL", kind: "url", secret: false, required: false, placeholder: "https://your-api/…/paystack/callback", help: "Optional redirect after checkout; the webhook is configured in the Paystack dashboard." },
    ],
  },
  binance: {
    code: "binance",
    displayName: "Binance Pay",
    docsUrl: "https://developers.binance.com",
    playerAvailable: false,
    blurb: "Crypto checkout via Binance Pay Merchant API. Requests are signed with HMAC-SHA512 using your merchant API key + secret.",
    fields: [
      { key: "env", label: "Environment", kind: "select", secret: false, required: true, default: "production", options: [ { value: "production", label: "Production" }, { value: "testnet", label: "Testnet" } ] },
      { key: "api_key", label: "Merchant API key", kind: "secret", secret: true, required: true, placeholder: "Binance Pay API key", help: "Sent as BinancePay-Certificate-SN. Stored encrypted." },
      { key: "api_secret", label: "Merchant API secret", kind: "secret", secret: true, required: true, placeholder: "Binance Pay API secret", help: "Used to HMAC-SHA512 sign each request. Stored encrypted." },
      { key: "merchant_id", label: "Merchant ID", kind: "text", secret: false, required: false, placeholder: "Optional merchant / sub-merchant id" },
      { key: "base_url", label: "API base URL", kind: "url", secret: false, required: false, default: "https://bpay.binanceapi.com", help: "Override only if Binance gives you a regional host." },
    ],
  },
  payhero: {
    code: "payhero",
    displayName: "PayHero",
    docsUrl: "https://docs.payhero.co.ke/docs/authorization",
    playerAvailable: true,
    blurb: "M-Pesa STK / bank / paybill routing via PayHero (the Lipwa API). Requests use Basic Auth — a token generated from your API Username + API Password (docs.payhero.co.ke/docs/authorization).",
    fields: [
      { key: "basic_auth_token", label: "Basic Auth token", kind: "secret", secret: true, required: true, placeholder: "Basic WHBpV0hE…", help: "PayHero dashboard → API Keys → Add new API Key → copy the Basic Authorization token. Sent verbatim as 'Authorization: Basic <token>'." },
      { key: "api_username", label: "API Username", kind: "secret", secret: true, required: false, placeholder: "e.g. XpiWHDe7Vy9OZqR8nUZs", help: "Shown once when the API key is created. Optional — used to regenerate the Basic token if needed." },
      { key: "api_password", label: "API Password", kind: "secret", secret: true, required: false, placeholder: "Shown once at key creation", help: "Combined with the API Username to form the Basic Auth token." },
      { key: "account_id", label: "Account ID", kind: "text", secret: false, required: false, placeholder: "e.g. 12038", help: "Your PayHero account ID." },
      { key: "channel_id", label: "Payment channel ID", kind: "text", secret: false, required: true, placeholder: "e.g. 1487", help: "The channel STK pushes are routed through (Get Payment Channels). REQUIRED — deposits fail with PAYHERO_NOT_CONFIGURED without it." },
      { key: "callback_url", label: "Callback URL", kind: "url", secret: false, required: false, placeholder: "https://your-api/…/payhero/callback", help: "Where PayHero posts the STK result." },
      { key: "base_url", label: "API base URL", kind: "url", secret: false, required: false, default: "https://backend.payhero.co.ke/api/v2", help: "PayHero API base. Override only if instructed." },
    ],
  },
};

export const GATEWAY_CODES = Object.keys(GATEWAY_SCHEMAS);

export function getSchema(code: string): GatewaySchema {
  const s = GATEWAY_SCHEMAS[code];
  if (!s) throw new Error("PROVIDER_NOT_CONFIGURABLE");
  return s;
}

/** Non-secret field keys (persisted in `settings`) and secret field keys (encrypted) for a provider. */
export function fieldKinds(code: string): { settingKeys: string[]; secretKeys: string[] } {
  const s = getSchema(code);
  return {
    settingKeys: s.fields.filter((f) => !f.secret).map((f) => f.key),
    secretKeys: s.fields.filter((f) => f.secret).map((f) => f.key),
  };
}

export interface SplitConfig { settings: Record<string, string>; secrets: Record<string, string> }

/** Split a flat {key:value} submission into non-secret settings + secret values, ignoring unknown keys. */
export function splitSubmission(code: string, values: Record<string, unknown>): SplitConfig {
  const s = getSchema(code);
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of s.fields) {
    if (!(f.key in values)) continue;
    const raw = values[f.key];
    if (raw === null || raw === undefined) continue;
    const str = String(raw);
    if (f.secret) secrets[f.key] = str;
    else settings[f.key] = str.trim();
  }
  return { settings, secrets };
}

export interface ValidationIssue { field: string; message: string }

/**
 * Validate a proposed config for a provider. `existingSecretKeys` lists secret fields that are ALREADY
 * stored — a required secret counts as satisfied if it is either supplied now or already on file, so an
 * admin editing non-secret settings need not re-type keys. Returns [] when valid.
 */
export function validateConfig(
  code: string,
  split: SplitConfig,
  existingSecretKeys: string[] = [],
): ValidationIssue[] {
  const s = getSchema(code);
  const issues: ValidationIssue[] = [];
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const urlRe = /^https?:\/\/[^\s]+$/;
  for (const f of s.fields) {
    const supplied = f.secret ? split.secrets[f.key] : split.settings[f.key];
    const has = supplied !== undefined && String(supplied).trim() !== "";
    const onFile = f.secret && existingSecretKeys.includes(f.key);
    if (f.required && !has && !onFile) { issues.push({ field: f.key, message: `${f.label} is required` }); continue; }
    if (!has) continue;
    const val = String(supplied).trim();
    if (f.kind === "email" && !emailRe.test(val)) issues.push({ field: f.key, message: `${f.label} must be a valid email` });
    if (f.kind === "url" && !urlRe.test(val)) issues.push({ field: f.key, message: `${f.label} must be a valid https URL` });
    if (f.kind === "select" && f.options && !f.options.some((o) => o.value === val)) issues.push({ field: f.key, message: `${f.label} is invalid` });
    if (f.pattern && !new RegExp(f.pattern).test(val)) issues.push({ field: f.key, message: `${f.label} has an unexpected format` });
  }
  return issues;
}
