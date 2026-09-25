/**
 * Friendly, client-safe messaging for wallet (deposit/withdraw) errors. The API is now the
 * authoritative sanitizer, but this is defense-in-depth: a player must NEVER see a raw technical
 * string (provider payloads, `*_REJECTED_400:{…}`, `NOT_CONFIGURED`, JSON, stack detail). Known
 * codes get purpose-written copy; anything that looks technical falls back to a calm generic line.
 *
 * Structurally typed (no imports) so it stays pure and unit-testable under `node --test`.
 */
interface ErrLike { code?: unknown; message?: unknown }
function codeOf(e: unknown): string | null {
  return e && typeof e === 'object' && typeof (e as ErrLike).code === 'string' ? ((e as ErrLike).code as string) : null;
}
function messageOf(e: unknown): string {
  return e && typeof e === 'object' && typeof (e as ErrLike).message === 'string' ? ((e as ErrLike).message as string) : '';
}

const MESSAGES: Record<string, string> = {
  // provider / system
  PROVIDER_ERROR: "We couldn't complete that right now. Please try again in a few minutes or use another payment method.",
  PROVIDER_UNAVAILABLE: 'This payment method is temporarily unavailable. Please try another option or try again later.',
  PROVIDER_DISABLED: "This payment method isn't available right now. Please choose another.",
  SYSTEM_DISABLED: 'This is temporarily paused. Please try again shortly.',
  INTERNAL: 'Something went wrong on our end. Please try again shortly.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
  // user-correctable
  INSUFFICIENT_FUNDS: 'Insufficient balance for this amount.',
  INVALID_AMOUNT: 'Enter a valid amount.',
  BELOW_MIN: 'That amount is below the minimum.',
  ABOVE_MAX: 'That amount is above the maximum allowed.',
  INVALID_PHONE: 'Enter a valid Kenyan phone number, e.g. 0712 345 678.',
  WITHDRAWALS_DISABLED: 'Withdrawals are temporarily paused. Please try again later.',
  ACCOUNT_NOT_ACTIVE: "Your account can't transact right now. Please contact support.",
  CODE_ALREADY_USED: 'That code has already been used.',
  INVALID_CODE: 'That code is not valid.',
  AUTH_REQUIRED: 'Please log in to continue.',
  DEMO_ACCOUNT: 'Switch to your Real account to withdraw.',
  OPEN_POSITIONS: 'Finish your open trade first.',
  VALIDATION: 'Please check your details and try again.',
};

const GENERIC = "We couldn't complete that right now. Please try again in a few minutes.";
// A message is "technical" (never show a player) if it looks like a code/JSON/provider payload.
const TECHNICAL_RE = /[{}]|status_code|error_code|REJECTED|NOT_CONFIGURED|[A-Z]{3,}_[A-Z]{3,}|:\s*4\d\d/;

/** Map any thrown wallet error to a friendly, client-safe message. */
export function paymentErrorMessage(e: unknown): string {
  const code = codeOf(e);
  if (code !== null) {
    if (MESSAGES[code]) return MESSAGES[code]!;
    const msg = messageOf(e).trim();
    if (!msg || TECHNICAL_RE.test(msg)) return GENERIC;
    return msg; // a clean, human backend message (e.g. a specific validation hint)
  }
  return 'Network error. Please check your connection and try again.';
}
