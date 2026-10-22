import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  legalSections, legalTitle, registerOf, riskAnchor, type LegalBrand, type LegalSection,
} from './legalPage.js';

/**
 * The page's claims are that it speaks to the right audience, that it speaks about the RIGHT BRAND,
 * and that it contains no placeholder. All three were broken before this module existed: the prose
 * was hard-coded to one brand on a deployment that serves many, and it printed a licence number of
 * "to be confirmed".
 */

const BRAND: LegalBrand = {
  name: 'MuchWins',
  licenceLine: 'MuchWins is operated under licence BCLB/PLB/0000/2026.',
  supportEmail: 'help@muchwins.co.ke',
  currency: 'KES',
};

const textOf = (sections: readonly LegalSection[]): string =>
  sections.flatMap((s) => [s.title, ...s.blocks.flatMap((b) => {
    switch (b.kind) {
      case 'ul': return [...b.items];
      case 'contact': return [b.before, b.email, b.after];
      case 'helpline': return [b.before, b.label, b.after];
      default: return [b.text];
    }
  })]).join(' ');

test('the shell decides the register: a terminal brand is a broker', () => {
  assert.equal(registerOf(true), 'trading');
  assert.equal(registerOf(false), 'gaming');
  assert.equal(riskAnchor('trading'), 'risk');
  assert.equal(riskAnchor('gaming'), 'responsible-gaming');
  assert.notEqual(legalTitle('trading').title, legalTitle('gaming').title);
});

test('both registers carry the same four sections, under their own ids', () => {
  for (const reg of ['trading', 'gaming'] as const) {
    const ids = legalSections(reg, BRAND).map((s) => s.id);
    assert.equal(ids.length, 4, reg);
    assert.deepEqual(ids.slice(1), ['terms', 'privacy', 'licence'], reg);
    assert.equal(ids[0], riskAnchor(reg), reg);
  }
});

test('a broker does not speak to a gambler, and a gaming operator does not hide that it is one', () => {
  const trading = textOf(legalSections('trading', BRAND));
  // No gambling vocabulary on a broker's page: it is not what the reader is doing, and a page that
  // calls a trader a player is the tell that it was written for another product.
  for (const word of [/\bplay\b/i, /\bplayer/i, /\bstake\b/i, /\bbet\b/i, /\bgaming\b/i, /entertainment/i]) {
    assert.ok(!word.test(trading), `the trading register avoids ${word}`);
  }
  // And it says the things a broker must: the spread is the cost, the stop is server-side.
  assert.ok(/spread is the only cost/i.test(trading));
  assert.ok(/held on our server/i.test(trading));
  assert.ok(/Fill or Kill/.test(trading));

  const gaming = textOf(legalSections('gaming', BRAND));
  assert.ok(/responsible/i.test(gaming) || /Responsible Gaming/.test(gaming));
  assert.ok(/18/.test(gaming), 'the age gate is stated');
  // The statutory helpline belongs to the gaming register and only to it.
  assert.ok(/1190/.test(gaming));
  assert.ok(!/1190/.test(trading), 'a gambling helpline is not printed on a broker page');
});

test("the page is about THIS brand, which is the fault that made it data", () => {
  for (const reg of ['trading', 'gaming'] as const) {
    const t = textOf(legalSections(reg, BRAND));
    assert.ok(t.includes('MuchWins'), reg);
    assert.ok(t.includes('help@muchwins.co.ke'), reg);
    assert.ok(!/invest254/i.test(t), `${reg} does not name another brand`);
    // The deposit currency is the brand's, not a hard-coded KES on a USD account.
    const usd = textOf(legalSections(reg, { ...BRAND, currency: 'USD' }));
    assert.ok(usd.includes('USD'), reg);
  }
});

test('there is no placeholder where a fact belongs', () => {
  for (const reg of ['trading', 'gaming'] as const) {
    const withLicence = textOf(legalSections(reg, BRAND));
    assert.ok(withLicence.includes('BCLB/PLB/0000/2026'), `${reg} prints the brand's own licence line`);
    assert.ok(!/to be confirmed/i.test(withLicence), reg);
    // A brand that publishes none says so, rather than promising a number later.
    const without = textOf(legalSections(reg, { ...BRAND, licenceLine: null }));
    assert.ok(/publishes no licence details/i.test(without), reg);
    assert.ok(!/to be confirmed/i.test(without), reg);
  }
});

test('a brand with no support address gets no link, rather than another brand s inbox', () => {
  for (const reg of ['trading', 'gaming'] as const) {
    const sections = legalSections(reg, { ...BRAND, supportEmail: null });
    const contacts = sections.flatMap((s) => s.blocks).filter((b) => b.kind === 'contact');
    assert.equal(contacts.length, 0, reg);
    // The reader is still told where to go.
    assert.ok(/support channel on your account page/i.test(textOf(sections)), reg);
  }
});
