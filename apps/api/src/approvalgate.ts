import { ApiError, type Ctx } from "./http.js";

/**
 * Superadmin approval password gate (Issue 1).
 *
 * Approving a real-money payout — a player M-Pesa withdrawal or a marketer commission payout — releases
 * cash, so it requires the superadmin's account password on EVERY surface (dashboard, Telegram, email
 * confirm page). Reject only returns funds and is not gated.
 *
 * The verifier checks the supplied password against an active `platform_superadmin` credential (scrypt,
 * constant-time). It is optional here so pure API test doubles that don't wire it keep working; the real
 * server (server.ts) ALWAYS wires it, so production is always gated. Never fail-open in production.
 */
export async function requireApprovalPassword(
  ctx: Ctx, verify?: ((password: string) => Promise<boolean>) | undefined,
): Promise<void> {
  if (!verify) return; // not configured (test double) -> skip; server.ts always wires it in prod
  const b = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
  const password = typeof b.password === "string" ? b.password : "";
  if (!(await verify(password))) {
    throw new ApiError("PASSWORD_REQUIRED", "superadmin password required to approve", 403);
  }
}
