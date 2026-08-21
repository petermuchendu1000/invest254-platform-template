import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SECURITY_QUESTIONS,
  SECURITY_QUESTION_KEYS,
  SECURITY_ANSWERS_REQUIRED,
  isValidSecurityQuestionKey,
  securityQuestionLabel,
  normalizeSecurityAnswer,
  validateSecurityAnswerSet,
} from "./security-questions.js";

test("catalog has unique keys, non-empty labels, and >= the required count", () => {
  assert.ok(SECURITY_QUESTIONS.length >= SECURITY_ANSWERS_REQUIRED);
  const keys = SECURITY_QUESTIONS.map((q) => q.key);
  assert.equal(new Set(keys).size, keys.length, "keys must be unique");
  for (const q of SECURITY_QUESTIONS) {
    assert.ok(q.key.length > 0 && q.label.length > 0);
    assert.ok(SECURITY_QUESTION_KEYS.has(q.key));
  }
});

test("isValidSecurityQuestionKey / securityQuestionLabel", () => {
  assert.equal(isValidSecurityQuestionKey("first_pet"), true);
  assert.equal(isValidSecurityQuestionKey("nope"), false);
  assert.equal(isValidSecurityQuestionKey(123), false);
  assert.equal(securityQuestionLabel("first_pet"), "What was the name of your first pet?");
  assert.equal(securityQuestionLabel("nope"), undefined);
});

test("normalizeSecurityAnswer lowercases, trims, and collapses internal whitespace", () => {
  assert.equal(normalizeSecurityAnswer("  REX  "), "rex");
  assert.equal(normalizeSecurityAnswer("St.   Mary's"), "st. mary's");
  assert.equal(normalizeSecurityAnswer("New\tYork  City"), "new york city");
  assert.equal(normalizeSecurityAnswer(42 as unknown as string), "");
});

test("validateSecurityAnswerSet enforces count, distinct valid keys, and length bounds", () => {
  const good = [
    { key: "first_pet", answer: "Rex" },
    { key: "birth_city", answer: "Nairobi" },
    { key: "first_school", answer: "St Mary" },
  ];
  assert.deepEqual(validateSecurityAnswerSet(good), { ok: true });

  assert.equal(validateSecurityAnswerSet(good.slice(0, 2)).reason, "TOO_FEW");
  assert.equal(validateSecurityAnswerSet([good[0]!, good[0]!, good[1]!]).reason, "DUPLICATE_KEY");
  assert.equal(
    validateSecurityAnswerSet([{ key: "xx", answer: "a1" }, good[1]!, good[2]!]).reason,
    "INVALID_KEY",
  );
  assert.equal(
    validateSecurityAnswerSet([{ key: "first_pet", answer: " a " }, good[1]!, good[2]!]).reason,
    "ANSWER_TOO_SHORT",
  );
  assert.equal(
    validateSecurityAnswerSet([{ key: "first_pet", answer: "x".repeat(200) }, good[1]!, good[2]!]).reason,
    "ANSWER_TOO_LONG",
  );
});
