import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";

/** Verified identity extracted from a trusted JWT. */
export interface AuthClaims { userId: string; role?: string; site?: string; platform?: string; raw: JWTPayload; }
export type Verifier = (token: string) => Promise<AuthClaims>;

type KeyInput = Uint8Array | ReturnType<typeof createRemoteJWKSet>;
interface VerifyOpts { issuer?: string; audience?: string; }

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
    return {
      userId,
      role: typeof (payload as any).role === "string" ? (payload as any).role : undefined,
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
