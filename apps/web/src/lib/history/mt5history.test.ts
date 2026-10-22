import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodRange, periodSubtitle, dateOnly, stamp, ticketOf, positionTicket, isCompleted, signedCents, tradeDateOf, priceKnown,
  orderRows, dealRows, positionRows, ordersSummary, moneySummary, sortRows, priceText, EXECUTION_PRICE,
  DESKTOP_PERIODS, historyStrip, priceChangePct, changeText,
} from './mt5history.js';
import type { PositionDto, TransactionDto } from '../api/types.js';

const lots = (stakeCents: number) => (stakeCents / 1_000_000).toFixed(2);

function pos(over: Partial<PositionDto> & { id: string; openedAt: number }): PositionDto {
  return {
    gameDayId: 1, direction: 'buy', stakeCents: 1_000_000, entryRate: 1, exitRate: 1,
    multiplier: null, payoutCents: null, pnlCents: null, result: null, durationS: 5,
    status: 'settled', settledAt: over.openedAt + 5000, ...over,
  } as PositionDto;
}

function tx(over: Partial<TransactionDto> & { id: string; ts: number }): TransactionDto {
  return {
    kind: 'deposit', amountCents: 100_000, status: 'completed', provider: null, phone: null,
    mpesaReceipt: null, ...over,
  } as TransactionDto;
}

// 2026-06-15 12:00 local
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const DAY = 86_400_000;

test('periodRange: Today is local midnight to the next, and includes now', () => {
  const r = periodRange('today', NOW);
  assert.equal(new Date(r.fromMs).getHours(), 0);
  assert.equal(r.toMs - r.fromMs, DAY);
  assert.ok(NOW >= r.fromMs && NOW < r.toMs);
});

test('periodRange: the presets are 7 / 30 / 90 days ending with today', () => {
  for (const [key, days] of [['week', 7], ['month', 30], ['quarter', 90]] as const) {
    const r = periodRange(key, NOW);
    assert.equal(Math.round((r.toMs - r.fromMs) / DAY), days, key);
    assert.ok(NOW < r.toMs, `${key} includes today`);
  }
});

test('periodRange: a custom range entered backwards is read in the order meant', () => {
  const a = periodRange('custom', NOW, { fromMs: NOW, toMs: NOW - DAY });
  assert.equal(a.fromMs, NOW - DAY);
  assert.equal(a.toMs, NOW);
  // Missing ends fall back to "from the beginning" and "up to the end of today".
  const b = periodRange('custom', NOW, {});
  assert.equal(b.fromMs, 0);
  assert.equal(b.toMs, periodRange('today', NOW).toMs);
});

test('periodSubtitle: one day collapses to a single date, a span prints both', () => {
  assert.equal(periodSubtitle(periodRange('today', NOW)), '2026.06.15');
  assert.equal(periodSubtitle(periodRange('week', NOW)), '2026.06.09 - 2026.06.15');
});

test('MetaTrader date and time formats', () => {
  assert.equal(dateOnly(NOW), '2026.06.15');
  // Built with Date.UTC, because a record's time is the broker's SERVER time and `stamp` prints
  // UTC: a local-time constructor would make this assertion pass only where TZ is UTC.
  assert.equal(stamp(Date.UTC(2026, 5, 15, 9, 7, 4)), '2026.06.15 09:07:04');
});

test('a price is only knowable on the day its axis is anchored to', () => {
  const noon = Date.UTC(2026, 5, 15, 12, 0, 0);
  assert.equal(tradeDateOf(noon), '2026-06-15');
  assert.ok(priceKnown(noon, '2026-06-15'));
  // One UTC day earlier or later is a different anchor, so the price is NOT knowable.
  assert.ok(!priceKnown(noon - 86_400_000, '2026-06-15'));
  assert.ok(!priceKnown(noon + 86_400_000, '2026-06-15'));
  // The boundary is UTC midnight, not local midnight.
  assert.ok(priceKnown(Date.UTC(2026, 5, 15, 23, 59, 59), '2026-06-15'));
  assert.ok(!priceKnown(Date.UTC(2026, 5, 16, 0, 0, 0), '2026-06-15'));
  // No anchor yet (socket has not delivered one) means nothing is knowable.
  for (const a of [null, undefined, '']) assert.ok(!priceKnown(noon, a), String(a));
});

