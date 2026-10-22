import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  logJournal, getJournal, resetJournal, subscribeJournal,
  logExperts, getExperts, resetExperts,
} from './journal.js';

/**
 * Two logs, because MetaTrader draws two: the Journal is what the TERMINAL did and the Experts
 * journal is what the PROGRAMS on the chart did. The thing worth pinning is that they are genuinely
 * separate — a single buffer with a filter would let a socket error appear in the Experts tab, and
 * an indicator line appear in the Journal, which is not what either tab means.
 */

test('the two logs are independent buffers', () => {
  resetJournal();
  resetExperts();

  logJournal('ok', 'Network', 'connected to the trade server');
  assert.equal(getJournal().length, 1);
  assert.equal(getExperts().length, 0, 'a terminal event does not appear in the Experts journal');

  logExperts('info', 'RSI', 'indicator applied to the chart (14)');
  assert.equal(getExperts().length, 1);
  assert.equal(getJournal().length, 1, 'and an indicator event does not appear in the Journal');

  // Each has its own sequence, so an id is unique within a tab rather than across both.
  assert.equal(getJournal()[0]!.id, 1);
  assert.equal(getExperts()[0]!.id, 1);
});

test('clearing one log leaves the other alone', () => {
  resetJournal();
  resetExperts();
  logJournal('info', 'Trade', 'order sent');
  logExperts('ok', 'MACD', 'initialised (12,26,9)');

  resetJournal();
  assert.equal(getJournal().length, 0);
  assert.equal(getExperts().length, 1, 'the Experts journal survives a Journal clear');
});

test('an entry carries the fields the grid draws, oldest first', () => {
  resetJournal();
  const before = Date.now();
  logJournal('warn', 'Alert', 'XAUUSD bid > 3078.30');
  const e = getJournal()[0]!;
  assert.equal(e.level, 'warn');
  assert.equal(e.tag, 'Alert', 'the Source column');
  assert.equal(e.text, 'XAUUSD bid > 3078.30', 'the Message column');
  assert.ok(e.atMs >= before, 'the Time column is stamped when the event happened');

  logJournal('info', 'Network', 'second');
  assert.deepEqual(getJournal().map((x) => x.text), ['XAUUSD bid > 3078.30', 'second'],
    'the buffer is chronological; the tab reverses it for display');
});

test('a write produces a new array, so a subscriber re-renders', () => {
  resetJournal();
  let notified = 0;
  const off = subscribeJournal(() => { notified++; });
  const first = getJournal();
  logJournal('info', 'Network', 'tick');
  assert.equal(notified, 1);
  assert.notEqual(getJournal(), first, 'the snapshot changed identity, not just its contents');
  off();
  logJournal('info', 'Network', 'another');
  assert.equal(notified, 1, 'and an unsubscribed listener stops hearing about it');
});

test('the ring is bounded, so a tab left open all day cannot grow forever', () => {
  resetJournal();
  for (let i = 0; i < 620; i++) logJournal('info', 'Network', `line ${i}`);
  const entries = getJournal();
  assert.equal(entries.length, 500);
  assert.equal(entries[0]!.text, 'line 120', 'the oldest lines are the ones dropped');
  assert.equal(entries[entries.length - 1]!.text, 'line 619');
});
