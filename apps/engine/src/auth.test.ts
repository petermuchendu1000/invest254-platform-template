import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { verifierFromKey } from "./auth.js";

const HS = new TextEncoder().encode("test-secret-which-is-long-enough-123456");

async function hsToken(sub: string, opts: { exp?: string; role?: string } = {}) {
  return new SignJWT({ role: opts.role ?? "player" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h").sign(HS);
}

test("HS256: valid token verifies and yields the sub as userId", async () => {
  const verify = verifierFromKey(HS, ["HS256"]);
  const tok = await hsToken("user-123", { role: "marketer" });
  const c = await verify(tok);
  assert.equal(c.userId, "user-123");
  assert.equal(c.role, "marketer");
});

test("HS256: tampered token is rejected", async () => {
  const verify = verifierFromKey(HS, ["HS256"]);
  const tok = await hsToken("user-123");
  const parts = tok.split("."); parts[1] = parts[1]!.slice(0, -2) + "AA"; // corrupt payload
  await assert.rejects(() => verify(parts.join(".")));
});

test("HS256: expired token is rejected", async () => {
  const verify = verifierFromKey(HS, ["HS256"]);
  const tok = await hsToken("user-123", { exp: "-1s" });
  await assert.rejects(() => verify(tok));
});

test("HS256: wrong secret is rejected", async () => {
  const verify = verifierFromKey(new TextEncoder().encode("a-different-secret-aaaaaaaaaaaaaaaaaa"), ["HS256"]);
  const tok = await hsToken("user-123");
  await assert.rejects(() => verify(tok));
});

test("token without sub is rejected", async () => {
  const verify = verifierFromKey(HS, ["HS256"]);
  const tok = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(HS);
  await assert.rejects(() => verify(tok), /TOKEN_MISSING_SUB/);
});

test("AU1: a validly-signed token with a FOREIGN role is rejected", async () => {
  const verify = verifierFromKey(HS, ["HS256"]);
  // e.g. a Supabase-Auth token on the same project — correct signature, but role 'authenticated'
  // is not one this platform issues, so it must not be admitted as a principal.
  const tok = await hsToken("user-123", { role: "authenticated" });
  await assert.rejects(() => verify(tok), /TOKEN_FOREIGN_ROLE/);
  for (const r of ["anon", "service_role", "supabase_admin", "superadmin"]) {
    const t = await hsToken("u", { role: r });
    await assert.rejects(() => verify(t), /TOKEN_FOREIGN_ROLE/);
  }
});

test("AU1: every self-issued role is accepted", async () => {
  const verify = verifierFromKey(HS, ["HS256"]);
  for (const r of ["player", "marketer", "admin", "platform_admin", "platform_superadmin"]) {
    const c = await verify(await hsToken("u", { role: r }));
    assert.equal(c.role, r);
  }
});

test("AU1: a roleless token is left alone (not every mint carries a role historically)", async () => {
  const verify = verifierFromKey(HS, ["HS256"]);
  const tok = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("u").setExpirationTime("1h").sign(HS);
  const c = await verify(tok);
  assert.equal(c.role, undefined);
});

test("asymmetric (RS256 via JWKS): valid token verifies", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: any = await exportJWK(publicKey); jwk.kid = "k1"; jwk.alg = "RS256"; jwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const verify = verifierFromKey(jwks as any, ["RS256"]);
  const tok = await new SignJWT({ role: "player" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setSubject("user-rsa").setExpirationTime("1h").sign(privateKey);
  const c = await verify(tok);
  assert.equal(c.userId, "user-rsa");
});
