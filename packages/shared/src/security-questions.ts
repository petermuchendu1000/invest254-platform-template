/**
 * Security questions catalog + answer normalization — the knowledge second factor that gates
 * PRIVILEGED (admin / superadmin / platform_superadmin) password resets (see AuthService).
 *
 * DEPENDENCY-FREE ON PURPOSE: this module imports nothing so the browser bundle (apps/web) can
 * import it via the `@invest254/shared/security-questions` subpath with zero server code, exactly
 * like `@invest254/shared/config`. The engine (AuthService) is the single source of truth for
 * hashing (scrypt) + verification; this file only defines the fixed catalog and the pure
 * normalization used identically on both sides so an answer typed at setup matches at reset.
 *
 * The wording mirrors the classic Google account-recovery security questions (stable, memorable,
 * concrete facts a stranger who merely knows a phone number cannot know).
 */

/** One selectable question: a stable `key` (stored) + human `label` (shown). */
export interface SecurityQuestion {
  /** Stable identifier persisted with the hashed answer. NEVER change an existing key's meaning. */
  readonly key: string;
  /** Human-readable prompt shown in the setup + reset UI. */
  readonly label: string;
}

/**
 * The fixed catalog. Keys are permanent (they are stored in the DB); labels may be reworded.
 * Google-style recovery questions. Keep this list append-only.
 */
export const SECURITY_QUESTIONS: readonly SecurityQuestion[] = [
  { key: "first_pet", label: "What was the name of your first pet?" },
  { key: "mothers_maiden_name", label: "What is your mother's maiden name?" },
  { key: "birth_city", label: "In what city were you born?" },
  { key: "first_school", label: "What was the name of your first school?" },
  { key: "childhood_nickname", label: "What was your childhood nickname?" },
  { key: "first_car", label: "What was the make of your first car?" },
  { key: "favorite_teacher", label: "What is the name of your favorite teacher?" },
  { key: "fathers_middle_name", label: "What is your father's middle name?" },
  { key: "street_grew_up", label: "What is the name of the street you grew up on?" },
  { key: "favorite_food", label: "What is your favorite food?" },
] as const;

/** Fast membership set for validating an inbound question key. */
export const SECURITY_QUESTION_KEYS: ReadonlySet<string> = new Set(
  SECURITY_QUESTIONS.map((q) => q.key),
);

/** How many distinct questions a privileged user must answer (product requirement: 3). */
export const SECURITY_ANSWERS_REQUIRED = 3;

/** Minimum length of a normalized answer — blocks trivially-guessable single-character answers. */
export const SECURITY_ANSWER_MIN_LENGTH = 2;

/** Maximum raw answer length accepted (bounds hashing cost / abuse), mirrors PASSWORD_MAX_LENGTH intent. */
export const SECURITY_ANSWER_MAX_LENGTH = 128;

/** True when `key` is a known catalog question key. */
export function isValidSecurityQuestionKey(key: unknown): key is string {
  return typeof key === "string" && SECURITY_QUESTION_KEYS.has(key);
}

/** Look up a question's label by key, or undefined if the key is unknown. */
export function securityQuestionLabel(key: string): string | undefined {
  return SECURITY_QUESTIONS.find((q) => q.key === key)?.label;
}

/**
 * Normalize a security answer so trivial formatting differences (case, surrounding/duplicated
 * whitespace) never cause a correct answer to be rejected. This MUST be applied identically at
 * setup and at verification (both go through the same hash of the normalized value). Deterministic
 * and pure. Diacritics are intentionally preserved (a user's own spelling is their own secret).
 */
export function normalizeSecurityAnswer(answer: unknown): string {
  if (typeof answer !== "string") return "";
  return answer.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface SecurityAnswerCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Validate a SET of submitted {key, answer} pairs for the "set my security answers" flow:
 *   - at least SECURITY_ANSWERS_REQUIRED entries,
 *   - every key is a known catalog key,
 *   - keys are DISTINCT (can't answer the same question 3 times),
 *   - every normalized answer meets the length bounds.
 * Pure + deterministic; the authoritative hashing/storage happens in AuthService.
 */
export function validateSecurityAnswerSet(
  entries: ReadonlyArray<{ key: unknown; answer: unknown }>,
): SecurityAnswerCheck {
  if (!Array.isArray(entries)) return { ok: false, reason: "INVALID" };
  if (entries.length < SECURITY_ANSWERS_REQUIRED) return { ok: false, reason: "TOO_FEW" };
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== "object") return { ok: false, reason: "INVALID" };
    if (!isValidSecurityQuestionKey(e.key)) return { ok: false, reason: "INVALID_KEY" };
    if (seen.has(e.key)) return { ok: false, reason: "DUPLICATE_KEY" };
    seen.add(e.key);
    if (typeof e.answer !== "string") return { ok: false, reason: "INVALID_ANSWER" };
    if (e.answer.length > SECURITY_ANSWER_MAX_LENGTH) return { ok: false, reason: "ANSWER_TOO_LONG" };
    if (normalizeSecurityAnswer(e.answer).length < SECURITY_ANSWER_MIN_LENGTH) {
      return { ok: false, reason: "ANSWER_TOO_SHORT" };
    }
  }
  return { ok: true };
}
