import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMP_BRAND_KEY,
  IMP_RETURN_TOKEN_KEY,
  parseImpersonatedBrand,
  readImpersonatedBrand,
  isImpersonatingIn,
  isValidImpersonateResult,
  beginImpersonationIn,
  endImpersonationIn,
  clearImpersonationIn,
  type StorageLike,
  type ImpersonatedBrand,
} from './impersonate.core';

/** Minimal in-memory Storage fake (mirrors the sessionStorage surface the code uses). */
function fakeStore(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const BRAND_A: ImpersonatedBrand = { siteId: 'site-A', slug: 'invest254', name: 'Invest254', primaryDomain: 'invest254.com' };
const BRAND_B: ImpersonatedBrand = { siteId: 'site-B', slug: '66investors', name: '66 Investors', primaryDomain: '66investors.com' };
const BRAND_C: ImpersonatedBrand = { siteId: 'site-C', slug: 'madolar', name: 'Madolar', primaryDomain: null };

// ── parse / validation ─────────────────────────────────────────────────────────────────────────
test('parseImpersonatedBrand accepts a well-formed blob (primaryDomain null allowed)', () => {
  assert.deepEqual(parseImpersonatedBrand(JSON.stringify(BRAND_C)), BRAND_C);
});

test('parseImpersonatedBrand rejects null, non-JSON, non-object, and missing required fields', () => {
  assert.equal(parseImpersonatedBrand(null), null);
  assert.equal(parseImpersonatedBrand(''), null);
  assert.equal(parseImpersonatedBrand('not json'), null);
  assert.equal(parseImpersonatedBrand('123'), null);
  assert.equal(parseImpersonatedBrand('"str"'), null);
  assert.equal(parseImpersonatedBrand(JSON.stringify({ slug: 'x', name: 'y' })), null);          // no siteId
  assert.equal(parseImpersonatedBrand(JSON.stringify({ siteId: 's', name: 'y' })), null);         // no slug
  assert.equal(parseImpersonatedBrand(JSON.stringify({ siteId: 's', slug: 'x' })), null);         // no name
  assert.equal(parseImpersonatedBrand(JSON.stringify({ siteId: '', slug: 'x', name: 'y' })), null); // empty siteId
});

test('isValidImpersonateResult requires a non-empty token AND a valid brand', () => {
  assert.equal(isValidImpersonateResult({ token: 't', brand: BRAND_A }), true);
  assert.equal(isValidImpersonateResult({ token: '', brand: BRAND_A }), false);
  assert.equal(isValidImpersonateResult({ token: 't', brand: { siteId: 's' } }), false);
  assert.equal(isValidImpersonateResult({ brand: BRAND_A }), false);
  assert.equal(isValidImpersonateResult(null), false);
  assert.equal(isValidImpersonateResult('nope'), false);
});

// ── begin / read / end round-trip ────────────────────────────────────────────────────────────────
test('begin stashes the return token + brand and activates the brand token', () => {
  const s = fakeStore();
  const active = beginImpersonationIn(s, { token: 'brandB-token', brand: BRAND_B }, 'platform-token');
  assert.equal(active, 'brandB-token');
  assert.equal(s.map.get(IMP_RETURN_TOKEN_KEY), 'platform-token');
  assert.deepEqual(readImpersonatedBrand(s), BRAND_B);
  assert.equal(isImpersonatingIn(s), true);
});

test('end restores the stashed platform token and clears BOTH keys', () => {
  const s = fakeStore();
  beginImpersonationIn(s, { token: 'brandB-token', brand: BRAND_B }, 'platform-token');
  const restored = endImpersonationIn(s);
  assert.equal(restored, 'platform-token');
  assert.equal(isImpersonatingIn(s), false);
  assert.equal(s.map.has(IMP_RETURN_TOKEN_KEY), false);
  assert.equal(s.map.has(IMP_BRAND_KEY), false);
});

test('end with nothing stashed returns null (caller resets the session)', () => {
  const s = fakeStore();
  assert.equal(endImpersonationIn(s), null);
});

// ── DIFFERENT BRANDS: switching + isolation ──────────────────────────────────────────────────────
test('re-impersonating a different brand overwrites the fence to the new brand', () => {
  const s = fakeStore();
  beginImpersonationIn(s, { token: 'tA', brand: BRAND_A }, 'platform-token');
  assert.equal(readImpersonatedBrand(s)!.slug, 'invest254');
  // Switch straight to a second brand (return-token stash follows the then-active token).
  beginImpersonationIn(s, { token: 'tB', brand: BRAND_B }, 'tA');
  assert.equal(readImpersonatedBrand(s)!.slug, '66investors');
  assert.equal(s.map.get(IMP_RETURN_TOKEN_KEY), 'tA');
  // And a third.
  beginImpersonationIn(s, { token: 'tC', brand: BRAND_C }, 'tB');
  assert.deepEqual(readImpersonatedBrand(s), BRAND_C);
});

test('each brand round-trips independently (A then B then C), always fail-closing on exit', () => {
  for (const b of [BRAND_A, BRAND_B, BRAND_C]) {
    const s = fakeStore();
    const active = beginImpersonationIn(s, { token: `tok-${b.slug}`, brand: b }, 'platform');
    assert.equal(active, `tok-${b.slug}`);
    assert.deepEqual(readImpersonatedBrand(s), b);
    assert.equal(endImpersonationIn(s), 'platform');
    assert.equal(isImpersonatingIn(s), false);
  }
});

// ── clear (logout / 401) ───────────────────────────────────────────────────────────────────────
test('clearImpersonationIn drops every artifact and is idempotent', () => {
  const s = fakeStore();
  beginImpersonationIn(s, { token: 'tB', brand: BRAND_B }, 'platform-token');
  clearImpersonationIn(s);
  assert.equal(isImpersonatingIn(s), false);
  assert.equal(s.map.has(IMP_RETURN_TOKEN_KEY), false);
  assert.equal(s.map.has(IMP_BRAND_KEY), false);
  clearImpersonationIn(s);                 // idempotent — no throw, still clear
  assert.equal(isImpersonatingIn(s), false);
});

// ── fail-closed behaviours ───────────────────────────────────────────────────────────────────────
test('begin throws on a malformed result and never writes storage', () => {
  const s = fakeStore();
  assert.throws(() => beginImpersonationIn(s, { token: '', brand: BRAND_A } as any, 'p'), /INVALID_IMPERSONATION/);
  assert.throws(() => beginImpersonationIn(s, { token: 't', brand: { siteId: 's' } } as any, 'p'), /INVALID_IMPERSONATION/);
  assert.equal(s.map.size, 0, 'no partial write on an invalid result');
});

test('a corrupt brand blob in storage reads as "not impersonating" (fail-closed)', () => {
  const s = fakeStore();
  s.map.set(IMP_BRAND_KEY, '{ this is not json');
  assert.equal(isImpersonatingIn(s), false);
  assert.equal(readImpersonatedBrand(s), null);
});

test('null storage (SSR / disabled) degrades safely to "not impersonating"', () => {
  assert.equal(isImpersonatingIn(null), false);
  assert.equal(readImpersonatedBrand(null), null);
  assert.equal(endImpersonationIn(null), null);
  // begin still returns the active token even when storage is unavailable (swap proceeds).
  assert.equal(beginImpersonationIn(null, { token: 'tok', brand: BRAND_A }, 'p'), 'tok');
  clearImpersonationIn(null); // no throw
});

test('begin with no current platform token clears any stale return token', () => {
  const s = fakeStore();
  s.map.set(IMP_RETURN_TOKEN_KEY, 'STALE');
  beginImpersonationIn(s, { token: 'tB', brand: BRAND_B }, null);
  assert.equal(s.map.has(IMP_RETURN_TOKEN_KEY), false, 'a null current token must not leave a stale return token');
  assert.deepEqual(readImpersonatedBrand(s), BRAND_B);
});
