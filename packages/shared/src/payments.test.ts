import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMsisdn, msisdnToE164, maskPhoneForDisplay, validateDeposit, validateWithdrawal, MIN_DEPOSIT_CENTS, MIN_WITHDRAWAL_CENTS } from "./payments.js";

test("normalizeMsisdn: accepts KE formats -> local 07../01..", () => {
  assert.equal(normalizeMsisdn("0712345678"), "0712345678");
  assert.equal(normalizeMsisdn("0112345678"), "0112345678");
  assert.equal(normalizeMsisdn("+254712345678"), "0712345678");
  assert.equal(normalizeMsisdn("254712345678"), "0712345678");
  assert.equal(normalizeMsisdn("712345678"), "0712345678");
  assert.equal(normalizeMsisdn(" 0712 345 678 "), "0712345678");
  assert.equal(normalizeMsisdn("0712-345-678"), "0712345678");
});

test("msisdnToE164: converts local -> 254 for the Daraja edge", () => {
  assert.equal(msisdnToE164("0712345678"), "254712345678");
  assert.equal(msisdnToE164("254712345678"), "254712345678");
  assert.equal(msisdnToE164("712345678"), "254712345678");
});

test("normalizeMsisdn: rejects invalid", () => {
  for (const bad of ["", "12345", "0812345678", "25471234567", "2547123456789", "07123abc78", "0612345678"]) {
    assert.throws(() => normalizeMsisdn(bad), /INVALID_PHONE/, `should reject ${bad}`);
  }
});

test("validateDeposit: integer cents, positive, >= min", () => {
  assert.deepEqual(validateDeposit(MIN_DEPOSIT_CENTS), { ok: true });
  assert.deepEqual(validateDeposit(50_000), { ok: true });
  assert.equal(validateDeposit(MIN_DEPOSIT_CENTS - 1).reason, "BELOW_MIN");
  assert.equal(validateDeposit(0).reason, "INVALID_AMOUNT");
  assert.equal(validateDeposit(-100).reason, "INVALID_AMOUNT");
  assert.equal(validateDeposit(100.5).reason, "NOT_INTEGER_CENTS");
});

test("validateWithdrawal: min, positive, integer, and <= balance", () => {
  assert.deepEqual(validateWithdrawal(MIN_WITHDRAWAL_CENTS, 100_000), { ok: true });
  assert.equal(validateWithdrawal(MIN_WITHDRAWAL_CENTS - 1, 100_000).reason, "BELOW_MIN");
  assert.equal(validateWithdrawal(50_000, 30_000).reason, "INSUFFICIENT_FUNDS");
  assert.equal(validateWithdrawal(0, 100_000).reason, "INVALID_AMOUNT");
  assert.equal(validateWithdrawal(20_000.5, 100_000).reason, "NOT_INTEGER_CENTS");
  assert.throws(() => validateWithdrawal(20_000, 100_000.5), /balance/);
});

test("maskPhoneForDisplay: the shape the product owner specified, 0798****061", () => {
  assert.equal(maskPhoneForDisplay("0798661061"), "0798****061");
  // Pinned to the literal on purpose: this is the agreed presentation of every customer's number,
  // so a change to how much it reveals should be a deliberate edit to this line.
  assert.equal(maskPhoneForDisplay("0712345678"), "0712****678");
});

test("maskPhoneForDisplay: one number has one masked form, whatever shape it arrived in", () => {
  // profiles.phone stores local, Safaricom sends 254..., operators type +254 with spaces. All three
  // are the same human, so all three must mask identically or an operator comparing two screens
  // sees two different people.
  for (const v of ["0798661061", "254798661061", "+254798661061", "+254 798 661 061", "0798-661-061"]) {
    assert.equal(maskPhoneForDisplay(v), "0798****061", `failed for ${v}`);
  }
});

test("maskPhoneForDisplay: never returns its input unchanged, and never throws", () => {
  // A display helper is called on whatever is in the row. The tempting shortcut — "too short to
  // mask, return it raw" — leaks exactly the malformed records most worth looking at.
  for (const v of ["1", "12", "1234567", "abc", "07986"]) {
    const out = maskPhoneForDisplay(v);
    assert.notEqual(out, v, `leaked raw input ${v}`);
    assert.ok(!/\d/.test(out) || out.includes("*"), `no masking applied to ${v}`);
  }
  assert.equal(maskPhoneForDisplay(null), "");
  assert.equal(maskPhoneForDisplay(undefined), "");
  assert.equal(maskPhoneForDisplay(""), "");
  assert.equal(maskPhoneForDisplay("   "), "");
});

test("maskPhoneForDisplay: a short input never exposes more than a long one", () => {
  // Guards the other shortcut: masking a fixed middle slice lets a 7-digit value show both ends
  // while a 10-digit value hides four. At no length may more than head+tail digits survive.
  for (let len = 1; len <= 15; len++) {
    const digits = "7".repeat(len);
    const out = maskPhoneForDisplay(digits);
    const shown = out.replace(/\*/g, "").length;
    assert.ok(out.includes("*"), `nothing hidden at length ${len}: ${out}`);
    assert.ok(shown < len, `all ${len} digits visible: ${out}`);
    assert.ok(shown <= 7, `more than head+tail digits shown at length ${len}: ${out}`);
  }
});

test("maskPhoneForDisplay: the mask is constant width, so it leaks no length", () => {
  // A 10-digit local and a 12-digit 254-form of DIFFERENT numbers must produce masks whose hidden
  // span is identical in width — otherwise the asterisks themselves are a side channel.
  const a = maskPhoneForDisplay("0798661061");
  const b = maskPhoneForDisplay("254712345678");
  const span = (s: string) => (s.match(/\*+/)?.[0] ?? "").length;
  assert.equal(span(a), span(b));
  assert.equal(span(a), 4);
  // And a value too short to mask reveals no digits whatsoever.
  assert.equal(maskPhoneForDisplay("07986"), "****");
  assert.ok(!/\d/.test(maskPhoneForDisplay("1234567")));
});

test("maskPhoneForDisplay: output is never usable as a phone number", () => {
  // The payout guard (0161) needs >= 9 digits and matches the last 9. A masked value must fail
  // that, loudly, rather than silently paying the wrong person.
  const masked = maskPhoneForDisplay("0798661061");
  assert.ok(masked.replace(/\D/g, "").length < 9, "masked value still has 9 payable digits");
  assert.throws(() => normalizeMsisdn(masked), /INVALID_PHONE/);
});
