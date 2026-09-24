import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceState, parseKes, bpToPct, validPhone, subState, limitText, localPhone } from './labels';

const NOW = Date.UTC(2026, 8, 24, 9, 0, 0);
const at = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

test('BILL-1: invoice states read as plain words with the right urgency', () => {
  assert.deepEqual(invoiceState({ status: 'paid', dueAt: at(-3) }, NOW), { label: 'Paid', tone: 'up' });
  assert.deepEqual(invoiceState({ status: 'open', dueAt: at(7) }, NOW), { label: 'Due in 7 days', tone: 'info' });
  assert.deepEqual(invoiceState({ status: 'open', dueAt: at(2) }, NOW), { label: 'Due in 2 days', tone: 'warn' });
  assert.deepEqual(invoiceState({ status: 'open', dueAt: at(0.2) }, NOW), { label: 'Due today', tone: 'warn' });
  assert.deepEqual(invoiceState({ status: 'open', dueAt: at(-1) }, NOW), { label: 'Overdue 1 day', tone: 'down' });
  assert.deepEqual(invoiceState({ status: 'open', dueAt: at(-9), amountPaidCents: 100 }, NOW), { label: 'Part paid · Overdue 9 days', tone: 'down' });
  assert.equal(invoiceState({ status: 'uncollectible', dueAt: at(-9) }, NOW).label, 'Written off');
  assert.equal(invoiceState({ status: 'void', dueAt: at(-9) }, NOW).tone, 'muted');
});

test('BILL-1: amounts, tax and phone input', () => {
  assert.equal(parseKes('40,000'), 4000000);
  assert.equal(parseKes('KES 1,000.50'), 100050);
  assert.equal(parseKes('-500'), -50000);
  assert.equal(parseKes('12abc'), null);
  assert.equal(parseKes(''), null);
  assert.equal(bpToPct(1600), '16%');
  assert.equal(bpToPct(1650), '16.5%');
  assert.ok(validPhone('0712 345 678')); assert.ok(validPhone('+254112345678')); assert.ok(!validPhone('0812345678'));
  assert.equal(subState('grace_period').label, 'Final notice');
  assert.equal(subState('weird').label, 'weird');
  assert.equal(limitText(null, 'brands'), 'Unlimited brands');
  assert.equal(limitText(1000, 'players'), '1,000 players');
});

test('BILL-1: the reference shown on the invoice matches what the STK push sends', async () => {
  const { mpesaRefFor } = await import('./ref');
  const { mpesaAccountRef } = await import('../../../../engine/src/billing');
  for (const n of ['TRIO-2026-00012', 'ABCDEFGH-2027-12345', 'INV-2026-00001']) assert.equal(mpesaRefFor(n), mpesaAccountRef(n));
});

test('BILL-1: the payer\'s stored phone pre-fills in the local form whatever way it was saved', () => {
  for (const v of ['254712345678', '+254712345678', '0712345678', '712345678']) assert.equal(localPhone(v), '0712345678');
  assert.equal(localPhone('254112345678'), '0112345678');
  assert.equal(localPhone(null), ''); assert.equal(localPhone('12345'), '');
});
