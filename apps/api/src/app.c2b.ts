import { Router, ApiError, requireAuth, requireRole, type Ctx } from "./http.js";
import type { C2bConfigService, C2bPatch } from "@invest254/engine";
import type { ApiDeps } from "./app.js";

/**
 * PAY-2 (docs/45) — C2B (Pay Bill / Till) settings for the System owner.
 *   GET   /admin/c2b-config            the Pay Bill players pay into, C2B URLs, registration state, health
 *   PATCH /admin/c2b-config            update (validated + audited in fn_admin_update_c2b_config)
 *   POST  /admin/c2b-config/register   register the URLs with Safaricom (Daraja C2B RegisterURL v2)
 * Owner tier only, like the M-Pesa defaults they sit beside.
 */
const BASE = "/api/v1";
const STATUS: Readonly<Record<string, number>> = {
  NOT_AUTHORIZED: 403, NOT_FOUND: 404,
  INVALID_CONFIG: 400, INVALID_SHORTCODE: 400, INVALID_ACCOUNT_NUMBER: 400, INVALID_BUSINESS_NAME: 400,
  INVALID_INSTRUCTIONS: 400, INVALID_C2B_URL: 400,
  C2B_SHORTCODE_REQUIRED: 409, C2B_CONFIRMATION_URL_REQUIRED: 409,
};
const MESSAGES: Readonly<Record<string, string>> = {
  INVALID_SHORTCODE: "The Pay Bill / Till number must be 5–7 digits.",
  INVALID_ACCOUNT_NUMBER: "The account number can be at most 20 characters.",
  INVALID_BUSINESS_NAME: "The business name can be at most 60 characters.",
  INVALID_INSTRUCTIONS: "Instructions can be at most 500 characters.",
  INVALID_C2B_URL: "C2B URLs must be public https links and must not contain the words M-PESA, Safaricom, exec, cmd, sql or query (Safaricom rejects them).",
  C2B_SHORTCODE_REQUIRED: "Save the Pay Bill / Till number first.",
  C2B_CONFIRMATION_URL_REQUIRED: "Save a confirmation URL first.",
};

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    const status = STATUS[code];
    if (status) throw new ApiError(code, MESSAGES[code] ?? message, status);
    throw err;
  }
}

const KEYS = ["enabled", "shortcode", "accountNumber", "businessName", "instructions", "confirmationUrl", "validationUrl", "responseType"] as const;

export function parseC2bPatch(body: unknown): C2bPatch {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    if (!(k in b)) continue;
    const v = b[k];
    if (k === "enabled") { if (typeof v !== "boolean") throw new ApiError("VALIDATION", "enabled must be true or false", 400); out[k] = v; continue; }
    if (typeof v !== "string") throw new ApiError("VALIDATION", `${k} must be text`, 400);
    if (k === "responseType" && v !== "Completed" && v !== "Cancelled") throw new ApiError("VALIDATION", "responseType must be Completed or Cancelled", 400);
    out[k] = v.trim();
  }
  if (Object.keys(out).length === 0) throw new ApiError("VALIDATION", "nothing to update", 400);
  return out as C2bPatch;
}

export function registerC2bRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const ownerTier = requireRole("platform_superadmin");
  const need = (): C2bConfigService => {
    if (!deps.c2b) throw new ApiError("NOT_CONFIGURED", "C2B settings are not available on this deployment", 503);
    return deps.c2b;
  };
  const who = (ctx: Ctx) => [ctx.claims!.userId, ctx.claims!.role ?? "player"] as const;

  router.get(`${BASE}/admin/c2b-config`, auth, ownerTier, async (ctx: Ctx) => {
    const [a, r] = who(ctx); return domain(() => need().get(a, r));
  });
  router.patch(`${BASE}/admin/c2b-config`, auth, ownerTier, async (ctx: Ctx) => {
    const patch = parseC2bPatch(ctx.body); const [a, r] = who(ctx);
    return domain(() => need().update(a, r, patch));
  });
  router.post(`${BASE}/admin/c2b-config/register`, auth, ownerTier, async (ctx: Ctx) => {
    const [a, r] = who(ctx); return domain(() => need().register(a, r));
  });
}
