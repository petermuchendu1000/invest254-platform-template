import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthService, hashPassword, verifyPassword } from "./authservice.js";
import { totpCode } from "@invest254/shared";
import { InMemoryIdentityRepository, type IdentityRepository } from "./identity.js";
import { verifierFromKey } from "./auth.js";

const SECRET = "test-secret-which-is-long-enough-123456";
const HS = new TextEncoder().encode(SECRET);

function svc(repo: IdentityRepository = new InMemoryIdentityRepository()) {
  return { repo, auth: new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600 }) };
}

// ── password hashing ───────────────────────────────────────────────────────
test("hashPassword/verifyPassword round-trips and rejects the wrong password", async () => {
  const h = await hashPassword("Sup3rSecret!");
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
  assert.equal(await verifyPassword("Sup3rSecret!", h), true);
  assert.equal(await verifyPassword("wrong-password-1", h), false);
});

test("verifyPassword returns false for a malformed stored hash", async () => {
  assert.equal(await verifyPassword("whatever1", "not-a-hash"), false);
  assert.equal(await verifyPassword("whatever1", "scrypt$bad"), false);
});

// ── registration ───────────────────────────────────────────────────
test("register issues an HS256 token verifiable by makeVerifier's verifier", async () => {
  const { auth } = svc();
  const s = await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  assert.ok(s.userId);
  assert.equal(s.role, "player");
  const claims = await verifierFromKey(HS, ["HS256"])(s.token);
  assert.equal(claims.userId, s.userId);
  assert.equal(claims.role, "player");
});

test("register rejects weak password and bad username before touching the repo", async () => {
  const { auth } = svc();
  await assert.rejects(() => auth.register({ phone: "0712345678", username: "alice", password: "short" }), /PASSWORD_TOO_SHORT/);
  await assert.rejects(() => auth.register({ phone: "0712345678", username: "al", password: "Password1" }), /USERNAME_TOO_SHORT/);
  await assert.rejects(() => auth.register({ phone: "not-a-phone", username: "alice", password: "Password1" }), /INVALID_PHONE/);
});

test("register surfaces PHONE_TAKEN and USERNAME_TAKEN", async () => {
  const { auth } = svc();
  await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  await assert.rejects(() => auth.register({ phone: "0712345678", username: "bob", password: "Password1" }), /PHONE_TAKEN/);
  await assert.rejects(() => auth.register({ phone: "0722222222", username: "alice", password: "Password1" }), /USERNAME_TAKEN/);
});

// ── login ───────────────────────────────────────────────────────────
test("register grants the one-time welcome bonus and surfaces its cents when configured", async () => {
  const repo = new InMemoryIdentityRepository();
  repo.welcomeBonusCents = 20_000; // KES 200
  const auth = new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600 });
  const s = await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  assert.equal(s.welcomeBonusCents, 20_000);
  // one welcome bonus per user: a second grant for the same account yields nothing
  assert.equal(await repo.grantWelcomeBonus(s.userId), 0);
});

test("register omits welcomeBonusCents when the welcome bonus is disabled/zero", async () => {
  const { auth } = svc(); // default InMemory welcomeBonusCents = 0
  const s = await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  assert.equal(s.welcomeBonusCents, undefined);
});

test("a welcome-bonus grant failure never blocks a successful registration", async () => {
  const repo = new InMemoryIdentityRepository();
  repo.grantWelcomeBonus = async () => { throw new Error("DB_DOWN"); };
  const auth = new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600 });
  const s = await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  assert.ok(s.userId);                   // registration still succeeded
  assert.equal(s.welcomeBonusCents, undefined);
});

test("login succeeds with correct credentials and returns a fresh token", async () => {
  const { auth } = svc();
  const reg = await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  const s = await auth.login({ phone: "+254712345678", password: "Password1" }); // any accepted phone format
  assert.equal(s.userId, reg.userId);
  assert.equal(s.role, "player");
  assert.equal((await verifierFromKey(HS, ["HS256"])(s.token)).userId, reg.userId);
});

