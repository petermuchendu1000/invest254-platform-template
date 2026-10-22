import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCards, shuffle, eligible, keyOf, MIN_WITHDRAWAL_CENTS } from './activityCards.js';
import type { BrandActivityDto } from '@/lib/api/types';

/**
 * The notification's selection rules.
 *
 * These exist because of a production failure: the component walked the feed with `.reverse()`,
 * under a comment claiming the server sends oldest-first. It sends NEWEST-first, so the reversal
 * made the burst pick the three OLDEST eligible rows — which on a real brand were one prolific
 * trader's wins from fifteen days earlier, repeated on every card, while fresh activity sat unused
 * at the top of the array.
 */

const row = (over: Partial<BrandActivityDto> = {}): BrandActivityDto => ({
  kind: 'win', name: 'Someone', amountCents: 500_00, agoSeconds: 60, ...over,
}) as BrandActivityDto;

/** A feed exactly as `recent()` returns it: freshest first. */
const FEED: BrandActivityDto[] = [
  row({ name: 'Akinyi', agoSeconds: 60 }),
  row({ name: 'Barasa', agoSeconds: 120 }),
  row({ name: 'Chebet', agoSeconds: 180 }),
  row({ name: 'Mkeeee', agoSeconds: 1_300_000 }),
  row({ name: 'Mkeeee', agoSeconds: 1_300_100, amountCents: 600_00 }),
  row({ name: 'Mkeeee', agoSeconds: 1_300_200, amountCents: 700_00 }),
];

/** A deterministic stand-in for Math.random: replays a fixed cycle of values. */
const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]!; };

test('the draw is TOTALLY random — position in the feed buys a row nothing', () => {
  // rng() === 0 makes Fisher-Yates swap with index 0 at every step, which rotates the array left
  // by one: [A,B,C,D,E,F] -> [B,C,D,E,F,A]. So the row drawn first is the feed's SECOND, not its
  // first — the point being that the newest row has no special claim on the card.
  const { take } = selectCards(FEED, new Set(), [], 1, () => 0);
  assert.equal(take[0]!.name, 'Barasa');
  assert.notEqual(take[0]!.agoSeconds, FEED[0]!.agoSeconds, 'the newest row was picked by position');

  // A different stream yields a different row from the very same feed.
  const other = selectCards(FEED, new Set(), [], 1, seq(0.99)).take[0]!;
  assert.notEqual(other.agoSeconds, take[0]!.agoSeconds);
});

test('over many draws every row gets a turn, and none dominates', () => {
  // The real guarantee behind "random": no row is structurally favoured or starved.
  const counts = new Map<string, number>();
  for (let i = 0; i < 4000; i++) {
    const { take } = selectCards(FEED, new Set(), [], 1);
    for (const t of take) counts.set(keyOf(t), (counts.get(keyOf(t)) ?? 0) + 1);
  }
  assert.equal(counts.size, FEED.length, 'some row never appeared across 4000 draws');
  const hits = [...counts.values()];
  // Uniform would be ~667 each; this is a wide band that still catches a stuck or biased draw.
  assert.ok(Math.min(...hits) > 350, `a row was starved: ${Math.min(...hits)}`);
  assert.ok(Math.max(...hits) < 1100, `a row dominated: ${Math.max(...hits)}`);
});

test('shuffle returns a permutation and does not mutate its input', () => {
  const src = [1, 2, 3, 4, 5];
  const out = shuffle(src, seq(0.1, 0.9, 0.4, 0.7));
  assert.deepEqual(src, [1, 2, 3, 4, 5], 'the source array was mutated');
  assert.deepEqual([...out].sort(), [...src].sort(), 'not a permutation');
});

test('one card per trader, however many rows they hold', () => {
  // A feed where the freshest rows are all the same account, which is the other half of the fault.
  const burst = [
    row({ name: 'Mkeeee', agoSeconds: 10 }),
    row({ name: 'Mkeeee', agoSeconds: 20, amountCents: 900_00 }),
    row({ name: 'Mkeeee', agoSeconds: 30, amountCents: 800_00 }),
    row({ name: 'Wanjiku', agoSeconds: 40 }),
  ];
  const { take } = selectCards(burst, new Set(), [], 3);
  // Whatever the draw, the three Mkeeee rows can contribute at most one card.
  assert.equal(take.length, 2);
  assert.equal(new Set(take.map((t) => t.name.toLowerCase())).size, 2);
  assert.ok(take.some((t) => t.name === 'Wanjiku'));
});

test('a trader shown recently does not open the next card either', () => {
  const { take } = selectCards(FEED, new Set(), ['akinyi', 'barasa'], 3);
  const names = take.map((t) => t.name.toLowerCase());
  assert.ok(!names.includes('akinyi') && !names.includes('barasa'), 'a recent trader opened another card');
});

test('names are matched case- and space-insensitively, so padding cannot defeat the rule', () => {
  const feed = [row({ name: ' MKEEEE ' }), row({ name: 'Mkeeee', amountCents: 999_00 })];
  const { take } = selectCards(feed, new Set(), [], 5);
  assert.equal(take.length, 1);
});

test('only what was SHOWN is marked seen, so the rest stay in the pool for later draws', () => {
  const { take, seenKeys } = selectCards(FEED, new Set(), [], 2);
  assert.equal(take.length, 2);
  // Burning the whole window to show two would leave a player with a few cards and then silence.
  assert.equal(seenKeys.length, 2);

  // Draining the pool over successive polls shows each row exactly once and then stops.
  const seen = new Set<string>();
  let drawn = 0;
  for (let i = 0; i < 20; i++) {
    const r = selectCards(FEED, seen, [], 2);
    drawn += r.take.length;
    for (const k of r.seenKeys) seen.add(k);
  }
  assert.equal(drawn, FEED.length, 'the pool did not drain exactly once through');
  assert.equal(selectCards(FEED, seen, [], 2).take.length, 0, 'a shown row came back');
});

test('what earns a card: every win, a withdrawal only above the floor, never a deposit', () => {
  assert.equal(eligible(row({ kind: 'win', amountCents: 1 })), true);
  assert.equal(eligible(row({ kind: 'deposit', amountCents: 10_000_00 })), false);
  assert.equal(eligible(row({ kind: 'withdrawal', amountCents: MIN_WITHDRAWAL_CENTS })), true);
  assert.equal(eligible(row({ kind: 'withdrawal', amountCents: MIN_WITHDRAWAL_CENTS - 1 })), false);
});

test('identity ignores age, which the server recomputes on every poll', () => {
  assert.equal(keyOf(row({ agoSeconds: 5 })), keyOf(row({ agoSeconds: 9_999 })));
  assert.notEqual(keyOf(row({ name: 'A' })), keyOf(row({ name: 'B' })));
  assert.notEqual(keyOf(row({ amountCents: 1 })), keyOf(row({ amountCents: 2 })));
});

test('an empty or all-seen feed queues nothing rather than throwing', () => {
  assert.deepEqual(selectCards([], new Set(), [], 3).take, []);
  const all = new Set(FEED.map(keyOf));
  assert.deepEqual(selectCards(FEED, all, [], 3).take, []);
});
