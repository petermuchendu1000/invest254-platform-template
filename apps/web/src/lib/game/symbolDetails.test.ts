import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailRows, sessionSoFar } from './symbolDetails.js';

const base = {
  digits: 5,
  last: 1.08920,
  sides: null,
  session: { open: 1.10415, high: 1.10477, low: 1.08996 },
  previousClose: 1.10415,
  faceValue: '10 000.00',
};

/**
 * MetaTrader's Details tab, against the row list read off its own screenshot. What matters is the
 * ORDER and the LABELS: both are MetaTrader's, and a row this instrument cannot fill is absent
 * rather than printed empty.
 */

test("the rows are MetaTrader's, in MetaTrader's order", () => {
  // A brand that publishes no spread has no two sides, so the Bid and Ask rows are absent rather
  // than printing the same number twice.
  assert.deepEqual(detailRows(base).map((r) => r.label), [
    'Tick Size', 'Face Value', 'Last', 'Last High', 'Last Low', 'Daily Change', 'Open Price', 'Close Price',
  ]);
});

test('Bid and Ask appear, ahead of Last, once the brand publishes a spread', () => {
  const rows = detailRows({ ...base, sides: { bid: 1.08915, ask: 1.08925 } });
  assert.deepEqual(rows.map((r) => r.label), [
    'Tick Size', 'Face Value', 'Bid', 'Ask', 'Last', 'Last High', 'Last Low',
    'Daily Change', 'Open Price', 'Close Price',
  ]);
  // Both are quoted to the symbol's digits, and both tick, as Last does.
  const bid = rows.find((r) => r.label === 'Bid')!;
  const ask = rows.find((r) => r.label === 'Ask')!;
  assert.equal(bid.value, '1.08915');
  assert.equal(ask.value, '1.08925');
  assert.equal(bid.live, true);
  assert.equal(ask.live, true);
  // The HIGH and LOW pair stays the Last trio's: MetaTrader uses those when a symbol's chart is
  // built on Last prices, which is what this one's Chart mode says.
  assert.ok(!rows.some((r) => r.label === 'Bid High' || r.label === 'Ask Low'));
});

/**
 * `Tick Value` and `Face Value` are the two rows a one-price platform keeps: neither is two-sided,
 * so the argument that deletes Bid/Ask/Spread (docs/mt5/10-market-watch.md 404-417) leaves both, and
 * both head MetaTrader's own list (603-638). Face Value is statable here and Tick Value is not —
 * see the reasoning in symbolDetails.ts.
 */
test('Face Value is the nominal sum one lot stakes, bare', () => {
  const face = detailRows(base).find((r) => r.label === 'Face Value');
  assert.equal(face?.value, '10 000.00');
  assert.equal(face?.live, false, 'the brand sets it, so it does not tick');
  assert.ok(!/[A-Z]/.test(String(face?.value)), 'no currency code: 09-toolbox.md 429');
});

test('Tick Value is absent rather than invented', () => {
  // The money a tick is worth is stake * gain, and `gain` is calibrated per DIRECTION inside the
  // settlement engine and never sent to the client. One figure cannot be true for both sides.
  assert.ok(!detailRows(base).some((r) => r.label === 'Tick Value'));
});

test('it says Last High and Last Low, not Bid High and Bid Low', () => {
  // MetaTrader uses the Last pair when a symbol's chart is built on Last prices, which is what this
  // instrument's Chart mode says. Printing the Bid pair would claim a bid that does not exist.
  const labels = detailRows(base).map((r) => r.label);
  assert.ok(labels.includes('Last High') && labels.includes('Last Low'));
  assert.ok(!labels.some((l) => /^Bid|^Ask/.test(l)), JSON.stringify(labels));
});

test('every value prints to the symbol’s own digit count', () => {
  const rows = detailRows(base);
  assert.equal(rows[0]!.value, '0.00001');
  assert.equal(rows[2]!.value, '1.08920');
  assert.equal(rows[3]!.value, '1.10477');
  assert.equal(rows[4]!.value, '1.08996');
  // Gold, at two.
  const gold = detailRows({ digits: 2, last: 3079.43, sides: null, session: { open: 3080, high: 3081, low: 3077 }, previousClose: 3080, faceValue: '10 000.00' });
  assert.equal(gold[0]!.value, '0.01');
  assert.equal(gold[2]!.value, '3079.43');
});

test('Daily Change is measured against the previous session close, as MetaTrader defines it', () => {
  // "The difference between the last price of the instrument and the close price of the last
  // session in percentage terms." No space before the percent sign, unlike the account strip.
  const change = detailRows(base).find((r) => r.label === 'Daily Change');
  assert.equal(change?.value, '-1.35%');
  assert.ok(!/ %/.test(String(change?.value)));
  const up = detailRows({ ...base, last: 1.11519 }).find((r) => r.label === 'Daily Change');
  assert.equal(up?.value, '+1.00%');
});

test('only the rows that actually tick are marked live', () => {
  // MetaTrader: "Static rows show the grey dot and black text; live rows show green/red arrows and
  // blue/red values." The session's high, low, open and close move once a day; the tick size never.
  const live = detailRows(base).filter((r) => r.live).map((r) => r.label);
  assert.deepEqual(live, ['Last', 'Daily Change']);
});

test('a row with nothing behind it prints a dash rather than a number', () => {
  const cold = detailRows({ digits: 5, last: null, sides: null, session: null, previousClose: null, faceValue: '10 000.00' });
  assert.deepEqual(cold.map((r) => r.value), ['0.00001', '10 000.00', '-', '-', '-', '-', '-', '-']);
});

/**
 * The session figures. This is the bug the MetaTrader labels exposed: the panel used to show the
 * last CLOSED daily bar, which before midnight is YESTERDAY's, beside a Daily Change measured
 * against today's base. Every number was true and the set of them was not.
 */

const H1 = (iso: string, o: number, h: number, l: number, c: number) =>
  ({ time: Date.parse(iso) / 1000, open: o, high: h, low: l, close: c });

test('the session is today’s hours, not yesterday’s closed daily bar', () => {
  const bars = [
    H1('2026-03-17T22:00:00Z', 9, 9, 9, 9),   // yesterday: must not count
    H1('2026-03-18T00:00:00Z', 1.10, 1.11, 1.09, 1.10),
    H1('2026-03-18T01:00:00Z', 1.10, 1.12, 1.08, 1.11),
  ];
  assert.deepEqual(sessionSoFar(bars, '2026-03-18', null), { open: 1.10, high: 1.12, low: 1.08 });
});

test('the hour still forming is covered by the live price', () => {
  // The engine never serves an unfinished bar, so the current hour's extremes can only come from
  // the live quote. Without this the high and low would freeze on the hour.
  const bars = [H1('2026-03-18T00:00:00Z', 1.10, 1.11, 1.09, 1.10)];
  assert.deepEqual(sessionSoFar(bars, '2026-03-18', 1.15), { open: 1.10, high: 1.15, low: 1.09 });
  assert.deepEqual(sessionSoFar(bars, '2026-03-18', 1.05), { open: 1.10, high: 1.11, low: 1.05 });
  // And it never moves the OPEN, which is a fact about the start of the session.
  assert.equal(sessionSoFar(bars, '2026-03-18', 1.15)!.open, 1.10);
});

test('just after midnight the live price is the whole session', () => {
  assert.deepEqual(sessionSoFar([], '2026-03-18', 1.10), { open: 1.10, high: 1.10, low: 1.10 });
  // And with neither bars nor a quote there is nothing to claim.
  assert.equal(sessionSoFar([], '2026-03-18', null), null);
});
