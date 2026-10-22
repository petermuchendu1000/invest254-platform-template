import { maskPhoneForDisplay } from '@invest254/shared/payments';

/**
 * How a phone INPUT renders its value (BUGLOG #133). Display only — the real digits live in component
 * state and are what gets submitted.
 *
 * Marketers demo the platform on live streams and sign in / sign up on camera, so at rest the field
 * must read as the house partial mask `0798****061`: enough head and tail for the owner to recognise
 * their own number, without putting the whole MSISDN on screen. Deliberately NOT a password blob —
 * the number stays partially visible, and the eye reveals the hidden digits.
 *
 * `focused` is not a nicety. An `<input>` renders whatever is in its `value`, so showing the mask
 * while someone is typing or correcting would feed the mask back through onChange and corrupt the
 * number that gets posted — on a login field. So the real digits show while the field has focus (you
 * cannot edit what you cannot see), and the mask returns the moment it is blurred. `revealed` (the
 * eye) shows the full number without needing focus, and keeps it shown.
 */
export function phoneDisplay(real: string, revealed: boolean, focused: boolean): string {
  if (revealed || focused || !real) return real;
  return maskPhoneForDisplay(real);
}

/**
 * True when a value is (or contains) the display mask rather than real digits.
 *
 * Belt-and-braces for the onChange handlers: a masked value must never be read back as input. It
 * should be unreachable (typing requires focus, which shows the real digits, and autofill supplies
 * real digits), but if it ever happened the '*' would be stripped by the digits-only normaliser and
 * silently post a truncated number. Cheap insurance on the sign-in path.
 */
export function isMaskedValue(v: string): boolean {
  return v.includes('*');
}
