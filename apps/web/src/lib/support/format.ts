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
