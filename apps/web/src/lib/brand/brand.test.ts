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

test('brandCssVars: 3 legacy vars without themeTokens; full contract with them', () => {
  // A brand with no themeTokens exposes only the three legacy custom properties.
  const legacy = brandCssVars({ ...DEFAULT_BRAND, themeTokens: null });
  assert.deepEqual(legacy, {
    '--brand-primary': DEFAULT_BRAND.colorPrimary,
    '--brand-bg': DEFAULT_BRAND.colorBg,
    '--brand-accent': DEFAULT_BRAND.colorAccent,
  });
  // DEFAULT_BRAND carries a full palette -> the complete --brand-* contract is emitted.
  const t = DEFAULT_BRAND.themeTokens!;
  const vars = brandCssVars(DEFAULT_BRAND);
  assert.equal(vars['--brand-bg'], t.bg);
  assert.equal(vars['--brand-surface'], t.surface);
  assert.equal(vars['--brand-surface-2'], t.surface2);
  assert.equal(vars['--brand-border'], t.border);
  assert.equal(vars['--brand-fg'], t.fg);
  assert.equal(vars['--brand-muted'], t.muted);
  assert.equal(vars['--brand-primary'], t.brand);
  assert.equal(vars['--brand-accent'], t.accent);
  assert.equal(vars['--brand-up'], t.up);
  assert.equal(vars['--brand-down'], t.down);
  assert.equal(vars['--brand-warn'], t.warn);
  assert.equal(vars['--brand-info'], t.info);
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
  const origWarn = console.warn;
  console.warn = (() => { /* silence expected fallback warnings */ }) as typeof console.warn;
  try {
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) } as Response)) as typeof fetch;
    assert.deepEqual(await resolveBrand('https://api', 'x'), DEFAULT_BRAND);

    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.deepEqual(await resolveBrand('https://api', 'x'), DEFAULT_BRAND);
  } finally { globalThis.fetch = orig; console.warn = origWarn; }
});

test('resolveBrand flags resolved and warns loudly on a fallback (GAP 5 visibility)', async () => {
  const origFetch = globalThis.fetch;
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = ((...a: unknown[]) => { warnings.push(a.map(String).join(' ')); }) as typeof console.warn;
  try {
    // success → resolved:true, no warning
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ siteId: 'S', slug: 'brandb', name: 'Brand B' }) } as Response)) as typeof fetch;
    const ok = await resolveBrand('https://api', 'brandb.example');
    assert.equal(ok.resolved, true);
    assert.equal(warnings.length, 0, 'no warning on a clean resolve');

    // 404 (host has no active brand) → resolved:false, still renders fallback, warns with host+status
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch;
    const miss = await resolveBrand('https://api', 'tamutraders.com');
    assert.equal(miss.resolved, false);
    assert.equal(miss.slug, DEFAULT_BRAND.slug, 'still renders the fallback brand (resilience)');
    assert.ok(warnings.some((w) => w.includes('tamutraders.com') && w.includes('404')), 'warns with host + status');

    // network error → resolved:false, warns with host + reason
    warnings.length = 0;
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    const errd = await resolveBrand('https://api', 'brandb.example');
    assert.equal(errd.resolved, false);
    assert.ok(warnings.some((w) => w.includes('brandb.example') && w.toLowerCase().includes('offline')), 'warns on network error');
  } finally { globalThis.fetch = origFetch; console.warn = origWarn; }
});