test('ticketOf: a record with no ticket of its own falls back to a uuid fragment', () => {
  // The only such record left is a BALANCE operation: a deposit is a transaction, not a position,
  // and nothing allocates it a number.
  assert.equal(ticketOf('3f2a1b4c-5d6e-7f80-9112-233445566778'), '3f2a1b4c');
});

test('positionTicket: a position shows MetaTrader\u2019s own ticket, not eight hex characters', () => {
  // Migration 0184. The hex fragment was never a ticket: it does not order, and it cannot be read
  // out over a phone call to support.
  assert.equal(positionTicket(pos({ id: '3f2a1b4c-5d6e-7f80-9112-233445566778', openedAt: NOW, ticket: 328674 })), '328674');
  // A row from before the column (the migration backfills every one it finds, so this is the
  // older-database case) keeps an identifier rather than printing a blank column.
  assert.equal(positionTicket(pos({ id: '3f2a1b4c-5d6e-7f80-9112-233445566778', openedAt: NOW })), '3f2a1b4c');
  assert.equal(positionTicket(pos({ id: '3f2a1b4c-5d6e-7f80-9112-233445566778', openedAt: NOW, ticket: null })), '3f2a1b4c');
});

test('the history grids carry the real ticket through to every row kind', () => {
  const p = pos({ id: '3f2a1b4c-5d6e-7f80-9112-233445566778', openedAt: NOW, ticket: 328674 });
  const range = { fromMs: NOW - DAY, toMs: NOW + DAY };
  assert.deepEqual(orderRows([p], range, 'XAUUSD', lots).map((r) => r.ticket), ['328674']);
  // A deal row per side of the round trip, both under the position's one ticket.
  assert.deepEqual(dealRows([p], [], range, 'XAUUSD', lots).map((r) => r.ticket), ['328674', '328674']);
  assert.deepEqual(positionRows([p], [], range, 'XAUUSD', lots).map((r) => r.ticket), ['328674']);
});

test('only money that actually moved is a balance operation', () => {
  assert.ok(isCompleted(tx({ id: 'a', ts: NOW, status: 'completed' })));
  assert.ok(isCompleted(tx({ id: 'a', ts: NOW, status: 'SUCCESS' })));
  assert.ok(!isCompleted(tx({ id: 'a', ts: NOW, status: 'pending' })));
  assert.ok(!isCompleted(tx({ id: 'a', ts: NOW, status: 'failed' })));
  // A withdrawal leaves the account however its amount is stored.
  assert.equal(signedCents(tx({ id: 'a', ts: NOW, kind: 'withdrawal', amountCents: 5000 })), -5000);
  assert.equal(signedCents(tx({ id: 'a', ts: NOW, kind: 'withdrawal', amountCents: -5000 })), -5000);
});

test('ORDERS: a void contract is a CANCELED order that filled nothing', () => {
  const r = periodRange('month', NOW);
  const rows = orderRows(
    [pos({ id: 'a', openedAt: NOW - DAY, result: 'win' }), pos({ id: 'b', openedAt: NOW - DAY, result: 'void' })],
    r, 'XAUUSD', lots,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0]!.state, rows[1]!.state], ['FILLED', 'CANCELED']);
  assert.equal(rows[0]!.filledLots, '1.00');
  assert.equal(rows[1]!.filledLots, '0.00');
  assert.deepEqual(ordersSummary(rows), { filled: 1, canceled: 1, total: 2 });
});

test('ORDERS: the period filters on when the order was PLACED', () => {
  const rows = orderRows([pos({ id: 'a', openedAt: NOW - 40 * DAY })], periodRange('week', NOW), 'XAUUSD', lots);
  assert.equal(rows.length, 0);
});

test('DEALS: a settled contract is an in deal and an out deal, and the out deal reverses the side', () => {
  const rows = dealRows(
    [pos({ id: 'a', openedAt: NOW - 1000, settledAt: NOW - 500, direction: 'buy', pnlCents: 12_345, result: 'win' })],
    [], periodRange('today', NOW), 'XAUUSD', lots,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0]!.entry, rows[1]!.entry], ['in', 'out']);
  assert.deepEqual([rows[0]!.side, rows[1]!.side], ['buy', 'sell']);
  // Only the closing execution carries a result.
  assert.equal(rows[0]!.amountCents, null);
  assert.equal(rows[1]!.amountCents, 12_345);
});

