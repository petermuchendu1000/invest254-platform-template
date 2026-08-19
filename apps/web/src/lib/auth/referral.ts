// Referral-code capture shared between the /r/[code] landing and the auth modal.
// Stored in localStorage so a referral survives the journey to sign-up.
export const REF_KEY = 'pp-ref';

export function storeReferral(code: string): void {
  try {
    const v = code.trim().toUpperCase();
    if (v) window.localStorage.setItem(REF_KEY, v);
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

export function readReferral(): string | null {
  try {
    return window.localStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
}

export function clearReferral(): void {
  try {
    window.localStorage.removeItem(REF_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Extract a referral code from a URL query string. Accepts `?ref=`, `?r=`, or `?code=` (first match
 * wins, in that order). Returns the sanitised UPPERCASE code, or null when absent/invalid. Pure +
 * testable. This lets ANY branded landing (e.g. `https://33traders.com/?ref=CODE`) capture the code
 * and record a funnel click — not just the dedicated `/r/<code>` page.
 */
export function referralFromSearch(search: string): string | null {
  try {
    const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    for (const key of ['ref', 'r', 'code']) {
      const raw = p.get(key);
      if (!raw) continue;
      const v = raw.trim().toUpperCase();
      if (/^[A-Z0-9]{4,24}$/.test(v)) return v;
    }
    return null;
  } catch {
    return null;
  }
}
