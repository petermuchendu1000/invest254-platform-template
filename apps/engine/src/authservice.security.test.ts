import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthService, isTokenSessionValid, isPrivilegedRole } from "./authservice.js";
import { InMemoryIdentityRepository } from "./identity.js";

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
test("isPrivilegedRole covers admin/superadmin/platform_superadmin, not player/marketer", () => {
  for (const r of ["admin", "superadmin", "platform_admin", "platform_superadmin"]) assert.equal(isPrivilegedRole(r), true);
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
  await assert.rejects(() => auth.resetPassword(phone, "NewPass123", { answers: GOOD_ANSWERS }), /SECURITY_QUESTIONS_NOT_SET/);
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

test("privileged reset rejects a wrong answer and a missing answer (SECURITY_ANSWERS_MISMATCH)", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId, phone } = await seedAdmin(repo, auth);
  await auth.setSecurityAnswers(userId, GOOD_ANSWERS);

  const oneWrong = [GOOD_ANSWERS[0]!, GOOD_ANSWERS[1]!, { key: "first_school", answer: "Wrong School" }];
  await assert.rejects(() => auth.resetPassword(phone, "NewPass123", { answers: oneWrong }), /SECURITY_ANSWERS_MISMATCH/);

  const missingOne = [GOOD_ANSWERS[0]!, GOOD_ANSWERS[1]!];
  await assert.rejects(() => auth.resetPassword(phone, "NewPass123", { answers: missingOne }), /SECURITY_ANSWERS_MISMATCH/);

  // Password unchanged after failed attempts: the ORIGINAL still logs in.
  const s = await auth.login({ phone, password: "Password1" });
  assert.equal(s.userId, userId);
});

// ── player reset path unchanged ───────────────────────────────────────────────────────────────
test("player reset is unchanged: RESET_DISABLED when the flag is off, and needs no answers when on", async () => {
  const off = new AuthService(new InMemoryIdentityRepository(), { jwtSecret: SECRET });
  await off.register({ phone: "0700000000", username: "player1", password: "Password1" });
  await assert.rejects(() => off.resetPassword("0700000000", "NewPass123"), /RESET_DISABLED/);

  const repoOn = new InMemoryIdentityRepository();
  const on = new AuthService(repoOn, { jwtSecret: SECRET, allowUnverifiedPasswordReset: true });
  const s = await on.register({ phone: "0700000000", username: "player1", password: "Password1" });
  assert.deepEqual(await on.resetPassword("0700000000", "NewPass123"), { reset: true });
  assert.equal((await on.login({ phone: "0700000000", password: "NewPass123" })).userId, s.userId);
});

// ── reset-question disclosure (anti-enumeration) ──────────────────────────────────────────────
test("getResetQuestionKeys: keys for a set-up admin; empty for player, unset admin, and unknown phone", async () => {
  const repo = new InMemoryIdentityRepository();
  const auth = new AuthService(repo, { jwtSecret: SECRET });
  const { userId, phone } = await seedAdmin(repo, auth);
  await auth.register({ phone: "0700000000", username: "player1", password: "Password1" });

  assert.deepEqual(await auth.getResetQuestionKeys(phone), []); // admin without answers → empty (fails closed)
  await auth.setSecurityAnswers(userId, GOOD_ANSWERS);
  assert.deepEqual([...(await auth.getResetQuestionKeys(phone))].sort(), ["birth_city", "first_pet", "first_school"]);
  assert.deepEqual(await auth.getResetQuestionKeys("0700000000"), []); // player → empty
  assert.deepEqual(await auth.getResetQuestionKeys("0799999999"), []); // unknown → empty
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
