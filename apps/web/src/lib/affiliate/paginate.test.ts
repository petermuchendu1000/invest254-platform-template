import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageInfo, pageSlice } from './paginate.js';

// ── Basic windowing ────────────────────────────────────────────────────────────────────────────
test('pageInfo: 50 rows, 6 per page → 9 pages, first page window', () => {
  const p = pageInfo(50, 1, 6);
  assert.equal(p.pageCount, 9);
  assert.equal(p.start, 0);
  assert.equal(p.end, 6);
  assert.equal(p.hasPrev, false);
  assert.equal(p.hasNext, true);
});

test('pageInfo: last page holds the remainder, not a full page', () => {
  const p = pageInfo(50, 9, 6); // 50 = 8*6 + 2
  assert.equal(p.start, 48);
  assert.equal(p.end, 50);
  assert.equal(p.hasNext, false);
  assert.equal(p.hasPrev, true);
});

test('pageInfo: exact multiple has no stray trailing page', () => {
  const p = pageInfo(48, 8, 6);
  assert.equal(p.pageCount, 8);
  assert.equal(p.end, 48);
  assert.equal(p.hasNext, false);
});

// ── Totality: hostile input is clamped, never thrown ─────────────────────────────────────────────
test('pageInfo: empty list is a single empty page', () => {
  const p = pageInfo(0, 1, 6);
  assert.equal(p.pageCount, 1);
  assert.equal(p.start, 0);
  assert.equal(p.end, 0);
  assert.equal(p.hasPrev, false);
  assert.equal(p.hasNext, false);
});

test('pageInfo: page beyond the end snaps to the last page', () => {
  const p = pageInfo(10, 999, 6);
  assert.equal(p.page, 2);
  assert.equal(p.start, 6);
  assert.equal(p.end, 10);
});

test('pageInfo: page below 1 snaps to the first page', () => {
  const p = pageInfo(10, 0, 6);
  assert.equal(p.page, 1);
  const q = pageInfo(10, -5, 6);
  assert.equal(q.page, 1);
});

test('pageInfo: size < 1 or junk is coerced to 1 per page', () => {
  assert.equal(pageInfo(3, 1, 0).pageCount, 3);
  assert.equal(pageInfo(3, 1, -4).pageCount, 3);
  assert.equal(pageInfo(3, 1, Number.NaN).pageCount, 3);
});

test('pageInfo: junk page/total coerce to safe values', () => {
  const p = pageInfo(Number.NaN, Number.NaN, 6);
  assert.equal(p.total, 0);
  assert.equal(p.page, 1);
  assert.equal(p.pageCount, 1);
});

// ── pageSlice mirrors pageInfo and never over-reads ──────────────────────────────────────────────
test('pageSlice: returns exactly the current window', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  assert.deepEqual(pageSlice(items, 1, 6), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(pageSlice(items, 9, 6), [48, 49]);
  assert.deepEqual(pageSlice(items, 999, 6), [48, 49]); // clamped
  assert.deepEqual(pageSlice([], 1, 6), []);
});

// ── Invariant fuzz: window is always valid, contiguous, and covers the list exactly once ─────────
test('fuzz: pages tile the list with no gaps or overlaps', () => {
  let seed = 987654321;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 5000; i++) {
    const total = Math.floor(rand() * 200);
    const size = 1 + Math.floor(rand() * 20);
    const items = Array.from({ length: total }, (_, k) => k);
    const first = pageInfo(total, 1, size);
    let seen: number[] = [];
    for (let pg = 1; pg <= first.pageCount; pg++) {
      const info = pageInfo(total, pg, size);
      // window bounds are always sane
      assert.ok(info.start >= 0 && info.end >= info.start && info.end <= total);
      // each page is full except possibly the last
      const len = info.end - info.start;
      if (pg < info.pageCount) assert.equal(len, size);
      else assert.ok(len >= 0 && len <= size);
      seen = seen.concat(pageSlice(items, pg, size));
    }
    // concatenating every page reconstructs the list exactly, in order
    assert.deepEqual(seen, items);
  }
});
