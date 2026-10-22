import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthService, isTokenSessionValid, isPrivilegedRole, isSessionGatedRole } from "./authservice.js";
import { InMemoryIdentityRepository } from "./identity.js";
import { isValidSecurityQuestionKey } from "@invest254/shared";

/*
 * Security-questions second factor (0097) — the fix for phone-only admin password-reset takeover.
 * Covers: fail-closed privileged reset, answer verification (correct / wrong / partial / normalized),
 * setup validation, setup-required gating by role, reset-question key disclosure (anti-enumeration),
 * force-logout (session epoch) enforcement, and that the player reset path is unchanged.
 */

const SECRET = "test-secret-which-is-long-enough-123456";

/** A privileged (admin) account seeded in the in-memory repo, returning its userId + phone. */
async function seedAdmin(repo: InMemoryIdentityRepository, auth: AuthService, phone = "0712345678", role = "admin") {
  const s = await auth.register({ phone, username: "adminuser", password: "Password1" });
  repo._setRole(s.userId, role);
  return { userId: s.userId, phone };
}

const GOOD_ANSWERS = [
  { key: "first_pet", answer: "Rex" },
  { key: "birth_city", answer: "Nairobi" },
  { key: "first_school", answer: "St. Mary's" },
];

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────
test("isPrivilegedRole covers admin/platform_admin/platform_superadmin, not player/marketer", () => {
  for (const r of ["admin", "platform_admin", "platform_superadmin"]) assert.equal(isPrivilegedRole(r), true);
  assert.equal(isPrivilegedRole("superadmin"), false, "the legacy superadmin role is gone (Issue 1 / F1)");
  for (const r of ["player", "marketer", "", undefined, null]) assert.equal(isPrivilegedRole(r as string), false);
});

test("isTokenSessionValid: null epoch always valid; before epoch revoked; at/after epoch valid; no iat fails closed", () => {
  assert.equal(isTokenSessionValid(1000, null), true);
  assert.equal(isTokenSessionValid(1000, 2_000_000), false); // 1000s = 1_000_000ms < 2_000_000ms
  assert.equal(isTokenSessionValid(3000, 2_000_000), true);  // 3_000_000ms >= 2_000_000ms
  assert.equal(isTokenSessionValid(undefined, 1), false);
});

// ── set security answers (validation) ─────────────────────────────────────────────────────────
test("setSecurityAnswers stores three answers; securitySetupRequired flips true→false", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId } = await seedAdmin(repo, auth);
  assert.equal(await auth.securitySetupRequired(userId), true);
  await auth.setSecurityAnswers(userId, GOOD_ANSWERS);
  assert.equal(await repo.countSecurityAnswers(userId), 3);
  assert.equal(await auth.securitySetupRequired(userId), false);
});

test("setSecurityAnswers rejects too few, duplicate keys, unknown keys, and trivially short answers", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId } = await seedAdmin(repo, auth);
  await assert.rejects(() => auth.setSecurityAnswers(userId, GOOD_ANSWERS.slice(0, 2)), /SECURITY_ANSWERS_TOO_FEW/);
  await assert.rejects(
    () => auth.setSecurityAnswers(userId, [GOOD_ANSWERS[0]!, GOOD_ANSWERS[0]!, GOOD_ANSWERS[1]!]),
    /SECURITY_ANSWERS_DUPLICATE_KEY/,
  );
  await assert.rejects(
    () => auth.setSecurityAnswers(userId, [{ key: "not_a_real_key", answer: "x" }, ...GOOD_ANSWERS.slice(0, 2)]),
    /SECURITY_ANSWERS_INVALID_KEY/,
  );
  await assert.rejects(
    () => auth.setSecurityAnswers(userId, [{ key: "first_pet", answer: "a" }, GOOD_ANSWERS[1]!, GOOD_ANSWERS[2]!]),
    /SECURITY_ANSWERS_ANSWER_TOO_SHORT/,
  );
});

test("securitySetupRequired is false for a non-privileged (player) account", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const s = await auth.register({ phone: "0700000000", username: "player1", password: "Password1" });
  assert.equal(await auth.securitySetupRequired(s.userId), false);
});

// ── privileged reset gating ───────────────────────────────────────────────────────────────────
test("privileged reset FAILS CLOSED when answers are not set — even with unverified reset enabled", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET, allowUnverifiedPasswordReset: true });
  const { phone } = await seedAdmin(repo, auth);
  // One uniform refusal for every failure mode: a distinct SECURITY_QUESTIONS_NOT_SET told an
  // anonymous caller that this phone is an operator account AND that its setup is unfinished.
  await assert.rejects(() => auth.resetPassword(phone, "NewPass123", { answers: GOOD_ANSWERS }), /RESET_UNAVAILABLE/);
});

