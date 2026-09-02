import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring "magic action" links for withdrawal moderation from an email (Issue 1).
 *
 * The alert email carries an Approve and a Reject link, each holding an HMAC-signed token scoped to
 * exactly {transaction, action, expiry}. Tapping a link opens a confirm page (a GET that NEVER
 * mutates — safe against email-client / security-scanner prefetching); the human then presses the
 * button, which POSTs the token to perform the action. No login/session is required — the signed
 * token itself authorizes that single action. Tokens are short-lived and, because approve/reject are
 * idempotent (they only act on a 'pending' row), replay is harmless.
 *
 * Signed with the existing SUPABASE_JWT_SECRET so no new secret is needed.
 */
export type WithdrawalActionKind = "approve" | "reject";
interface ActionClaims { t: string; a: WithdrawalActionKind; e: number }

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Build a token authorizing `action` on `txId`, valid for `ttlMs` (default 72h). */
export function signWithdrawalAction(txId: string, action: WithdrawalActionKind, secret: string, ttlMs = 72 * 3600_000): string {
  const claims: ActionClaims = { t: txId, a: action, e: Date.now() + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Verify a token; returns the claims or null (bad signature, malformed, or expired). */
export function verifyWithdrawalAction(token: string, secret: string): { txId: string; action: WithdrawalActionKind } | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  const a = b64urlToBuf(sig);
  const b = b64urlToBuf(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: ActionClaims;
  try { claims = JSON.parse(b64urlToBuf(body).toString("utf8")); } catch { return null; }
  if (!claims || (claims.a !== "approve" && claims.a !== "reject") || typeof claims.t !== "string") return null;
  if (typeof claims.e !== "number" || Date.now() > claims.e) return null;
  return { txId: claims.t, action: claims.a };
}
