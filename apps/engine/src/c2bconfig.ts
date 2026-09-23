import type { Querier } from "./wallet.js";
import { loadDarajaConfigFromDb } from "./admin.js";
import { registerC2bUrls, resolveDarajaConfig, type C2bRegisterResult, type DarajaConfig } from "./daraja.js";

/**
 * PAY-2 (docs/45, migration 0163): C2B (customer-initiated Pay Bill / Till) settings for the System owner —
 * what players are told to pay into, the Confirmation/Validation URLs, and the Safaricom URL registration.
 * Authorization + validation + audit live in the RPCs; this layer adds the Daraja RegisterURL call.
 */
export interface C2bConfig {
  enabled: boolean; shortcode: string; accountNumber: string; businessName: string; instructions: string;
  confirmationUrl: string; validationUrl: string; responseType: "Completed" | "Cancelled";
  registeredAtMs: number | null; registeredShortcode: string | null; registeredConfirmationUrl: string | null;
  lastRegisterAtMs: number | null; lastRegisterOk: boolean | null; lastRegisterMessage: string | null;
  received7d: number; unclaimed: number; lastReceivedAtMs: number | null; updatedAtMs: number | null;
  /** Derived: the saved Pay Bill + confirmation URL match what Safaricom was last told. */
  registrationCurrent: boolean;
}
export type C2bPatch = Partial<Pick<C2bConfig, "enabled" | "shortcode" | "accountNumber" | "businessName" | "instructions" | "confirmationUrl" | "validationUrl" | "responseType">>;

export interface C2bConfigRepository {
  get(actor: string, role: string): Promise<C2bConfig>;
  update(actor: string, role: string, patch: C2bPatch): Promise<void>;
  recordRegistration(actor: string, role: string, shortcode: string, confirmationUrl: string, ok: boolean, message: string): Promise<void>;
}

const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());

export class PgC2bConfigRepository implements C2bConfigRepository {
  constructor(private readonly q: Querier) {}
  async get(actor: string, role: string): Promise<C2bConfig> {
    const r = await this.q.query("select * from fn_admin_get_c2b_config($1, $2)", [actor, role]);
    const x = r.rows[0];
    if (!x) throw new Error("NOT_FOUND");
    const cfg: C2bConfig = {
      enabled: Boolean(x.enabled), shortcode: String(x.shortcode ?? ""), accountNumber: String(x.account_number ?? ""),
      businessName: String(x.business_name ?? ""), instructions: String(x.instructions ?? ""),
      confirmationUrl: String(x.confirmation_url ?? ""), validationUrl: String(x.validation_url ?? ""),
      responseType: x.response_type === "Cancelled" ? "Cancelled" : "Completed",
      registeredAtMs: ms(x.registered_at), registeredShortcode: x.registered_shortcode ?? null,
      registeredConfirmationUrl: x.registered_confirmation_url ?? null,
      lastRegisterAtMs: ms(x.last_register_at), lastRegisterOk: x.last_register_ok ?? null, lastRegisterMessage: x.last_register_message ?? null,
      received7d: Number(x.received_7d ?? 0), unclaimed: Number(x.unclaimed ?? 0), lastReceivedAtMs: ms(x.last_received_at),
      updatedAtMs: ms(x.updated_at), registrationCurrent: false,
    };
    cfg.registrationCurrent = !!cfg.registeredAtMs && cfg.registeredShortcode === cfg.shortcode && cfg.registeredConfirmationUrl === cfg.confirmationUrl;
    return cfg;
  }
  async update(actor: string, role: string, patch: C2bPatch): Promise<void> {
    await this.q.query("select fn_admin_update_c2b_config($1, $2, $3::jsonb)", [actor, role, JSON.stringify(patch)]);
  }
  async recordRegistration(actor: string, role: string, shortcode: string, confirmationUrl: string, ok: boolean, message: string): Promise<void> {
    await this.q.query("select fn_admin_record_c2b_registration($1, $2, $3, $4, $5, $6)", [actor, role, shortcode, confirmationUrl, ok, message]);
  }
}

export class C2bConfigService {
  constructor(
    private readonly repo: C2bConfigRepository,
    private readonly opts: { darajaConfig: () => Promise<Pick<DarajaConfig, "env" | "consumerKey" | "consumerSecret">>; fetchImpl?: typeof fetch },
  ) {}
  get(actor: string, role: string): Promise<C2bConfig> { return this.repo.get(actor, role); }
  async update(actor: string, role: string, patch: C2bPatch): Promise<C2bConfig> {
    await this.repo.update(actor, role, patch);
    return this.repo.get(actor, role);
  }
  /** Register the saved URLs for the saved Pay Bill with Safaricom, and record the outcome either way. */
  async register(actor: string, role: string): Promise<C2bRegisterResult & { config: C2bConfig }> {
    const c = await this.repo.get(actor, role);   // authorizes (owner tier)
    if (!c.shortcode) throw new Error("C2B_SHORTCODE_REQUIRED");
    if (!c.confirmationUrl) throw new Error("C2B_CONFIRMATION_URL_REQUIRED");
    const res = await registerC2bUrls(await this.opts.darajaConfig(),
      { shortCode: c.shortcode, responseType: c.responseType, confirmationUrl: c.confirmationUrl, validationUrl: c.validationUrl },
      this.opts.fetchImpl ?? fetch);
    await this.repo.recordRegistration(actor, role, c.shortcode, c.confirmationUrl, res.ok, res.message);
    return { ...res, config: await this.repo.get(actor, role) };
  }
}

/** The System Daraja app credentials (DB over env) — what RegisterURL authenticates with. */
export function systemDarajaCredentials(q: Querier, env: NodeJS.ProcessEnv = process.env) {
  return async () => {
    const c = resolveDarajaConfig(await loadDarajaConfigFromDb(q), env);
    return { env: c.env, consumerKey: c.consumerKey, consumerSecret: c.consumerSecret };
  };
}