test('DEALS: a void contract produces no deal at all, and an open one only its entry', () => {
  const r = periodRange('today', NOW);
  assert.equal(dealRows([pos({ id: 'a', openedAt: NOW - 100, result: 'void' })], [], r, 'XAUUSD', lots).length, 0);
  const open = dealRows(
    [pos({ id: 'b', openedAt: NOW - 100, settledAt: null, status: 'open', result: null })],
    [], r, 'XAUUSD', lots,
  );
  assert.equal(open.length, 1);
  assert.equal(open[0]!.entry, 'in');
});

test('DEALS: deposits and withdrawals are balance deals; pending money is not', () => {
  const rows = dealRows([], [
    tx({ id: 'd', ts: NOW - 100, kind: 'deposit', amountCents: 500_000 }),
    tx({ id: 'w', ts: NOW - 50, kind: 'withdrawal', amountCents: 200_000 }),
    tx({ id: 'p', ts: NOW - 10, kind: 'deposit', amountCents: 900_000, status: 'pending' }),
  ], periodRange('today', NOW), 'XAUUSD', lots);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.amountCents), [500_000, -200_000]);
  assert.deepEqual(rows.map((x) => x.label), ['Deposit', 'Withdrawal']);
});

test('POSITIONS: only closed round trips, filtered on the CLOSE time', () => {
  // Opened outside the window, closed inside it: MetaTrader lists it, because a position is dated by
  // when it closed.
  const r = periodRange('today', NOW);
  const spanning = positionRows(
    [pos({ id: 'a', openedAt: r.fromMs - 1000, settledAt: r.fromMs + 1000, result: 'win', pnlCents: 10 })],
    [], r, 'XAUUSD', lots,
  );
  assert.equal(spanning.length, 1);
  // Still open, and void, are both absent.
  assert.equal(positionRows([pos({ id: 'b', openedAt: NOW - 10, settledAt: null, status: 'open' })], [], r, 'XAUUSD', lots).length, 0);
  assert.equal(positionRows([pos({ id: 'c', openedAt: NOW - 10, result: 'void' })], [], r, 'XAUUSD', lots).length, 0);
});

test('POSITIONS: a balance operation is MetaTrader’s Balance row, with the kind as its comment', () => {
  const r = periodRange('today', NOW);
  const rows = positionRows([], [tx({ id: 'd', ts: NOW - 10, kind: 'withdrawal', amountCents: 300 })], r, 'XAUUSD', lots);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.symbol, 'Balance');
  assert.equal(rows[0]!.label, 'Withdrawal');
  assert.equal(rows[0]!.side, null);
  assert.equal(rows[0]!.amountCents, -300);
});

test('money summary: Balance is Profit plus Deposit over the period', () => {
  const s = moneySummary([
    { kind: 'trade', amountCents: 85_617 },
    { kind: 'balance', amountCents: 10_000_000 },
    { kind: 'balance', amountCents: -2_000_000 },
    { kind: 'trade', amountCents: null }, // an in deal has no result yet
  ]);
  assert.equal(s.profitCents, 85_617);
  assert.equal(s.depositCents, 8_000_000);
  assert.equal(s.balanceCents, 8_085_617);
});

test('history strip: Deposit and Withdrawal are the two signed halves, Credit is zero', () => {
  // MetaTrader's own strip: 591.31 + 3 000.00 - 250.00 = 3 341.31 (09-toolbox.md 725).
  const s = historyStrip([
    { kind: 'trade', amountCents: 59_131 },
    { kind: 'balance', amountCents: 300_000 },
    { kind: 'balance', amountCents: -25_000 },
    { kind: 'trade', amountCents: null }, // an in deal has no result yet
  ]);
  assert.equal(s.profitCents, 59_131);
  assert.equal(s.creditCents, 0);
  assert.equal(s.depositCents, 300_000);
  assert.equal(s.withdrawalCents, -25_000);
  assert.equal(s.balanceCents, 334_131);
});

test('Change is the asset price move, so a winning sell prints a negative one', () => {
  assert.equal(changeText(priceChangePct(100, 102.18)), '2.18 %');
  // The price fell: the cell says so whichever way the trade was taken.
  assert.equal(changeText(priceChangePct(100, 99.99)), '-0.01 %');
  // Nothing to measure, and nothing invented.
  assert.equal(priceChangePct(null, 100), null);
  assert.equal(priceChangePct(100, null), null);
  assert.equal(priceChangePct(0, 100), null);
  assert.equal(changeText(null), '');
});