test("privileged reset succeeds only with ALL correct answers (case/space-insensitive)", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET }); // flag OFF → still works for privileged via answers
  const { userId, phone } = await seedAdmin(repo, auth);
  await auth.setSecurityAnswers(userId, GOOD_ANSWERS);

  // Correct answers, deliberately re-cased and re-spaced → must still match (normalization).
  const messy = [
    { key: "first_pet", answer: "  REX " },
    { key: "birth_city", answer: "nairobi" },
    { key: "first_school", answer: "st. mary's" },
  ];
  assert.deepEqual(await auth.resetPassword(phone, "NewPass123", { answers: messy }), { reset: true });

  // The new password now logs in.
  const s = await auth.login({ phone, password: "NewPass123" });
  assert.equal(s.userId, userId);
});

test("privileged reset rejects a wrong answer and a missing answer, indistinguishably", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId, phone } = await seedAdmin(repo, auth);
  await auth.setSecurityAnswers(userId, GOOD_ANSWERS);

  const oneWrong = [GOOD_ANSWERS[0]!, GOOD_ANSWERS[1]!, { key: "first_school", answer: "Wrong School" }];
  await assert.rejects(() => auth.resetPassword(phone, "NewPass123", { answers: oneWrong }), /RESET_UNAVAILABLE/);

  const missingOne = [GOOD_ANSWERS[0]!, GOOD_ANSWERS[1]!];
  await assert.rejects(() => auth.resetPassword(phone, "NewPass123", { answers: missingOne }), /RESET_UNAVAILABLE/);

  // Password unchanged after failed attempts: the ORIGINAL still logs in.
  const s = await auth.login({ phone, password: "Password1" });
  assert.equal(s.userId, userId);
});

// ── player reset path unchanged ───────────────────────────────────────────────────────────────
test("player reset: refused with the SAME code as a privileged refusal when the flag is off", async () => {
  const off = new AuthService(new InMemoryIdentityRepository(), { jwtSecret: SECRET });
  await off.register({ phone: "0700000000", username: "player1", password: "Password1" });
  // Deliberately the same RESET_UNAVAILABLE a privileged account gives. A distinct RESET_DISABLED
  // here was the third leg of the oracle: it meant "this phone is NOT an operator account".
  await assert.rejects(() => off.resetPassword("0700000000", "NewPass123"), /RESET_UNAVAILABLE/);

  const repoOn = new InMemoryIdentityRepository();
  const on = new AuthService(repoOn, { jwtSecret: SECRET, allowUnverifiedPasswordReset: true });
  const s = await on.register({ phone: "0700000000", username: "player1", password: "Password1" });
  assert.deepEqual(await on.resetPassword("0700000000", "NewPass123"), { reset: true });
  assert.equal((await on.login({ phone: "0700000000", password: "NewPass123" })).userId, s.userId);
});

// ── reset-question disclosure (anti-enumeration) ──────────────────────────────────────────────
test("getResetQuestionKeys: three keys for EVERY phone, so the shape identifies nobody", async () => {
  /**
   * This used to return the real keys for a set-up admin and `[]` for a player, an admin without
   * answers, and an unknown number — which made an unauthenticated endpoint a directory of the
   * platform's operators, with the empty-but-privileged case additionally flagging the ones who
   * had not finished their security setup.
   *
   * Everything now answers with three keys. The real ones are real; the rest are decoys derived
   * deterministically under the service's own secret, so they are stable per phone (refreshing
   * cannot expose them as fabricated) without being a single fixed triple for everyone.
   */
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId, phone } = await seedAdmin(repo, auth);
  await auth.register({ phone: "0700000000", username: "player1", password: "Password1" });

  const unsetAdmin = await auth.getResetQuestionKeys(phone);     // admin, answers NOT set
  await auth.setSecurityAnswers(userId, GOOD_ANSWERS);
  const setUpAdmin = await auth.getResetQuestionKeys(phone);     // admin, answers set
  const player = await auth.getResetQuestionKeys("0700000000");
  const unknown = await auth.getResetQuestionKeys("0799999999");
  const malformed = await auth.getResetQuestionKeys("not-a-phone");

  for (const [label, keys] of [["unset admin", unsetAdmin], ["set-up admin", setUpAdmin],
    ["player", player], ["unknown", unknown], ["malformed", malformed]] as const) {
    assert.equal(keys.length, 3, `${label}: expected three keys, got ${keys.length}`);
    assert.equal(new Set(keys).size, 3, `${label}: repeated a question`);
    for (const k of keys) assert.ok(isValidSecurityQuestionKey(k), `${label}: ${k} is not a catalog key`);
  }
  // The set-up admin's are the genuine ones.
  assert.deepEqual([...setUpAdmin].sort(), ["birth_city", "first_pet", "first_school"]);
  // Deterministic per phone, and not one fixed triple for the whole world.
  assert.deepEqual(await auth.getResetQuestionKeys("0700000000"), player);
  assert.notDeepEqual(player, unknown);
});

