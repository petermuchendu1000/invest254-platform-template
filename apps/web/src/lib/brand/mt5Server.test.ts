import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mt5BrokerToken, mt5ServerName } from './mt5Server.js';

/**
 * The shape MT5 itself prints. Every real server string matches it, so the helper's output has to:
 * one CamelCase broker token, a dash, a purpose, and (live only) two digits.
 */
const MT5_SERVER = /^[A-Za-z0-9]+-(?:Demo|Live\d{2})$/;

test('a real account gets "<Broker>-Live<NN>", a demo account gets "<Broker>-Demo"', () => {
  const brand = { name: 'MuchWins', slug: 'muchwins' };
  const live = mt5ServerName(brand, 'real');
  assert.match(live, /^MuchWins-Live\d{2}$/);
  assert.equal(mt5ServerName(brand, 'demo'), 'MuchWins-Demo');
});

test('every output matches MT5’s own server-name shape', () => {
  const brands = [
    { name: 'MuchWins', slug: 'muchwins' },
    { name: 'invest254', slug: 'invest254' },
    { name: 'Much Wins Capital (SC)', slug: 'much-wins-sc' },
    { name: '', slug: 'bare-slug-only' },
    { name: '', slug: '' },
    { name: '!!!', slug: '???' },
  ];
  for (const b of brands) {
    for (const mode of ['real', 'demo'] as const) {
      assert.match(mt5ServerName(b, mode), MT5_SERVER, JSON.stringify({ b, mode }));
    }
  }
});

test('MT5 demo servers carry no index, so neither do ours', () => {
  // MetaQuotes' own server is plain "MetaQuotes-Demo"; a "Demo07" would not look like a broker.
  assert.equal(mt5ServerName({ name: 'MetaQuotes', slug: 'metaquotes' }, 'demo'), 'MetaQuotes-Demo');
  assert.doesNotMatch(mt5ServerName({ name: 'MuchWins', slug: 'muchwins' }, 'demo'), /\d/);
});

test('the live index is zero-padded two digits and never 00', () => {
  for (let i = 0; i < 200; i++) {
    const server = mt5ServerName({ name: `Brand${i}`, slug: `brand-${i}` }, 'real');
    const index = server.slice(server.indexOf('-Live') + '-Live'.length);
    assert.equal(index.length, 2, server);
    assert.ok(Number(index) >= 1, server);
  }
});

test('the broker token never carries a space or punctuation', () => {
  assert.equal(mt5BrokerToken({ name: 'Much Wins', slug: 'much-wins' }), 'MuchWins');
  assert.equal(mt5BrokerToken({ name: 'IC Markets (SC)', slug: 'ic-markets-sc' }), 'ICMarketsSC');
  assert.equal(mt5BrokerToken({ name: "Trader's Edge & Co.", slug: 'traders-edge' }), 'TraderSEdgeCo');
});

test('a brand already written CamelCase passes through, and a lowercase one is capitalised', () => {
  assert.equal(mt5BrokerToken({ name: 'MuchWins', slug: 'muchwins' }), 'MuchWins');
  assert.equal(mt5BrokerToken({ name: 'invest254', slug: 'invest254' }), 'Invest254');
  // An all-caps broker short name is real ("FTMO-Server3"), so it must not be case-normalised.
  assert.equal(mt5BrokerToken({ name: 'FTMO', slug: 'ftmo' }), 'FTMO');
});

test('the server is stable for a brand and differs between brands', () => {
  const a = { name: 'MuchWins', slug: 'muchwins' };
  const b = { name: 'Invest254', slug: 'invest254' };
  // Stable: a trader who screenshots their server today sees the same one tomorrow.
  assert.equal(mt5ServerName(a, 'real'), mt5ServerName(a, 'real'));
  assert.notEqual(mt5ServerName(a, 'real'), mt5ServerName(b, 'real'));
});

test('the live index follows the slug, so renaming the brand does not move the account', () => {
  const before = mt5ServerName({ name: 'MuchWins', slug: 'muchwins' }, 'real');
  const after = mt5ServerName({ name: 'MuchWins Global', slug: 'muchwins' }, 'real');
  assert.equal(before.slice(before.indexOf('-')), after.slice(after.indexOf('-')));
});

test('a brand with no name or slug still names a server (the app always renders)', () => {
  assert.equal(mt5ServerName({}, 'demo'), 'Invest254-Demo');
  assert.equal(mt5BrokerToken({ name: null, slug: null }), 'Invest254');
});

test('a sentence-long brand name is abbreviated the way broker tokens are short', () => {
  const token = mt5BrokerToken({ name: 'Supreme Synthetic Indices Trading Capital Limited', slug: 'ssitc' });
  assert.ok(token.length <= 20, token);
  assert.match(token, /^[A-Za-z0-9]+$/);
});
