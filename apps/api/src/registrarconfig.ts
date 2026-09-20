/**
 * registrarconfig.ts — per-platform domain-registrar (Namecheap) configuration (Issue 1 #3).
 *
 * Platform admins configure THEIR OWN registrar credentials so they can auto-provision their clients'
 * domains during onboarding. Storage + crypto follow the payment_provider_config pattern (migration
 * 0130 / 0142): the API KEY is AES-256-GCM encrypted in-process before it reaches Postgres (the DB
 * stores ciphertext only); non-secret fields (api_user, username, client_ip) live in plaintext
 * settings; the console only ever sees masked hints. A dedicated REGISTRAR_CONFIG_ENC_KEY is used,
 * falling back to the shared PAYMENTS_CONFIG_ENC_KEY so the feature works without a new prod secret.
 *
 * Authorization lives in the SECURITY DEFINER RPCs: a platform_admin may only read/write its OWN
 * platform's config; the system owner may act on any; site admins/players are refused.
 */
import { encryptSecrets, decryptSecrets, isEncryptionConfigured, type Querier } from "@invest254/engine";
import { detectEgressIp, makeNamecheapRegistrar, type RegistrarClient } from "./domains.js";

/** Dedicated key first, then fall back to the shared payments key (no new prod secret required). */
export const REGISTRAR_ENC_KEY_VARS = ["REGISTRAR_CONFIG_ENC_KEY", "PAYMENTS_CONFIG_ENC_KEY"] as const;

export interface RegistrarConfigView {
  platformId: string;
  providerCode: string;
  settings: Record<string, string>;                                   // api_user, username, client_ip
  secretMeta: Record<string, { set: boolean; last4: string }>;        // masked hints (never the key)
  hasSecret: boolean;
  encVersion: number;
  updatedAt: string | null;
  exists: boolean;
}
export interface RegistrarResolved { apiUser: string; userName: string; apiKey: string; clientIp: string }
export interface RegistrarDraft { apiUser?: string; userName?: string; clientIp?: string; apiKey?: string }

function mapView(v: Record<string, any>, platformId: string, code: string): RegistrarConfigView {
  return {
    platformId: String(v.platform_id ?? platformId),
    providerCode: String(v.provider_code ?? code),
    settings: (v.settings ?? {}) as Record<string, string>,
    secretMeta: (v.secret_meta ?? {}) as Record<string, { set: boolean; last4: string }>,
    hasSecret: Boolean(v.has_secret),
    encVersion: Number(v.enc_version ?? 1),
    updatedAt: v.updated_at ?? null,
    exists: Boolean(v.exists),
  };
}

export class RegistrarConfigService {
  constructor(private readonly q: Querier) {}

  /** Masked console read + the egress IP to whitelist and whether encryption is configured. */
  async get(actorId: string, actorRole: string, platformId: string, code = "namecheap"):
    Promise<RegistrarConfigView & { egressIp: string | null; encryptionConfigured: boolean }> {
    const r = await this.q.query("select fn_platform_get_registrar_config($1,$2,$3,$4) as v",
      [actorId, actorRole, platformId, code]);
    const v = (r.rows[0]?.v ?? {}) as Record<string, any>;
    return {
      ...mapView(v, platformId, code),
      egressIp: await detectEgressIp(),
      encryptionConfigured: isEncryptionConfigured(process.env, REGISTRAR_ENC_KEY_VARS),
    };
  }