test("login rejects wrong password and unknown phone with a generic error", async () => {
  const { auth } = svc();
  await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  await assert.rejects(() => auth.login({ phone: "0712345678", password: "WrongPass9" }), /INVALID_CREDENTIALS/);
  await assert.rejects(() => auth.login({ phone: "0700000000", password: "Password1" }), /INVALID_CREDENTIALS/);
  await assert.rejects(() => auth.login({ phone: "garbage", password: "Password1" }), /INVALID_CREDENTIALS/);
});

test("login is NOT gated on status — a limited account can still sign in to deposit", async () => {
  const repo = new InMemoryIdentityRepository();
  const { auth } = svc(repo);
  const reg = await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  // A suspended (limited) player can still log in — trading/withdrawal are blocked at the money
  // layer, but the account must be able to deposit and view its balance.
  repo.setStatus("254712345678", "suspended");
  const s1 = await auth.login({ phone: "0712345678", password: "Password1" });
  assert.equal(s1.userId, reg.userId);
  // Even a banned account can sign in (so it can still deposit); cash-out is blocked elsewhere.
  repo.setStatus("254712345678", "banned");
  const s2 = await auth.login({ phone: "0712345678", password: "Password1" });
  assert.equal(s2.userId, reg.userId);
});

test("AuthService requires a jwt secret", () => {
  assert.throws(() => new AuthService(new InMemoryIdentityRepository(), { jwtSecret: "" }), /JWT_SECRET_REQUIRED/);
});

// ── basic-KYC profile (H1) ─────────────────────────────────────────────────────────────────
test("me reflects the registered profile", async () => {
  const { auth } = svc();
  const reg = await auth.register({ phone: "0712345678", username: "alice", password: "Password1" });
  const me = await auth.me(reg.userId);
  assert.equal(me.username, "alice");
  assert.equal(me.role, "player");
  assert.equal(me.status, "active");
});

test("me throws NOT_FOUND for an unknown user", async () => {
  const { auth } = svc();
  await assert.rejects(() => auth.me("no-such-user"), /NOT_FOUND/);
});

// ── admin MFA (TOTP) ─────────────────────────────────────────────────────────────────────────
const PHONE = "0712345678";
const PASS = "Sup3rSecret!";
/** A code that is guaranteed NOT to be the live one (avoids a 1-in-a-million flake). */
const notThe = (valid: string): string => (valid === "000000" ? "111111" : "000000");

/** Register an operator and complete TOTP enrolment; returns the enrolment payload. */
async function enrolledOperator(mfaRequiredRoles?: readonly string[]) {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, {
    jwtSecret: SECRET, jwtTtlSeconds: 3600,
    ...(mfaRequiredRoles ? { mfaRequiredRoles } : {}),
  });
  const s = await auth.register({ phone: PHONE, username: "operator", password: PASS });
  const enrol = await auth.beginMfaEnrolment(s.userId);
  await auth.confirmMfa(s.userId, totpCode(enrol.secret));
  return { repo, auth, userId: s.userId, enrol };
}

test("MFA: once enabled, login demands a valid TOTP code", async () => {
  const { auth, enrol } = await enrolledOperator();
  await assert.rejects(() => auth.login({ phone: PHONE, password: PASS }), /MFA_REQUIRED/);
  await assert.rejects(
    () => auth.login({ phone: PHONE, password: PASS, totp: notThe(totpCode(enrol.secret)) }),
    /MFA_INVALID/);
  const ok = await auth.login({ phone: PHONE, password: PASS, totp: totpCode(enrol.secret) });
  assert.ok(ok.token);
  assert.equal(ok.mfaEnrolmentRequired, undefined);
});

test("MFA: enrolment stays inactive until a live code confirms the device", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600 });
  const s = await auth.register({ phone: PHONE, username: "operator", password: PASS });
  const enrol = await auth.beginMfaEnrolment(s.userId);
  assert.match(enrol.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal(enrol.recoveryCodes.length, 8);
  await assert.rejects(() => auth.confirmMfa(s.userId, notThe(totpCode(enrol.secret))), /MFA_INVALID/);
  assert.equal((await auth.mfaStatus(s.userId)).enabled, false);
  // MFA was never enabled, so the password alone still logs in (no lockout from a bad scan).
  assert.ok((await auth.login({ phone: PHONE, password: PASS })).token);
});

