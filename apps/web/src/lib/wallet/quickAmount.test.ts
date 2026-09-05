import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickAmountEntry } from './quickAmount.js';
import { displayToKesCents, kesToCents } from '@invest254/shared/money';

// Re-derive the KES-cents value the withdraw form would compute from the returned entry string,
// exactly mirroring WithdrawForm's `amountCents` logic for each brand type.
function reparseCents(entry: string, isForeign: boolean, rate: number): number {
  if (entry === '') return 0;
  return isForeign ? displayToKesCents(Number(entry), rate) : kesToCents(Number(entry));
}

// ── KES brands: whole-shilling entry ────────────────────────────────────────────────────────
test('KES: MAX floors sub-shilling cents (KES 47,718.33 -> "47718")', () => {
  const entry = quickAmountEntry(4771833, { isForeign: false, fxRateFromKes: 1 });
  assert.equal(entry, '47718');
  assert.ok(reparseCents(entry, false, 1) <= 4771833);
});

test('KES: round balances pass through exactly', () => {
  assert.equal(quickAmountEntry(20000, { isForeign: false, fxRateFromKes: 1 }), '200');
  assert.equal(quickAmountEntry(5000, { isForeign: false, fxRateFromKes: 1 }), '50');
});

test('KES: sub-shilling / zero / negative targets yield empty string', () => {
  assert.equal(quickAmountEntry(50, { isForeign: false, fxRateFromKes: 1 }), '');
  assert.equal(quickAmountEntry(0, { isForeign: false, fxRateFromKes: 1 }), '');
  assert.equal(quickAmountEntry(-100, { isForeign: false, fxRateFromKes: 1 }), '');
  assert.equal(quickAmountEntry(Number.NaN, { isForeign: false, fxRateFromKes: 1 }), '');
});

// ── Foreign brands: display-currency entry (<=2dp), never exceeding the KES target ────────────
test('foreign: MAX for $368.80 balance never exceeds and stays <=2dp', () => {
  // KES 47,718.33 balance at a USD rate that renders it as $368.80.
  const target = 4771833;
  const rate = 368.8 / 47718.33; // USD per KES
  const entry = quickAmountEntry(target, { isForeign: true, fxRateFromKes: rate });
  assert.notEqual(entry, '');
  assert.ok(/^\d+(\.\d{1,2})?$/.test(entry), `entry ${entry} must be <=2dp`);
  assert.ok(reparseCents(entry, true, rate) <= target, 'MAX must never exceed balance');
});

// ── Invariant fuzz: SAFETY (never exceed) + near-maximality across brands and rates ───────────
test('fuzz: chip amount never exceeds target and is near-maximal', () => {
  let seed = 123456789;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  for (let i = 0; i < 20000; i++) {
    const isForeign = rand() < 0.5;
    // Rates spanning tiny (USD/NGN per KES) to large (>1) display currencies.
    const rate = isForeign ? 0.0005 + rand() * 2 : 1;
    const target = Math.floor(rand() * 12_000_000); // 0 .. KES 120,000.00 in cents

    // The four chip fractions the UI offers.
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      const t = frac >= 1 ? target : Math.floor(target * frac);
      const entry = quickAmountEntry(t, { isForeign, fxRateFromKes: rate });
      const cents = reparseCents(entry, isForeign, rate);

      // CRITICAL safety invariant: the chip can never produce more than the target.
      assert.ok(cents <= t, `exceeded: target=${t} entry=${entry} cents=${cents} rate=${rate} foreign=${isForeign}`);
      assert.ok(cents >= 0);

      if (entry !== '') {
        if (!isForeign) {
          // Whole shillings: at most one shilling (100 cents) left on the table.
          assert.ok(t - cents < 100, `KES leftover too big: target=${t} cents=${cents}`);
          assert.ok(Number.isInteger(Number(entry)));
        } else {
          // <=2dp, and near-maximal: no more than ~2 display-cents of KES left unclaimed.
          assert.ok(/^\d+(\.\d{1,2})?$/.test(entry), `not <=2dp: ${entry}`);
          const oneDisplayCentInKes = displayToKesCents(0.01, rate);
          assert.ok(t - cents <= 2 * oneDisplayCentInKes + 2, `foreign leftover too big: target=${t} cents=${cents} slack=${oneDisplayCentInKes}`);
        }
      } else {
        // Empty only when the target genuinely floors to nothing in the entry unit.
        if (!isForeign) assert.ok(t < 100);
      }
    }
  }
});
