import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_FONTS, fontStack, googleFontsHref } from './fonts.js';

test('BRAND_FONTS is a non-empty, unique family list', () => {
  assert.ok(BRAND_FONTS.length >= 8);
  assert.equal(new Set(BRAND_FONTS).size, BRAND_FONTS.length, 'families must be unique');
  for (const f of BRAND_FONTS) assert.ok(f.length > 0 && !/["<>]/.test(f), `bad family: ${f}`);
});

test('fontStack quotes the family and picks the right generic fallback', () => {
  // sans (default)
  assert.match(fontStack('Inter'), /^"Inter", ui-sans-serif/);
  assert.match(fontStack('Poppins'), /sans-serif$/);
  // serif families
  assert.match(fontStack('Fraunces'), /^"Fraunces", ui-serif/);
  assert.match(fontStack('Lora'), /serif$/);
  assert.ok(!/sans-serif/.test(fontStack('Lora')));
  // monospace families
  assert.match(fontStack('Space Mono'), /^"Space Mono", ui-monospace/);
  assert.match(fontStack('JetBrains Mono'), /monospace$/);
});

test('googleFontsHref builds a valid, deduped CSS2 URL', () => {
  assert.equal(googleFontsHref([]), '', 'empty -> empty string');
  assert.equal(googleFontsHref(['', '']), '', 'blank families -> empty string');

  const href = googleFontsHref(['Space Grotesk', 'Inter']);
  assert.ok(href.startsWith('https://fonts.googleapis.com/css2?'), 'CSS2 endpoint');
  assert.ok(href.includes('family=Space+Grotesk'), 'spaces encoded as +');
  assert.ok(href.includes('family=Inter'));
  assert.ok(href.endsWith('&display=swap'), 'font-display=swap for no-FOIT');

  // de-duplication: repeated family requested once
  const dup = googleFontsHref(['Inter', 'Inter', 'DM Sans']);
  assert.equal(dup.match(/family=Inter(:|&|$)/g)?.length, 1, 'Inter requested once');
  assert.ok(dup.includes('family=DM+Sans'));
});
