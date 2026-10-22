import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEAL_COLOURS, tradeHistoryLines, tradeHistoryMarks, type ClosedDeal } from './tradeHistory.js';

const deal = (over: Partial<ClosedDeal> = {}): ClosedDeal => ({
  id: 'd1',
  direction: 'buy',
  openedAtMs: Date.UTC(2026, 9, 6, 12, 0, 0),
  settledAtMs: Date.UTC(2026, 9, 6, 12, 1, 0),
  entryPrice: 3080,
  exitPrice: 3085,
  pnlCents: 22_500,
  ticket: '100001',
  ...over,
});

test('a closed deal is two marks: into the trade, then out of it', () => {
  const marks = tradeHistoryMarks([deal()]);
  assert.equal(marks.length, 2);
  const [entry, exit] = marks;
  // A BUY opens from below the price and closes from above it, which is how MetaTrader points the
  // pair: the first arrow into the trade, the second out.
  assert.equal(entry!.side, 'entry');
  assert.equal(entry!.position, 'belowBar');
  assert.equal(entry!.shape, 'arrowUp');
  assert.equal(exit!.position, 'aboveBar');
  assert.equal(exit!.shape, 'arrowDown');
  // A SELL is the mirror of it.
  const sell = tradeHistoryMarks([deal({ direction: 'sell' })]);
  assert.equal(sell[0]!.position, 'aboveBar');
  assert.equal(sell[0]!.shape, 'arrowDown');
  assert.equal(sell[1]!.position, 'belowBar');
  assert.equal(sell[1]!.shape, 'arrowUp');
});

test('the EXIT carries the result colour and the ENTRY carries the direction', () => {
  // At the moment of entry there is no result yet, so the entry cannot be coloured by one.
  const win = tradeHistoryMarks([deal({ pnlCents: 10_000 })]);
  assert.equal(win[0]!.color, DEAL_COLOURS.buy);
  assert.equal(win[1]!.color, DEAL_COLOURS.win);
  const loss = tradeHistoryMarks([deal({ pnlCents: -10_000 })]);
  assert.equal(loss[1]!.color, DEAL_COLOURS.loss);
  // A deal that broke exactly even is not a win: MetaTrader's blue means a profit.
  assert.equal(tradeHistoryMarks([deal({ pnlCents: 0 })])[1]!.color, DEAL_COLOURS.loss);
});

test('a mark names its ticket, so the chart and the History tab agree', () => {
  const marks = tradeHistoryMarks([deal({ ticket: '100042' })]);
  assert.ok(marks[0]!.text.includes('100042'));
  assert.ok(marks[1]!.text.includes('100042'));
  assert.ok(marks[0]!.text.includes('buy'), 'the entry says which way it went');
});

test('time is in SECONDS, which is what the chart takes', () => {
  const marks = tradeHistoryMarks([deal()]);
  assert.equal(marks[0]!.time, Math.floor(Date.UTC(2026, 9, 6, 12, 0, 0) / 1000));
  assert.ok(marks[0]!.time < 2e10, 'not milliseconds');
});

test('a deal this chart cannot price is not drawn at a price it never traded at', () => {
  // A position opened before midnight and closed after it has an entry priced against yesterday's
  // anchor, which this chart does not hold. Half a deal is better than a wrong one.
  const halfOpen = tradeHistoryMarks([deal({ entryPrice: null })]);
  assert.equal(halfOpen.length, 1);
  assert.equal(halfOpen[0]!.side, 'exit');
  const halfClosed = tradeHistoryMarks([deal({ exitPrice: null })]);
  assert.equal(halfClosed.length, 1);
  assert.equal(halfClosed[0]!.side, 'entry');
  // Neither end priceable: nothing at all.
  assert.deepEqual(tradeHistoryMarks([deal({ entryPrice: null, exitPrice: null })]), []);
  // And a position still open has no exit yet.
  assert.equal(tradeHistoryMarks([deal({ settledAtMs: null })]).length, 1);
});

test('marks come out oldest first, whatever order the deals arrived in', () => {
  const older = deal({ id: 'a', openedAtMs: 1_000_000, settledAtMs: 1_060_000 });
  const newer = deal({ id: 'b', openedAtMs: 9_000_000, settledAtMs: 9_060_000 });
  const marks = tradeHistoryMarks([newer, older]);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i]!.time >= marks[i - 1]!.time);
});

test('a line joins the two ends, and only when both ends are on this chart', () => {
  const [line] = tradeHistoryLines([deal()]);
  assert.ok(line);
  assert.equal(line.from.price, 3080);
  assert.equal(line.to.price, 3085);
  assert.equal(line.color, DEAL_COLOURS.win);
  // Half a deal gets no line: it would run off to a point that was never priced.
  assert.deepEqual(tradeHistoryLines([deal({ exitPrice: null })]), []);
  assert.deepEqual(tradeHistoryLines([deal({ settledAtMs: null })]), []);
});
