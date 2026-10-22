import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";

/** Verified identity extracted from a trusted JWT. */
export interface AuthClaims { userId: string; role?: string; site?: string; platform?: string; raw: JWTPayload; }
export type Verifier = (token: string) => Promise<AuthClaims>;

type KeyInput = Uint8Array | ReturnType<typeof createRemoteJWKSet>;
interface VerifyOpts { issuer?: string; audience?: string; }

/**
 * The roles this platform mints for itself (http.ts ROLE_RANK). A token can only be trusted as a
 * principal here if it carries one of these — a defence for the case where `iss`/`aud` are not pinned
 * (the default), under which ANY token validly signed with the shared SUPABASE_JWT_SECRET would
 * otherwise be accepted. A Supabase-Auth-minted token, for instance, carries role "authenticated",
 * which is not one of ours; such a token is now rejected rather than admitted as a rank-0 identity.
 */
const SELF_ISSUED_ROLES: ReadonlySet<string> = new Set([
  "player", "marketer", "admin", "platform_admin", "platform_superadmin",
]);

/** Low-level verifier from a resolved key/JWKS (also used directly in tests with a local JWKS). */
export function verifierFromKey(getKey: KeyInput, algorithms: string[], opts: VerifyOpts = {}): Verifier {
  return async (token: string): Promise<AuthClaims> => {
    if (!token) throw new Error("TOKEN_REQUIRED");
    const { payload } = await jwtVerify(token, getKey as any, {
      algorithms,
      ...(opts.issuer ? { issuer: opts.issuer } : {}),
      ...(opts.audience ? { audience: opts.audience } : {}),
    });
    const userId = String(payload.sub ?? "");
    if (!userId) throw new Error("TOKEN_MISSING_SUB");
    const role = typeof (payload as any).role === "string" ? (payload as any).role : undefined;
    // Reject a validly-signed token whose role is not one this platform issues (e.g. a Supabase-Auth
    // "authenticated" token on the same project). A roleless token is left alone — every token this
    // app mints carries a role, so the realistic foreign case (a non-empty, non-ours role) is covered
    // without risking a legacy self-issued token.
    if (role !== undefined && !SELF_ISSUED_ROLES.has(role)) throw new Error("TOKEN_FOREIGN_ROLE");
    return {
      userId,
      role,
      // Multi-tenant: the brand this token was issued for (engine enforces socket↔token match).
      site: typeof (payload as any).site === "string" ? (payload as any).site : undefined,
      // Platform tier (Issue 1): the platform a platform_admin is scoped to (minted only for that role).
      platform: typeof (payload as any).platform === "string" ? (payload as any).platform : undefined,
      raw: payload,
    };
  };
}

/**
 * Build a verifier from environment:
 *  - SUPABASE_JWKS_URL  -> asymmetric (RS256/ES256), keys fetched & cached from JWKS.
 *  - SUPABASE_JWT_SECRET -> symmetric HS256 (legacy Supabase projects).
 * Returns null if neither is configured (caller decides whether that is acceptable).
 */
export function makeVerifier(env: NodeJS.ProcessEnv = process.env): Verifier | null {
  const opts: VerifyOpts = {
    ...(env.SUPABASE_JWT_ISSUER ? { issuer: env.SUPABASE_JWT_ISSUER } : {}),
    ...(env.SUPABASE_JWT_AUD ? { audience: env.SUPABASE_JWT_AUD } : {}),
  };
  if (env.SUPABASE_JWKS_URL) return verifierFromKey(createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL)), ["RS256", "ES256"], opts);
  if (env.SUPABASE_JWT_SECRET) return verifierFromKey(new TextEncoder().encode(env.SUPABASE_JWT_SECRET), ["HS256"], opts);
  return null;
}
