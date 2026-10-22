import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyPage, type CompanyBrand } from './company.js';

/**
 * The Company tab's one behavioural claim is MetaTrader's: it is drawn when the broker publishes a
 * page and hidden when it does not. That is `published`, and it is the only thing in the Toolbox
 * that can make a tab disappear, so it is pinned.
 */

const BRAND: CompanyBrand = {
  name: 'Invest254',
  wordmarkText: 'invest254.com',
  licenceLine: 'Operated under licence.',
  supportEmail: 'help@invest254.com',
  supportWhatsapp: '+254 711 000 000',
  currency: 'KES',
  locale: 'en-KE',
};

test('a brand that publishes a licence or a support channel has a company page', () => {
  assert.equal(companyPage(BRAND).published, true);
  // Either one alone is enough: a broker with a support number and no licence line still has a page.
  assert.equal(companyPage({ ...BRAND, licenceLine: null }).published, true);
  assert.equal(companyPage({ ...BRAND, supportEmail: null, supportWhatsapp: null }).published, true);
});

test('a brand that publishes nothing has no company page, so MetaTrader hides the tab', () => {
  const bare: CompanyBrand = { name: 'Bare', currency: 'KES', locale: 'en-KE' };
  assert.equal(companyPage(bare).published, false);
  // A name is not a page. Every brand has a name, and a tab carrying only the name is the empty tab
  // MetaTrader hides.
  assert.equal(companyPage({ ...bare, licenceLine: '   ' }).published, false, 'whitespace is not a licence line');
  assert.equal(companyPage({ ...bare, supportEmail: '' }).published, false, 'an empty email is not a channel');
});

test('the title is the brand wordmark, falling back to its trading name', () => {
  assert.equal(companyPage(BRAND).title, 'invest254.com');
  assert.equal(companyPage({ ...BRAND, wordmarkText: null }).title, 'Invest254');
  assert.equal(companyPage({ ...BRAND, wordmarkText: '  ' }).title, 'Invest254');
  // The trading name is still stated in the fields even when the wordmark is the heading.
  assert.ok(companyPage(BRAND).fields.some((f) => f.label === 'Trading name' && f.value === 'Invest254'));
});

test('a WhatsApp link is built from digits, because wa.me accepts nothing else', () => {
  const wa = companyPage(BRAND).support.find((l) => l.href.includes('wa.me'));
  assert.ok(wa, 'the channel is listed');
  assert.equal(wa.href, 'https://wa.me/254711000000', 'no plus, no spaces');
  assert.equal(wa.label, '+254711000000', 'but the display keeps the plus');
});

test('the trade server is carried when the account has one, and never invented', () => {
  // The same string the account strip and the Funds screen print, so the three cannot disagree.
  const withServer = companyPage(BRAND, { server: 'MuchWins-Live09' });
  assert.ok(withServer.fields.some((f) => f.label === 'Trade server' && f.value === 'MuchWins-Live09'));
  // Without one the row is absent rather than blank or guessed at.
  assert.ok(!companyPage(BRAND).fields.some((f) => f.label === 'Trade server'));
  assert.ok(!companyPage(BRAND, { server: null }).fields.some((f) => f.label === 'Trade server'));
  // It sits directly under the trading name, where MetaTrader puts the server on an account.
  const labels = withServer.fields.map((f) => f.label);
  assert.equal(labels[1], 'Trade server');
});

test('the page carries the brand own figures, not a fixed set', () => {
  const other = companyPage({ ...BRAND, name: 'Brand B', currency: 'USD', locale: 'en-US' });
  assert.ok(other.fields.some((f) => f.label === 'Deposit currency' && f.value === 'USD'));
  assert.ok(other.fields.some((f) => f.label === 'Region' && f.value === 'en-US'));
  // Server time is the one server fact this platform publishes, and every grid stamps it.
  assert.ok(other.fields.some((f) => f.label === 'Server time' && f.value === 'UTC'));
});

test('every published page links to real routes in this deployment', () => {
  const page = companyPage(BRAND);
  assert.deepEqual(page.resources.map((l) => l.href), [
    // The last anchor is the TRADING register's. A terminal brand publishes a risk disclosure, and
    // `riskAnchor` is what decides the id, so this cannot drift from the page that serves it.
    '/legal#terms', '/legal#privacy', '/legal#licence', '/legal#risk',
  ]);
  // Each one says what the trader gets, rather than leaving a bare link to be guessed at.
  for (const l of [...page.resources, ...page.support]) {
    assert.ok(l.note.length > 20, l.label);
  }
});

test('a support email becomes a mailto, which is what opens in a separate window', () => {
  const email = companyPage(BRAND).support.find((l) => l.href.startsWith('mailto:'));
  assert.ok(email);
  assert.equal(email.href, 'mailto:help@invest254.com');
  // With no email there is no mailto row at all, rather than a dead link.
  assert.equal(
    companyPage({ ...BRAND, supportEmail: null }).support.some((l) => l.href.startsWith('mailto:')),
    false,
  );
});