  /**
   * Upsert config. Non-secret fields are MERGED over the stored settings (the RPC replaces the
   * settings jsonb wholesale, so we merge here to never drop an untouched field). The apiKey is the
   * only secret: provided & non-empty => encrypt+store; provided empty => clear; omitted => keep.
   */
  async set(actorId: string, actorRole: string, platformId: string, values: RegistrarDraft, code = "namecheap"):
    Promise<RegistrarConfigView> {
    const cur = await this.q.query("select fn_platform_get_registrar_config($1,$2,$3,$4) as v",
      [actorId, actorRole, platformId, code]);
    const settings: Record<string, string> = { ...((cur.rows[0]?.v?.settings ?? {}) as Record<string, string>) };
    if (typeof values.apiUser === "string") settings.api_user = values.apiUser.trim();
    if (typeof values.userName === "string") settings.username = values.userName.trim();
    if (typeof values.clientIp === "string") settings.client_ip = values.clientIp.trim();

    let ciphertext: string | null = null;                 // null => keep the stored secret
    let metaJson: string | null = null;
    let encVersion = 1;
    if (values.apiKey !== undefined) {
      const key = String(values.apiKey).trim();
      if (key === "") { ciphertext = ""; metaJson = "{}"; }   // clear
      else {
        if (!isEncryptionConfigured(process.env, REGISTRAR_ENC_KEY_VARS)) throw new Error("ENC_KEY_NOT_CONFIGURED");
        const enc = encryptSecrets({ api_key: key }, process.env, REGISTRAR_ENC_KEY_VARS);
        ciphertext = enc.ciphertext; metaJson = JSON.stringify(enc.meta); encVersion = enc.encVersion;
      }
    }
    const r = await this.q.query(
      "select fn_platform_set_registrar_config($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8) as v",
      [actorId, actorRole, platformId, code, JSON.stringify(settings), ciphertext, metaJson, encVersion]);
    return mapView((r.rows[0]?.v ?? {}) as Record<string, any>, platformId, code);
  }

  /** Provisioner path: decrypted creds for a platform, or null when unconfigured/incomplete. */
  async resolveDecrypted(platformId: string, code = "namecheap"): Promise<RegistrarResolved | null> {
    const r = await this.q.query("select fn_registrar_config_resolve($1,$2) as v", [platformId, code]);
    const v = r.rows[0]?.v as Record<string, any> | null | undefined;
    if (!v) return null;
    const settings = (v.settings ?? {}) as Record<string, string>;
    let apiKey = "";
    if (v.secret_ciphertext) {
      try { apiKey = (decryptSecrets(v.secret_ciphertext, process.env, REGISTRAR_ENC_KEY_VARS).api_key ?? "").trim(); }
      catch { apiKey = ""; }
    }
    const apiUser = (settings.api_user ?? "").trim();
    const userName = (settings.username ?? apiUser).trim();
    const clientIp = (settings.client_ip ?? "").trim();
    if (!apiUser || !apiKey) return null;                 // incomplete -> caller falls back to env
    return { apiUser, userName, apiKey, clientIp };
  }

  /** Build a live Namecheap client from a platform's stored config (ClientIp falls back to egress), or null. */
  async buildRegistrar(platformId: string, code = "namecheap"): Promise<RegistrarClient | null> {
    const creds = await this.resolveDecrypted(platformId, code);
    if (!creds) return null;
    const clientIp = creds.clientIp || (await detectEgressIp()) || "";
    return makeNamecheapRegistrar({ apiUser: creds.apiUser, userName: creds.userName, apiKey: creds.apiKey, clientIp });
  }

  /** SAFE read-only connectivity test (Namecheap getList): stored creds overlaid with unsaved draft. */
  async test(actorId: string, actorRole: string, platformId: string, draft: RegistrarDraft = {}, code = "namecheap"):
    Promise<{ ok: boolean; detail: string; egressIp: string | null }> {
    // Authorize (throws NOT_AUTHORIZED / PLATFORM_SCOPE_FORBIDDEN for out-of-scope callers).
    await this.q.query("select fn_platform_get_registrar_config($1,$2,$3,$4) as v", [actorId, actorRole, platformId, code]);
    const stored = await this.resolveDecrypted(platformId, code);
    const egressIp = await detectEgressIp();
    const apiUser = (draft.apiUser ?? stored?.apiUser ?? "").trim();
    const userName = (draft.userName ?? stored?.userName ?? apiUser).trim();
    const apiKey = (draft.apiKey ?? stored?.apiKey ?? "").trim();
    const clientIp = (draft.clientIp ?? stored?.clientIp ?? egressIp ?? "").trim();
    if (!apiUser || !apiKey) return { ok: false, detail: "Enter the Namecheap API user and API key first.", egressIp };
    try {
      await makeNamecheapRegistrar({ apiUser, userName, apiKey, clientIp }).listDomains();
      return { ok: true, detail: "Connected — Namecheap API responded successfully.", egressIp };
    } catch (e) {
      return { ok: false, detail: (e as Error).message.slice(0, 240), egressIp };
    }
  }
}