test('All History reaches back to the beginning and still ends tonight', () => {
  const r = periodRange('all', NOW);
  assert.equal(r.fromMs, 0);
  assert.equal(r.toMs, periodRange('today', NOW).toMs);
  // The desktop list is MetaTrader's four, in its order (09-toolbox.md 669-674).
  assert.deepEqual(DESKTOP_PERIODS.map((p) => p.label), ['All History', 'Last 3 Months', 'Last Month', 'Custom Period']);
});

test('sortRows: every key sorts both ways and never mutates the input', () => {
  const rows = [
    { symbol: 'B', ticket: '0002', atMs: 200, amountCents: -5 },
    { symbol: 'A', ticket: '0003', atMs: 300, amountCents: 10 },
    { symbol: 'C', ticket: '0001', atMs: 100, amountCents: null },
  ];
  const before = JSON.stringify(rows);
  assert.deepEqual(sortRows(rows, 'closetime', false).map((r) => r.atMs), [300, 200, 100]);
  assert.deepEqual(sortRows(rows, 'closetime', true).map((r) => r.atMs), [100, 200, 300]);
  assert.deepEqual(sortRows(rows, 'symbol', true).map((r) => r.symbol), ['A', 'B', 'C']);
  assert.deepEqual(sortRows(rows, 'ticket', true).map((r) => r.ticket), ['0001', '0002', '0003']);
  // A row with no result sorts as zero, between the loss and the win.
  assert.deepEqual(sortRows(rows, 'profit', true).map((r) => r.amountCents), [-5, null, 10]);
  assert.equal(JSON.stringify(rows), before, 'input untouched');
});

test('sortRows: tickets sort as numbers, so a digit boundary does not reorder them', () => {
  // MetaTrader's tickets are integers. Sorted as text, `1000000` lands before `999999` the moment
  // the sequence crosses a digit boundary, which is the one thing a ticket sort must not do.
  const rows = [
    { symbol: 'A', ticket: '1000000', atMs: 300 },
    { symbol: 'A', ticket: '999999', atMs: 200 },
    { symbol: 'A', ticket: '100000', atMs: 100 },
  ];
  assert.deepEqual(sortRows(rows, 'ticket', true).map((r) => r.ticket), ['100000', '999999', '1000000']);
  // A balance operation's uuid fragment is not a number, so it groups after the real tickets rather
  // than interleaving with them at whatever its first hex character happens to be.
  const mixed = [
    { symbol: 'A', ticket: '3f2a1b4c', atMs: 300 },
    { symbol: 'A', ticket: '100001', atMs: 200 },
    { symbol: 'A', ticket: '100000', atMs: 100 },
  ];
  assert.deepEqual(sortRows(mixed, 'ticket', true).map((r) => r.ticket), ['100000', '100001', '3f2a1b4c']);
});

/** History's sort is `Symbol · Ticket · Open time · Close time · Profit` (04-mobile-app.md 422). */
test('sortRows: Open time and Close time are two different orders', () => {
  const rows = [
    { symbol: 'A', ticket: '1', atMs: 500, openMs: 100, closeMs: 500 },  // opened first, closed last
    { symbol: 'A', ticket: '2', atMs: 300, openMs: 200, closeMs: 300 },
    // A cancelled order never closed, so it sorts on the one time it has.
    { symbol: 'A', ticket: '3', atMs: 400, openMs: 400, closeMs: null },
  ];
  assert.deepEqual(sortRows(rows, 'opentime', true).map((r) => r.ticket), ['1', '2', '3']);
  assert.deepEqual(sortRows(rows, 'closetime', true).map((r) => r.ticket), ['2', '3', '1']);
});

test('sortRows: ties fall back to newest-first, so the order is reproducible', () => {
  const rows = [
    { symbol: 'X', ticket: 'a', atMs: 100, amountCents: 0 },
    { symbol: 'X', ticket: 'b', atMs: 300, amountCents: 0 },
    { symbol: 'X', ticket: 'c', atMs: 200, amountCents: 0 },
  ];
  assert.deepEqual(sortRows(rows, 'symbol', true).map((r) => r.ticket), ['b', 'c', 'a']);
});

// ───────────────────────────── execution price (0180) ─────────────────────────────

