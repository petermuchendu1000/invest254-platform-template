/**
 * Pure, dependency-free helpers for the support widget. Kept free of `@/` imports so they can be
 * unit-tested by the root test runner (which resolves relative specifiers only).
 */

/** Map a transport failure to a calm, visitor-facing message (no em dashes, natural language). */
export function errorMessageFor(status: number): string {
  if (status === 429) return 'You are sending messages a little too fast. Please wait a moment and try again.';
  return 'Sorry, something went wrong reaching support. Please try again in a moment.';
}

/** Turn a KB source path into a short, human label for a citation chip. */
export function sourceLabel(source: string): string {
  const base = source.split('/').pop() ?? source;
  return base.replace(/\.md$/, '').replace(/^\d+[-_]?/, '').replace(/[-_]/g, ' ').trim() || base;
}

/**
 * Issue 1 / F-48 (shared-device privacy). Should the widget drop its stored conversation because the
 * person using this browser changed? A conversation started by a SIGNED-IN account is never shown to
 * or continued by anyone else (another account, or a signed-out visitor). An anonymous conversation
 * carries over when that visitor signs in (the server accepts it by capability token).
 */
export function shouldResetSupportChat(ownerUserId: string | null, conversationId: string | null, currentUserId: string | null): boolean {
  if (!conversationId) return false;
  if (ownerUserId === null) return false;
  return ownerUserId !== currentUserId;
}

/** Best-effort, UNVERIFIED read of a JWT's `sub` (the user id). Only decides whose chat to show locally;
 *  the server authorises every write independently. */
export function subjectFromToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}