test("MFA: a recovery code works exactly once", async () => {
  const { auth, userId, enrol } = await enrolledOperator();
  const code = enrol.recoveryCodes[0]!;
  assert.equal((await auth.mfaStatus(userId)).recoveryCodesLeft, 8);
  assert.ok((await auth.login({ phone: PHONE, password: PASS, recoveryCode: code })).token);
  assert.equal((await auth.mfaStatus(userId)).recoveryCodesLeft, 7); // burned
  await assert.rejects(() => auth.login({ phone: PHONE, password: PASS, recoveryCode: code }), /MFA_INVALID/);
});

test("MFA: a privileged role that hasn't enrolled is admitted but flagged (grace period)", async () => {
  const repo = new InMemoryIdentityRepository();
  // Treat 'player' as privileged here so the flag can be exercised without mutating roles.
  const auth = new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600, mfaRequiredRoles: ["player"] });
  await auth.register({ phone: PHONE, username: "operator", password: PASS });
  const s = await auth.login({ phone: PHONE, password: PASS });
  assert.equal(s.mfaEnrolmentRequired, true);
  assert.ok(s.token); // never locked out of their own back office
  assert.equal((await auth.mfaStatus(s.userId)).required, true);
});

test("MFA: disabling requires a valid factor and restores password-only login", async () => {
  const { auth, userId, enrol } = await enrolledOperator();
  await assert.rejects(() => auth.disableMfa(userId, notThe(totpCode(enrol.secret))), /MFA_INVALID/);
  assert.equal((await auth.mfaStatus(userId)).enabled, true);
  await auth.disableMfa(userId, totpCode(enrol.secret));
  assert.equal((await auth.mfaStatus(userId)).enabled, false);
  assert.ok((await auth.login({ phone: PHONE, password: PASS })).token);
});

// ── password change / reset ──────────────────────────────────────────────────────────────────
test("changePassword: requires the current password, then the new one works", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600 });
  const s = await auth.register({ phone: PHONE, username: "operator", password: PASS });
  await assert.rejects(() => auth.changePassword(s.userId, "wrong-password-9", "Brand3wPass"), /INVALID_CREDENTIALS/);
  await assert.rejects(() => auth.changePassword(s.userId, PASS, "short"), /PASSWORD_TOO_SHORT/);
  assert.deepEqual(await auth.changePassword(s.userId, PASS, "Brand3wPass"), { changed: true });
  await assert.rejects(() => auth.login({ phone: PHONE, password: PASS }), /INVALID_CREDENTIALS/);
  assert.ok((await auth.login({ phone: PHONE, password: "Brand3wPass" })).token);
});

test("resetPassword: refused unless unverified reset is explicitly enabled", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600 });
  await auth.register({ phone: PHONE, username: "operator", password: PASS });
  await assert.rejects(() => auth.resetPassword(PHONE, "Brand3wPass"), /RESET_DISABLED/);
  // the old password still works — nothing was changed
  assert.ok((await auth.login({ phone: PHONE, password: PASS })).token);
});

test("resetPassword: when enabled, sets the new password and rejects a weak one", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600, allowUnverifiedPasswordReset: true });
  await auth.register({ phone: PHONE, username: "operator", password: PASS });
  await assert.rejects(() => auth.resetPassword(PHONE, "short"), /PASSWORD_TOO_SHORT/);
  await assert.rejects(() => auth.resetPassword("not-a-phone", "Brand3wPass"), /INVALID_PHONE/);
  assert.deepEqual(await auth.resetPassword("0712345678", "Brand3wPass"), { reset: true });
  assert.ok((await auth.login({ phone: PHONE, password: "Brand3wPass" })).token);
  await assert.rejects(() => auth.login({ phone: PHONE, password: PASS }), /INVALID_CREDENTIALS/);
});

test("resetPassword: unknown phone returns the same shape (no account enumeration)", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET, jwtTtlSeconds: 3600, allowUnverifiedPasswordReset: true });
  assert.deepEqual(await auth.resetPassword("0700000000", "Brand3wPass"), { reset: true });
});
