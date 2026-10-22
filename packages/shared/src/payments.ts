import { assertCents, type Cents } from "./money.js";

/**
 * Payment input rules (M-Pesa / KES). Pure and deterministic so they can be unit-tested
 * and shared by the engine and any HTTP transport. Money is integer cents of KES.
 *
 * Defaults (docs/07 §5): min deposit KES 200, min withdrawal KES 250.
 */
export const MIN_DEPOSIT_CENTS: Cents = 20_000;     // KES 200
export const MIN_WITHDRAWAL_CENTS: Cents = 25_000;  // KES 250

/**
 * Normalize a Kenyan mobile number to MSISDN form `2547XXXXXXXX` / `2541XXXXXXXX`
 * (12 digits, no '+'), which is what Daraja STK/B2C expects as PartyA/PhoneNumber.
 * Accepts 07.., 01.., 7.., 1.., +254.., 254.. with spaces/dashes. Throws on anything else.
 */
export function normalizeMsisdn(input: string): string {
  const raw = String(input ?? "").replace(/[\s\-()]/g, "").replace(/^\+/, "");
  let local: string;
  if (/^0(7|1)\d{8}$/.test(raw)) local = raw;                       // 0712345678 (already local)
  else if (/^254(7|1)\d{8}$/.test(raw)) local = `0${raw.slice(3)}`; // 254712345678 -> 0712345678
  else if (/^(7|1)\d{8}$/.test(raw)) local = `0${raw}`;             // 712345678 -> 0712345678
  else throw new Error(`INVALID_PHONE: ${input}`);
  if (!/^0(7|1)\d{8}$/.test(local)) throw new Error(`INVALID_PHONE: ${input}`);
  return local;
}

/**
 * Convert a Kenyan phone to E.164 MSISDN (254XXXXXXXXX) for the Safaricom / Daraja edge ONLY.
 * The whole app uses the local 0XXXXXXXXX form as the canonical identity; Safaricom's STK/B2C
 * APIs require the 254 form, so we convert right before hitting them (see daraja.ts).
 */
export function msisdnToE164(input: string): string {
  const local = normalizeMsisdn(input);
  return `254${local.slice(1)}`;
}

/**
 * The number of leading / trailing digits a masked phone keeps: `0798****061`.
 *
 * Four in front identifies the network prefix (0798 = Safaricom) and three at the back is what a
 * person needs to confirm "yes, that is my number" without the string being any use to someone
 * reading it over their shoulder or exfiltrating a page. Ten-digit Kenyan locals therefore show 7
 * of 10 digits, hiding 4 — which is honest about what masking buys: it defeats bulk harvesting and
 * casual shoulder-surfing, not a determined guesser who already knows the prefix.
 */
const MASK_KEEP_HEAD = 4;
const MASK_KEEP_TAIL = 3;

/**
 * The hidden span is a FIXED four asterisks, not one per hidden digit.
 *
 * Two reasons. It is the shape that was specified (`0798****061`, where a ten-digit local number
 * actually hides only three digits). And it is the safer of the two: a one-asterisk-per-digit mask
 * silently publishes the length of what it hides, which distinguishes a ten-digit local from a
 * twelve-digit 254-form or a malformed row, and tells anyone scraping the page how many digits they
 * would need to guess. A constant-width mask says nothing about the value underneath.
 */
const MASK_BODY = "****";

/**
 * Mask a phone number for DISPLAY: `0798661061` -> `0798****061`.
 *
 * Use this anywhere a number is shown to a human. Do NOT use it on a value that is then sent
 * anywhere, compared, searched or paid to — see the warning below.
 *
 * Deliberately total: it never throws and never returns its input unchanged, because a display
 * helper gets called on whatever happens to be in the row, and the two tempting shortcuts are both
 * leaks. Returning the raw string for input "too short to mask" means a malformed or partial record
 * renders in full, which is exactly the record most likely to be interesting. Masking a fixed
 * middle slice means a short input can come back with more digits exposed than a long one. So:
 * anything without room for both ends under the mask is replaced wholesale, and the masked span is
 * always at least one character.
 *
 * Accepts any of the forms this codebase stores or receives (`0798661061`, `254798661061`,
 * `+254 798 661 061`) and normalises to the local form first, so one number always masks to one
 * string regardless of which table or gateway it came from. Non-digits are dropped, so the output
 * cannot smuggle through formatting a caller did not expect.
 *
 * WARNING — masking a value that is about to be USED breaks real money. The payout guard
 * `fn_create_withdrawal` (0161) requires `length(digits(p_phone)) >= 9` and compares the last 9
 * digits against the registered number: a masked value fails it and the withdrawal is refused.
 * `transactions.phone` is read back as the B2C destination (apps/engine/src/payments.ts), the
 * Daraja/PayHero/MegaPay/PayX clients all take the full MSISDN, login and the sig-9 marketer join
 * match on it, and the finance CSV and copy-to-clipboard paths exist so an operator can actually
 * pay someone. Mask at the point of RENDER, or in a response field nothing functional reads —
 * never in the middle of a payment, identification or dedupe path.
 */
export function maskPhoneForDisplay(input: string | null | undefined): string {
  const digits = String(input ?? "").replace(/\D/g, "");
  // One number, one masked form: fold 254.../+254... onto the canonical local shape first.
  const local = /^254[17]\d{8}$/.test(digits) ? `0${digits.slice(3)}` : digits;
  if (local.length === 0) return "";
  if (local.length < MASK_KEEP_HEAD + MASK_KEEP_TAIL + 1) {
    // Not enough digits to keep both ends and still hide one. Reveal nothing at all rather than
    // letting a short or malformed row show more of itself than a well-formed one does.
    return MASK_BODY;
  }
  return `${local.slice(0, MASK_KEEP_HEAD)}${MASK_BODY}${local.slice(-MASK_KEEP_TAIL)}`;
}

export interface AmountCheck { ok: boolean; reason?: string }

/** Validate a deposit amount (integer cents, positive, >= min). */
export function validateDeposit(amountCents: number, min: Cents = MIN_DEPOSIT_CENTS): AmountCheck {
  if (!Number.isInteger(amountCents)) return { ok: false, reason: "NOT_INTEGER_CENTS" };
  if (amountCents <= 0) return { ok: false, reason: "INVALID_AMOUNT" };
  if (amountCents < min) return { ok: false, reason: "BELOW_MIN" };
  return { ok: true };
}

/** Validate a withdrawal amount against the min and the withdrawable balance. */
export function validateWithdrawal(amountCents: number, balanceCents: Cents, min: Cents = MIN_WITHDRAWAL_CENTS): AmountCheck {
  assertCents(balanceCents, "balance");
  if (!Number.isInteger(amountCents)) return { ok: false, reason: "NOT_INTEGER_CENTS" };
  if (amountCents <= 0) return { ok: false, reason: "INVALID_AMOUNT" };
  if (amountCents < min) return { ok: false, reason: "BELOW_MIN" };
  if (amountCents > balanceCents) return { ok: false, reason: "INSUFFICIENT_FUNDS" };
  return { ok: true };
}
