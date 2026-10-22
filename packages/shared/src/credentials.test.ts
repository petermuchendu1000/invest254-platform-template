import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePassword, validateUsername } from "./credentials.js";

test("validatePassword: a four-digit PIN is a password, and so is everything that was one before", () => {
  // The floor moved to four with no character classes, so the keypad PIN this product asks for is
  // valid — and every credential that passed the old rule still passes, so nobody is reset.
  assert.deepEqual(validatePassword("1234"), { ok: true });
  assert.deepEqual(validatePassword("0000"), { ok: true });
  assert.deepEqual(validatePassword("hunter2pass"), { ok: true });
  assert.deepEqual(validatePassword("abcdefgh"), { ok: true });   // was NEEDS_DIGIT
  assert.deepEqual(validatePassword("12345678"), { ok: true });   // was NEEDS_LETTER
});

test("validatePassword: only length is refused, and the ceiling stays", () => {
  assert.equal(validatePassword("123").reason, "TOO_SHORT");
  // The maximum is a hashing-cost bound (scrypt input), not a strength rule, so it survives.
  assert.equal(validatePassword("x".repeat(200)).reason, "TOO_LONG");
  assert.equal(validatePassword(1234 as unknown).reason, "INVALID");
});

test("validateUsername: accepts valid handles", () => {
  for (const u of ["njeri", "wanjiru.ke", "trader_01", "abc"]) assert.deepEqual(validateUsername(u), { ok: true });
});

test("validateUsername: rejects bad length / charset / edge dots", () => {
  assert.equal(validateUsername("ab").reason, "TOO_SHORT");
  assert.equal(validateUsername("x".repeat(21)).reason, "TOO_LONG");
  assert.equal(validateUsername(".njeri").reason, "INVALID_CHARS");
  assert.equal(validateUsername("njeri_").reason, "INVALID_CHARS");
  assert.equal(validateUsername("a b").reason, "INVALID_CHARS");
  assert.equal(validateUsername("hac@ker").reason, "INVALID_CHARS");
});

import { validateReferralCode, REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH } from "./credentials.js";

test("validateReferralCode: normalizes (trim + upper) and accepts the canonical alphabet", () => {
  const r = validateReferralCode("  4u7vrsca  ");
  assert.deepEqual(r, { ok: true, code: "4U7VRSCA" });
  const full = REFERRAL_CODE_ALPHABET.slice(0, REFERRAL_CODE_LENGTH);
  assert.equal(validateReferralCode(full).ok, true);
});

test("validateReferralCode: rejects wrong length, ambiguous/illegal chars, and non-strings", () => {
  assert.equal((validateReferralCode("ABC123") as { reason: string }).reason, "INVALID_LENGTH");
  assert.equal((validateReferralCode("ABCDEFGHI") as { reason: string }).reason, "INVALID_LENGTH");
  assert.equal((validateReferralCode("4U7VRSC0") as { reason: string }).reason, "INVALID_CHARS");
  assert.equal((validateReferralCode("4U7VRSCI") as { reason: string }).reason, "INVALID_CHARS");
  assert.equal((validateReferralCode("4U7VRS-A") as { reason: string }).reason, "INVALID_CHARS");
  assert.equal((validateReferralCode(12345678 as unknown) as { reason: string }).reason, "INVALID");
});
