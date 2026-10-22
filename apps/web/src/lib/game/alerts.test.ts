import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_CONDITIONS, alertDue, type AlertQuote, type PriceAlert } from './alerts.js';

/**
 * `alertDue` is the whole rule: which side a condition reads, and MetaTrader's four repeat controls.
 * It is pure, so every one of those is pinned here rather than being discovered in a live terminal.
 */

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  enabled: true,
  symbol: 'XAUUSD',
  condition: 'last>',
  price: 3090,
  timeHHMM: '',
  limit: 1,
  timeoutS: 10,
  expiresAtMs: null,
  counter: 0,
  createdAtMs: 0,
  triggeredAtMs: null,
  ...over,
});

/** Gold at 3089.80 with a 58-point spread: bid 3089.51, ask 3090.09. */
const QUOTE: AlertQuote = { last: 3089.80, bid: 3089.51, ask: 3090.09 };
// Deliberately mid-minute: a `Time =` alert's "already fired this minute" rule is checked below,
// and on the stroke of the minute a firing thirty seconds earlier is in the PREVIOUS one.
const NOW = Date.UTC(2026, 9, 6, 12, 0, 45);

test("the condition list is MetaTrader's, less the two it has no data for", () => {
  assert.deepEqual(ALERT_CONDITIONS.map((c) => c.label), [
    'Bid <', 'Bid >', 'Ask <', 'Ask >', 'Last <', 'Last >', 'Time =',
  ]);
  // The feed carries no volume at all, so `Volume <` and `Volume >` have nothing to compare.
  assert.ok(!ALERT_CONDITIONS.some((c) => c.label.startsWith('Volume')));
});

test('each condition reads its OWN side, which is the point of having six of them', () => {
  // 3090 sits between the bid and the ask, so the same level is true on one side and false on the
  // other. A platform that checked every price condition against Last could not express this.
  assert.equal(alertDue(alert({ condition: 'ask>', price: 3090 }), QUOTE, NOW), true, 'ask 3090.09 > 3090');
  assert.equal(alertDue(alert({ condition: 'bid>', price: 3090 }), QUOTE, NOW), false, 'bid 3089.51 is not');
  assert.equal(alertDue(alert({ condition: 'bid<', price: 3090 }), QUOTE, NOW), true);
  assert.equal(alertDue(alert({ condition: 'ask<', price: 3090 }), QUOTE, NOW), false);
  assert.equal(alertDue(alert({ condition: 'last>', price: 3090 }), QUOTE, NOW), false, 'last 3089.80 is not');
  assert.equal(alertDue(alert({ condition: 'last<', price: 3090 }), QUOTE, NOW), true);
});

test('the comparison is strict, because the row says `<` and not `≤`', () => {
  assert.equal(alertDue(alert({ condition: 'last<', price: 3089.80 }), QUOTE, NOW), false);
  assert.equal(alertDue(alert({ condition: 'last>', price: 3089.80 }), QUOTE, NOW), false);
});

test('a Bid or Ask alert on a brand with no spread never fires, rather than firing on Last', () => {
  const oneSided: AlertQuote = { last: 3089.80, bid: null, ask: null };
  assert.equal(alertDue(alert({ condition: 'bid<', price: 3090 }), oneSided, NOW), false);
  assert.equal(alertDue(alert({ condition: 'ask>', price: 3000 }), oneSided, NOW), false);
  // Last still works, which is the condition such a brand's trader would have armed.
  assert.equal(alertDue(alert({ condition: 'last<', price: 3090 }), oneSided, NOW), true);
});

test("MetaTrader's four repeat controls each stop a firing", () => {
  const due = { condition: 'last<' as const, price: 3090 };
  assert.equal(alertDue(alert(due), QUOTE, NOW), true, 'armed');
  assert.equal(alertDue(alert({ ...due, enabled: false }), QUOTE, NOW), false, 'Enable unchecked');
  assert.equal(alertDue(alert({ ...due, counter: 1, limit: 1 }), QUOTE, NOW), false, 'Maximum iterations spent');
  assert.equal(alertDue(alert({ ...due, expiresAtMs: NOW - 1 }), QUOTE, NOW), false, 'Expiration passed');
  // Timeout: a firing nine seconds ago holds off a ten-second alert, eleven does not.
  assert.equal(alertDue(alert({ ...due, limit: 5, counter: 1, triggeredAtMs: NOW - 9_000 }), QUOTE, NOW), false);
  assert.equal(alertDue(alert({ ...due, limit: 5, counter: 1, triggeredAtMs: NOW - 11_000 }), QUOTE, NOW), true);
});

test('a Time = alert fires once inside the minute it names, not once per timeout', () => {
  const at = new Date(NOW);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const t = alert({ condition: 'time=', timeHHMM: hhmm, limit: 5 });
  assert.equal(alertDue(t, QUOTE, NOW), true);
  // Already fired this minute: a ten-second timeout would otherwise fire it six times over.
  assert.equal(alertDue({ ...t, counter: 1, triggeredAtMs: NOW - 30_000 }, QUOTE, NOW), false);
  // A different minute is a different firing.
  assert.equal(alertDue({ ...t, timeHHMM: '00:01' }, QUOTE, NOW), false, 'not this minute');
  // And it needs no price at all, which is why it survives on a brand with no quote yet.
  assert.equal(alertDue(t, { last: null, bid: null, ask: null }, NOW), true);
});