// ── force-logout (session epoch) ──────────────────────────────────────────────────────────────
test("assertSessionValid revokes a privileged token issued before the force-logout epoch, ignores players", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId } = await seedAdmin(repo, auth);
  const nowSec = Math.floor(Date.now() / 1000);

  // No epoch yet → valid.
  await auth.assertSessionValid(userId, "admin", nowSec);

  // Stamp force-logout "now" → a token issued a minute ago is revoked; a fresh one is fine.
  repo._forceLogout(userId, Date.now());
  await assert.rejects(() => auth.assertSessionValid(userId, "admin", nowSec - 60), /SESSION_REVOKED/);
  await auth.assertSessionValid(userId, "admin", nowSec + 60);

  // A player token is never checked, even if (hypothetically) stamped.
  const p = await auth.register({ phone: "0700000000", username: "player1", password: "Password1" });
  repo._forceLogout(p.userId, Date.now() + 10_000);
  await auth.assertSessionValid(p.userId, "player", 0); // no throw
});

/**
 * Regression (BUGLOG #132, migration 0200): a MARKETER's website session must be force-logout-able.
 * 0198 only revoked the till-app identity (marketers.id, gated in requireMarketer). A marketer signed
 * in on the website holds a profiles token with role='marketer', and this gate skipped it because
 * 'marketer' is not in PRIVILEGED_ROLES — so "sign every marketer out now" silently did nothing to the
 * session they actually use. Marketers demo on live streams, so that session has to end.
 */
test("assertSessionValid revokes a MARKETER website token issued before the epoch (0200)", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId } = await seedAdmin(repo, auth);
  const nowSec = Math.floor(Date.now() / 1000);

  // Unstamped: a marketer token is fine.
  await auth.assertSessionValid(userId, "marketer", nowSec);

  // Force-logout "now" → the marketer's existing (older) token is REVOKED, a fresh one is accepted.
  repo._forceLogout(userId, Date.now());
  await assert.rejects(() => auth.assertSessionValid(userId, "marketer", nowSec - 60), /SESSION_REVOKED/);
  await auth.assertSessionValid(userId, "marketer", nowSec + 60);

  // Fails CLOSED for a stamped marketer whose token carries no iat at all.
  await assert.rejects(() => auth.assertSessionValid(userId, "marketer", undefined), /SESSION_REVOKED/);
});

test("SESSION_GATED_ROLES covers marketer + operators but NOT players; PRIVILEGED_ROLES unchanged", () => {
  // The force-logout gate is wider than the privileged set...
  for (const r of ["admin", "platform_admin", "platform_superadmin", "marketer"]) {
    assert.equal(isSessionGatedRole(r), true, r);
  }
  assert.equal(isSessionGatedRole("player"), false);
  assert.equal(isSessionGatedRole(undefined), false);
  // ...but a marketer must remain NON-privileged, since PRIVILEGED_ROLES also drives the
  // password-reset knowledge factor and the MFA requirement.
  assert.equal(isPrivilegedRole("marketer"), false);
  assert.equal(isPrivilegedRole("admin"), true);
});

test("assertAccountActive revokes a privileged token once the operator is banned/suspended, ignores players (#7)", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId } = await seedAdmin(repo, auth);

  // Active operator: the live token stays usable.
  await auth.assertAccountActive(userId, "admin");

  // Banned/suspended AFTER issuance → the very next request is rejected (banning does not force-logout,
  // so this app-layer gate is what actually removes the authority before the token expires).
  repo.adminSetStatus(userId, "banned");
  await assert.rejects(() => auth.assertAccountActive(userId, "admin"), /ACCOUNT_INACTIVE/);
  repo.adminSetStatus(userId, "suspended");
  await assert.rejects(() => auth.assertAccountActive(userId, "admin"), /ACCOUNT_INACTIVE/);

  // Reinstated → admitted again (tracks live status, not a one-way trip).
  repo.adminSetStatus(userId, "active");
  await auth.assertAccountActive(userId, "admin");

  // A player token is never status-gated (deposits stay open) and pays no DB read.
  const p = await auth.register({ phone: "0700000000", username: "player1", password: "Password1" });
  repo.adminSetStatus(p.userId, "banned");
  await auth.assertAccountActive(p.userId, "player"); // no throw
});

test("the verifier guards compose: a banned operator is rejected even with a still-valid session epoch (#7)", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId } = await seedAdmin(repo, auth);
  const nowSec = Math.floor(Date.now() / 1000);
  repo.adminSetStatus(userId, "banned");

  // Mirror the server.ts verifier wrapper: force-logout PASSES (no epoch stamped), but the live-status
  // gate FAILS — so the composed guard rejects, which becomes a 401 → forced re-login (then blocked).
  await auth.assertSessionValid(userId, "admin", nowSec); // ok on its own
  await assert.rejects(
    () => Promise.all([
      auth.assertSessionValid(userId, "admin", nowSec),
      auth.assertAccountActive(userId, "admin"),
    ]),
    /ACCOUNT_INACTIVE/,
  );
});
