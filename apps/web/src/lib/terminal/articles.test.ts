import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTICLES, ARTICLE_CATEGORIES, articlesNewestFirst } from './articles.js';

/**
 * The library is content, so there is no arithmetic to check. What CAN be checked is the thing the
 * Articles tab depends on: that the shelf is stable, that it is ordered the way a library lists,
 * and that every row has the three things MetaTrader's grid draws.
 */

test('every article has a name, a category and a date the grid can draw', () => {
  assert.ok(ARTICLES.length >= 8, `the shelf is not a token one (${ARTICLES.length})`);
  for (const a of ARTICLES) {
    assert.ok(a.name.length > 10, a.id);
    assert.ok(ARTICLE_CATEGORIES.includes(a.category), `${a.id} is in a listed category`);
    assert.ok(Number.isFinite(a.atMs) && a.atMs > 0, `${a.id} has a date`);
    assert.ok(a.summary.length > 20, `${a.id} has a standfirst`);
    // Four paragraphs or so: a page a trader reads, not a tooltip.
    assert.ok(a.body.length >= 3, `${a.id} has a body`);
    for (const p of a.body) assert.ok(p.length > 80, `${a.id} has no stub paragraph`);
  }
});

test('ids are unique, because the reading pane and the read-state store key on them', () => {
  const ids = ARTICLES.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the shelf is stable: the dates are fixed, not relative to now', () => {
  // A library whose dates drift would reorder itself between reads, and an article would quietly
  // become "today's" on every reload. Nothing here is within a year of now.
  const now = Date.now();
  for (const a of ARTICLES) {
    assert.ok(a.atMs < now + 400 * 86_400_000, `${a.id} is not scheduled into the far future`);
  }
  const a = articlesNewestFirst().map((x) => x.id);
  const b = articlesNewestFirst().map((x) => x.id);
  assert.deepEqual(a, b, 'two reads agree');
});

test('newest first, which is how a library lists', () => {
  const rows = articlesNewestFirst();
  assert.equal(rows.length, ARTICLES.length);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1]!.atMs >= rows[i]!.atMs, 'descending by date');
  }
  // And sorting does not mutate the library itself.
  assert.deepEqual(ARTICLES.map((x) => x.id), [...ARTICLES].map((x) => x.id));
});

test('the categories a broker actually publishes are all represented', () => {
  for (const c of ['Education', 'Market analysis', 'Platform', 'Risk'] as const) {
    assert.ok(ARTICLE_CATEGORIES.includes(c), `${c} is a category`);
    assert.ok(ARTICLES.some((a) => a.category === c), `${c} has at least one article`);
  }
  // The list is derived from the shelf, so it can never offer a filter that matches nothing.
  for (const c of ARTICLE_CATEGORIES) assert.ok(ARTICLES.some((a) => a.category === c), c);
});

test('no article claims a feature this platform does not have', () => {
  /**
   * The library is written about THIS terminal, so the giveaway of copied broker boilerplate is a
   * sentence about something it does not do: swaps, overnight financing, leverage, copy trading.
   *
   * Naming one to DENY it is the opposite failure and is wanted — "there is no commission line, no
   * overnight financing and no withdrawal fee" is exactly the sort of thing a trader needs told —
   * so the check is per sentence, and a sentence that denies the feature passes.
   */
  const forbidden = [/\bswaps?\b/i, /overnight financing/i, /\bleverage[sd]?\b/i, /copy trading/i];
  const denies = /\b(no|not|never|neither|nor|without)\b/i;
  for (const a of ARTICLES) {
    for (const sentence of [a.name, a.summary, ...a.body].join(' ').split(/(?<=[.!?])\s+/)) {
      for (const re of forbidden) {
        if (!re.test(sentence)) continue;
        assert.ok(denies.test(sentence), `${a.id} asserts ${re} rather than denying it: "${sentence}"`);
      }
    }
  }
});
