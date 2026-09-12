/**
 * Pure, side-effect-free pagination math for the marketer dashboard's client-side ledgers.
 *
 * The marketer's earnings / expenses / referrals / advance-request lists arrive as already-loaded
 * arrays (single-fetch queries) or as an accumulating pool of cursor-paged rows (referrals). Rather
 * than dumping every row on screen — which fails the "bank-standard: do we really list all 50?"
 * test — the dashboard shows one bounded page at a time. This module owns ONLY the arithmetic so it
 * can be unit-tested exhaustively and the component stays declarative.
 *
 * Every function is total: it clamps hostile input (page 0, page 999, negative/NaN size, empty
 * arrays) to a valid window instead of throwing, so a transient data shape can never crash the page.
 */

export interface PageInfo {
  /** Current page, 1-based, clamped into [1, pageCount]. */
  page: number;
  /** Total number of pages, always >= 1 (an empty list is a single empty page). */
  pageCount: number;
  /** 0-based index of the first row on this page. */
  start: number;
  /** Exclusive 0-based index of the last row on this page (== total when on the final page). */
  end: number;
  /** Total number of rows across all pages. */
  total: number;
  /** True when a previous page exists. */
  hasPrev: boolean;
  /** True when a further page exists. */
  hasNext: boolean;
}

/** Coerce a value to a finite integer >= `min`, falling back to `min` for NaN/Infinity/junk. */
function intAtLeast(value: number, min: number): number {
  const n = Math.floor(value);
  return Number.isFinite(n) && n >= min ? n : min;
}

/**
 * Resolve the display window for a list of `total` rows shown `size` per page at requested `page`.
 * Input is clamped, never rejected: a page past the end snaps to the last page; size < 1 becomes 1.
 */
export function pageInfo(total: number, page: number, size: number): PageInfo {
  const safeTotal = intAtLeast(total, 0);
  const safeSize = Math.max(1, intAtLeast(size, 1));
  const pageCount = Math.max(1, Math.ceil(safeTotal / safeSize));
  const clamped = Math.min(Math.max(1, intAtLeast(page, 1)), pageCount);
  const start = (clamped - 1) * safeSize;
  const end = Math.min(start + safeSize, safeTotal);
  return {
    page: clamped,
    pageCount,
    start,
    end,
    total: safeTotal,
    hasPrev: clamped > 1,
    hasNext: clamped < pageCount,
  };
}

/** Return the rows visible on `page` (1-based) given `size` rows per page. Never throws. */
export function pageSlice<T>(items: readonly T[], page: number, size: number): T[] {
  const { start, end } = pageInfo(items.length, page, size);
  return items.slice(start, end);
}
