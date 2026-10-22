import {
  validatePassword,
  validateUsername,
  validateReferralCode,
} from '@invest254/shared/credentials';
import { normalizeMsisdn } from '@invest254/shared/payments';

function pick(map: Record<string, string>, reason: string | undefined, fallback: string): string {
  return (reason ? map[reason] : undefined) ?? fallback;
}

export function phoneError(v: string): string | undefined {
  if (!v.trim()) return 'Phone number is required.';
  try {
    normalizeMsisdn(v);
    return undefined;
  } catch {
    return 'Enter a valid Kenyan number, e.g. 0712 345 678.';
  }
}

export function usernameError(v: string): string | undefined {
  const r = validateUsername(v);
  if (r.ok) return undefined;
  return pick(
    {
      TOO_SHORT: 'At least 3 characters.',
      TOO_LONG: 'At most 20 characters.',
      INVALID_CHARS: 'Letters, numbers, dots and underscores only.',
    },
    r.reason,
    'Invalid username.',
  );
}

export function passwordError(v: string): string | undefined {
  const r = validatePassword(v);
  if (r.ok) return undefined;
  return pick(
    {
      TOO_SHORT: 'At least 4 characters.',
      TOO_LONG: 'Too long.',
    },
    r.reason,
    'Invalid password.',
  );
}

export function referralError(v: string): string | undefined {
  if (!v.trim()) return undefined; // optional
  const r = validateReferralCode(v);
  if (r.ok) return undefined;
  return 'Referral code looks wrong. It is 8 characters.';
}
