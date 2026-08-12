import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BRAND,
  brandCssVars,
  brandRootStyle,
  brandWordmark,
  wsUrlForSite,
  resolveBrand,
  type Brand,
} from './brand.js';

test('wsUrlForSite appends ?site, respects existing query, and no-ops on empty', () => {
  assert.equal(wsUrlForSite('ws://h:8080', 'S1'), 'ws://h:8080?site=S1');
  assert.equal(wsUrlForSite('ws://h:8080/live?x=1', 'S1'), 'ws://h:8080/live?x=1&site=S1');
  assert.equal(wsUrlForSite('ws://h:8080', ''), 'ws://h:8080');
  assert.equal(wsUrlForSite('ws://h:8080', null), 'ws://h:8080');
  // site ids are URL-encoded
  assert.equal(wsUrlForSite('ws://h', 'a b'), 'ws://h?site=a%20b');
});

test('brandCssVars / brandRootStyle expose the three brand custom properties', () => {
  const vars = brandCssVars(DEFAULT_BRAND);
  assert.deepEqual(vars, {
    '--brand-primary': DEFAULT_BRAND.colorPrimary,
    '--brand-bg': DEFAULT_BRAND.colorBg,
    '--brand-accent': DEFAULT_BRAND.colorAccent,
  });
  assert.deepEqual(brandRootStyle(DEFAULT_BRAND), vars);
});

test('brandWordmark prefers wordmarkText, falls back to name', () => {
  assert.equal(brandWordmark({ ...DEFAULT_BRAND, wordmarkText: 'invest254.com', name: 'Invest254' }), 'invest254.com');
  assert.equal(brandWordmark({ ...DEFAULT_BRAND, wordmarkText: '   ', name: 'Brand B' }), 'Brand B');
  assert.equal(brandWordmark({ ...DEFAULT_BRAND, wordmarkText: null, name: 'Brand B' }), 'Brand B');
});

test('resolveBrand merges the API brand over defaults, keying by host', async () => {
  const orig = globalThis.fetch;
  const calls: string[] = [];
  const apiBrand: Partial<Brand> = {
    siteId: '22222222-2222-2222-2222-222222222222', slug: 'brandb', name: 'Brand B',
    colorPrimary: '#f97316', colorAccent: '#a855f7', theme: 'light', supportEmail: 's@brandb.example',
  };
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, json: async () => apiBrand } as Response;
  }) as typeof fetch;
  try {
    const b = await resolveBrand('https://api.example/api/v1', 'brandb.example');
    assert.ok((calls[0] ?? '').includes('/site/brand?host=brandb.example'), `host queried: ${calls[0]}`);
    assert.equal(b.slug, 'brandb');
    assert.equal(b.colorPrimary, '#f97316');
    assert.equal(b.theme, 'light');
    // fields the API omitted fall back to the default brand
    assert.equal(b.currency, DEFAULT_BRAND.currency);
    assert.equal(b.locale, DEFAULT_BRAND.locale);
  } finally { globalThis.fetch = orig; }
});

test('resolveBrand falls back to DEFAULT_BRAND on a non-ok response or a network error', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) } as Response)) as typeof fetch;
    assert.deepEqual(await resolveBrand('https://api', 'x'), DEFAULT_BRAND);

    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.deepEqual(await resolveBrand('https://api', 'x'), DEFAULT_BRAND);
  } finally { globalThis.fetch = orig; }
});
