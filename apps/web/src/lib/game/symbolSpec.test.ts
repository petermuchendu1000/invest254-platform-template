import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specRows, SPEC_GLYPH, SPEC_SESSION_DAYS, SPEC_SESSION_SPAN } from './symbolSpec.js';

const base = {
  symbol: 'XAUUSD',
  description: 'Gold vs US Dollar',
  digits: 2,
  contractSize: 'KES 10,000.00',
  currency: 'KES',
  minVolume: 0.025,
  maxVolume: 1,
  volumeStep: 0.01,
  expiries: ['10s', '30s', '1m', '2m'],
  volumeDigits: 3,
};

test("the rows are MetaTrader's, in the order its own dialog renders them", () => {
  const labels = specRows(base).map((r) => r.label);
  assert.deepEqual(labels, [
    'Digits', 'Contract size', 'Spread', 'Margin currency', 'Profit currency', 'Chart mode',
    'Trade', 'Execution', 'Filling', 'Expiration', 'Orders',
    'Minimal volume', 'Maximal volume', 'Volume step',
  ]);
});

test("the spread row is the brand's own figure, in the symbol's points", () => {
  // MetaTrader prints "floating" where a spread moves and the figure where it is fixed. This
  // brand's is fixed: the settlement engine charges the same cost on every tick.
  const spread = specRows({ ...base, spreadPoints: 58 }).find((r) => r.label === 'Spread');
  assert.equal(spread?.value, '58');
  assert.equal(spread?.kind, 'integer');
  // A brand that publishes none reads 0, which is then true rather than a placeholder.
  assert.equal(specRows(base).find((r) => r.label === 'Spread')?.value, '0');
  assert.equal(specRows({ ...base, spreadPoints: null }).find((r) => r.label === 'Spread')?.value, '0');
});

test('the rows that have no meaning here are absent, not blank', () => {
  // MetaQuotes: "which fields appear depends on instrument type and broker". Omitting is its own
  // behaviour, so a contract that expires in seconds shows no overnight financing.
  const labels = specRows(base).map((r) => r.label);
  for (const absent of [
    'Swap type', 'Swap long', 'Swap short', 'Swap rates',
    'Exchange', 'Sector', 'CFI', 'Industry', 'Country', 'ISIN',
    'Calculation', 'Stops level', 'Tick value',
    'Option type', 'Underlying', 'Strike price', 'Face value', 'Accrued interest',
  ]) {
    assert.ok(!labels.includes(absent), absent);
  }
  // And nothing that IS shown is empty.
  for (const r of specRows(base)) assert.ok(r.value.length > 0, r.label);
});

test('the currency is both the margin and the profit currency, because there is one', () => {
  const rows = specRows({ ...base, currency: 'USD' });
  assert.equal(rows.find((r) => r.label === 'Margin currency')?.value, 'USD');
  assert.equal(rows.find((r) => r.label === 'Profit currency')?.value, 'USD');
});

test('the volume rows carry the ticket s own limits', () => {
  const rows = specRows(base);
  assert.equal(rows.find((r) => r.label === 'Minimal volume')?.value, '0.025');
  assert.equal(rows.find((r) => r.label === 'Maximal volume')?.value, '1.000');
  assert.equal(rows.find((r) => r.label === 'Volume step')?.value, '0.010');
});

test('an unbounded maximum drops the row rather than printing an invented ceiling', () => {
  const labels = specRows({ ...base, maxVolume: null }).map((r) => r.label);
  assert.ok(!labels.includes('Maximal volume'));
  assert.ok(labels.includes('Minimal volume'));
  assert.ok(labels.includes('Volume step'));
});

test('Expiration lists the timers the ticket actually offers', () => {
  // None of MetaTrader's four values (Good till Canceled, Intraday, Specified time, Date) describes
  // a contract that expires on a timer the trader picks, so the timers themselves are the value.
  assert.equal(specRows(base).find((r) => r.label === 'Expiration')?.value, '10s, 30s, 1m, 2m');
  // With none offered it falls back to the nearest MetaTrader value rather than printing nothing.
  assert.equal(specRows({ ...base, expiries: [] }).find((r) => r.label === 'Expiration')?.value, 'Specified time');
});

test('Chart mode says last price, because there is no bid to follow', () => {
  assert.equal(specRows(base).find((r) => r.label === 'Chart mode')?.value, 'By last price');
});

test('Orders claims market only, because there are no pending orders here', () => {
  assert.equal(specRows(base).find((r) => r.label === 'Orders')?.value, 'Market');
});

test("every row carries one of MetaTrader's type glyphs", () => {
  for (const r of specRows(base)) {
    assert.ok(SPEC_GLYPH[r.kind] !== undefined, `${r.label} ${r.kind}`);
  }
  assert.equal(SPEC_GLYPH.string, 'ab');
  assert.equal(SPEC_GLYPH.integer, '01');
});

test('the Sessions block covers every day, because this market never closes', () => {
  assert.equal(SPEC_SESSION_DAYS.length, 7);
  assert.equal(SPEC_SESSION_DAYS[0], 'Sunday');
  assert.equal(SPEC_SESSION_SPAN, '00:00-24:00');
});

test('the Trade row carries MetaTrader’s own mode, and defaults to full access', () => {
  // A broker marks a symbol Disabled when it quotes it but will not accept an order on it, which is
  // exactly the state of every symbol this brand does not settle. Printing "Full access" there
  // would be the Specification lying about the one row a trader checks before placing an order.
  const full = specRows(base).find((r) => r.label === 'Trade');
  assert.equal(full?.value, 'Full access');
  assert.equal(full?.kind, 'enum');
  const off = specRows({ ...base, tradeMode: 'Disabled' as const }).find((r) => r.label === 'Trade');
  assert.equal(off?.value, 'Disabled');
  // The row stays in MetaTrader's own position, after Chart mode and before Execution.
  const labels = specRows({ ...base, tradeMode: 'Disabled' as const }).map((r) => r.label);
  assert.equal(labels[labels.indexOf('Trade') - 1], 'Chart mode');
  assert.equal(labels[labels.indexOf('Trade') + 1], 'Execution');
});