test('priceText: quotes to the symbol\'s digits, and falls back when there is no price', () => {
  assert.equal(priceText(2761.5, 2), '2,761.50');
  assert.equal(priceText(2761.456, 2), '2,761.46');
  // Below the symbol's precision, a price is still a price — it is not a missing one.
  assert.equal(priceText(0, 2), '0.00');
  assert.equal(priceText(null, 2), EXECUTION_PRICE);
  assert.equal(priceText(undefined, 2), EXECUTION_PRICE);
  assert.equal(priceText(Number.NaN, 2), EXECUTION_PRICE);
  assert.equal(priceText(Number.POSITIVE_INFINITY, 2), EXECUTION_PRICE);
});

test('orderRows: carry the fill price, and a cancelled order carries none', () => {
  const r = periodRange('week', NOW);
  const [filled, canceled] = orderRows(
    [
      pos({ id: 'a', openedAt: NOW - DAY, result: 'win', entryPrice: 2761.47 }),
      pos({ id: 'b', openedAt: NOW - DAY, result: 'void', entryPrice: 2761.47 }),
    ],
    r, 'XAUUSD', lots,
  );
  assert.equal(filled!.price, 2761.47);
  // Nothing was filled, so there is no fill price to print — even though the row has one stored.
  assert.equal(canceled!.price, null);
});

test('dealRows: the `in` deal prices at entry and the `out` deal at exit', () => {
  const r = periodRange('week', NOW);
  const rows = dealRows(
    [pos({ id: 'a', openedAt: NOW - 1000, settledAt: NOW - 500, result: 'win', pnlCents: 10, entryPrice: 2761.47, exitPrice: 2765.02 })],
    [tx({ id: 't', ts: NOW - 400 })],
    r, 'XAUUSD', lots,
  );
  const inDeal = rows.find((x) => x.entry === 'in')!;
  const outDeal = rows.find((x) => x.entry === 'out')!;
  assert.equal(inDeal.price, 2761.47);
  assert.equal(outDeal.price, 2765.02);
  // A deposit has no price at all, which is not the same as an unstamped trade.
  assert.equal(rows.find((x) => x.kind === 'balance')!.price, null);
});

test('positionRows: carry the round trip\'s two prices; a balance row carries neither', () => {
  const r = periodRange('week', NOW);
  const rows = positionRows(
    [pos({ id: 'a', openedAt: NOW - 1000, settledAt: NOW - 500, result: 'win', pnlCents: 10, entryPrice: 2761.47, exitPrice: 2765.02 })],
    [tx({ id: 't', ts: NOW - 400 })],
    r, 'XAUUSD', lots,
  );
  const trade = rows.find((x) => x.kind === 'trade')!;
  assert.equal(trade.entryPrice, 2761.47);
  assert.equal(trade.exitPrice, 2765.02);
  const balance = rows.find((x) => x.kind === 'balance')!;
  assert.equal(balance.entryPrice, null);
  assert.equal(balance.exitPrice, null);
});

test('a trade from before migration 0180 reads "at market" rather than a wrong number', () => {
  const r = periodRange('week', NOW);
  // No entryPrice/exitPrice at all: the shape an older API serves, and an older row stores.
  const [row] = positionRows(
    [pos({ id: 'a', openedAt: NOW - 1000, settledAt: NOW - 500, result: 'loss', pnlCents: -10 })],
    [], r, 'XAUUSD', lots,
  );
  assert.equal(row!.entryPrice, null);
  assert.equal(priceText(row!.entryPrice, 2), EXECUTION_PRICE);
});

/**
 * A row names the instrument it was actually traded on (migration 0182).
 *
 * Every history screen used to print the one symbol the terminal quotes, because the trade record
 * did not carry its own. The parameter is now the FALLBACK for a row written before the column.
 */
test('each row reports its own symbol, falling back to the brand default', () => {
  const rows = positionRows(
    [
      pos({ id: 'a', openedAt: NOW - 1000, settledAt: NOW - 500, result: 'win', pnlCents: 10, symbol: 'EURUSD' }),
      pos({ id: 'b', openedAt: NOW - 2000, settledAt: NOW - 1500, result: 'loss', pnlCents: -10 }),
    ],
    [], { fromMs: 0, toMs: NOW + 1 }, 'XAUUSD', (c) => String(c),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get('a')?.symbol, 'EURUSD', 'a stamped row names its own instrument');
  assert.equal(byId.get('b')?.symbol, 'XAUUSD', 'an unstamped row means the brand default');
});
