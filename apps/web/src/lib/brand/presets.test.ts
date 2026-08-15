import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAND_PRESETS,
  BRAND_PRESET_GROUPS,
  groupedPresets,
  presetForSeed,
  type BrandPreset,
} from './presets.js';
import { deriveMinimalPalette } from './derivePalette.js';
import { BRAND_FONTS } from './fonts.js';

// ---- colour helpers (local, dependency-free) ----------------------------------------------
const HEX = /^#[0-9a-fA-F]{6}$/;
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function relLum(hex: string): number {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** WCAG contrast ratio between two hex colours (1..21). */
function contrast(a: string, b: string): number {
  const la = relLum(a), lb = relLum(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function saturation(hex: string): number {
  const [R, G, B] = rgb(hex);
  const r = R / 255, g = G / 255, b = B / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}
/** Smallest distance between two hues on the 0..360 wheel. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// The token keys every consumer (brandCssVars -> --brand-* -> --pp-*) relies on.
const REQUIRED_TOKENS = [
  'bg', 'surface', 'surface2', 'border', 'fg', 'muted',
  'brand', 'brandHover', 'accent', 'accentFg', 'up', 'down', 'warn', 'info',
] as const;

// ---- structure ------------------------------------------------------------------------------
test('preset menu has a healthy, well-formed set', () => {
  assert.ok(BRAND_PRESETS.length >= 12, 'expected at least 12 presets');

  const labels = BRAND_PRESETS.map((p) => p.label);
  const seeds = BRAND_PRESETS.map((p) => p.seed.toLowerCase());
  assert.equal(new Set(labels).size, labels.length, 'labels must be unique');
  assert.equal(new Set(seeds).size, seeds.length, 'seeds must be unique');

  for (const p of BRAND_PRESETS) {
    assert.match(p.seed, HEX, `${p.label}: seed must be #RRGGBB`);
    assert.equal(p.seed, p.seed.toUpperCase(), `${p.label}: seed should be uppercase`);
    assert.ok(p.hue >= 0 && p.hue < 360, `${p.label}: hue in [0,360)`);
    assert.ok(BRAND_PRESET_GROUPS.includes(p.group), `${p.label}: group must be known`);
    assert.ok(p.label.length > 0 && p.source.length > 0, `${p.label}: label + source non-empty`);
  }
});

test('chromatic presets are spaced apart on the hue wheel (no look-alikes)', () => {
  // The whole point of curation: distinct clients must be distinguishable. Mono presets are
  // excluded because their hue is nominal (a near-neutral grey), not a real chromatic identity.
  const chromatic = BRAND_PRESETS.filter((p) => p.group !== 'Mono');
  for (const a of chromatic) {
    for (const b of chromatic) {
      if (a === b) continue;
      assert.ok(hueGap(a.hue, b.hue) >= 8, `${a.label} and ${b.label} are too close on the hue wheel`);
    }
  }
});

test('at least one mono preset exists (brands that want neutral chrome)', () => {
  const mono = BRAND_PRESETS.filter((p) => p.group === 'Mono');
  assert.ok(mono.length >= 1, 'expected a Mono preset');
  for (const p of mono) assert.ok(saturation(p.seed) < 0.2, `${p.label}: mono seed should be near-neutral`);
});

test('every preset has fonts from the curated set; title faces are distinctive', () => {
  const allowed = new Set<string>(BRAND_FONTS as readonly string[]);
  for (const p of BRAND_PRESETS) {
    assert.ok(allowed.has(p.fontTitle), `${p.label}: fontTitle "${p.fontTitle}" not in BRAND_FONTS`);
    assert.ok(allowed.has(p.fontBody), `${p.label}: fontBody "${p.fontBody}" not in BRAND_FONTS`);
  }
  // Title faces carry a brand's character, so they must be unique across the menu.
  const titles = BRAND_PRESETS.map((p) => p.fontTitle);
  assert.equal(new Set(titles).size, titles.length, 'title faces must be unique across presets');
});

// ---- grouping helpers -----------------------------------------------------------------------
test('groupedPresets: only non-empty groups, in order, hue-sorted, lossless', () => {
  const groups = groupedPresets();
  // ordering follows BRAND_PRESET_GROUPS and skips empties
  const expectedOrder = BRAND_PRESET_GROUPS.filter((g) => BRAND_PRESETS.some((p) => p.group === g));
  assert.deepEqual(groups.map((g) => g.group), expectedOrder);
  // each bucket sorted ascending by hue
  for (const { presets } of groups) {
    let prev = -1;
    for (const q of presets) {
      assert.ok(q.hue >= prev, 'presets within a group must be hue-sorted');
      prev = q.hue;
    }
  }
  // no preset dropped or duplicated
  const flat = groups.flatMap((g) => g.presets);
  assert.equal(flat.length, BRAND_PRESETS.length, 'grouping must be lossless');
  assert.equal(new Set(flat.map((p) => p.label)).size, BRAND_PRESETS.length);
});

test('presetForSeed: case-insensitive match; undefined for unknown', () => {
  const first = BRAND_PRESETS[0];
  assert.ok(first, 'menu must be non-empty');
  assert.equal(presetForSeed(first.seed)?.label, first.label);
  assert.equal(presetForSeed(first.seed.toLowerCase())?.label, first.label);
  assert.equal(presetForSeed(`  ${first.seed.toLowerCase()}  `)?.label, first.label);
  assert.equal(presetForSeed('#123456'), undefined);
  assert.equal(presetForSeed('not-a-colour'), undefined);
});

// ---- derived palette validity ---------------------------------------------------------------
for (const mode of ['dark', 'light'] as const) {
  test(`every preset derives a valid, accessible, semantic-P/L palette (${mode})`, () => {
    for (const p of BRAND_PRESETS) {
      const t = deriveMinimalPalette(p.seed, mode) as Record<string, string>;
      // Asserting accessor: narrows `string | undefined` (noUncheckedIndexedAccess) to `string`
      // and doubles as the "token present" check.
      const tok = (key: string): string => {
        const v = t[key];
        assert.ok(typeof v === 'string', `${p.label}/${mode}: missing token ${key}`);
        return v;
      };

      // 1. full token contract present + valid hex
      for (const key of REQUIRED_TOKENS) {
        assert.match(tok(key), HEX, `${p.label}/${mode}: ${key} must be #RRGGBB (${tok(key)})`);
      }

      // 2. text is readable on the background (WCAG AA body text = 4.5:1)
      const fgBg = contrast(tok('fg'), tok('bg'));
      assert.ok(fgBg >= 4.5, `${p.label}/${mode}: fg/bg contrast ${fgBg.toFixed(2)} < 4.5`);

      // 3. accent label colour is readable on the accent fill (AA large = 3:1)
      const accFg = contrast(tok('accentFg'), tok('accent'));
      assert.ok(accFg >= 3, `${p.label}/${mode}: accentFg/accent contrast ${accFg.toFixed(2)} < 3`);

      // 4. semantic-P/L invariant (docs/22): gain/loss are the FIXED CoinMarketCap pair, identical
      //    for EVERY brand (brand-independent), so a falling price is always red — never the brand
      //    hue or a neutral. Colourblind safety comes from position + sign/arrow cues, not the mono.
      const SEM = mode === 'dark'
        ? { up: '#16C784', down: '#EA3943' }
        : { up: '#0F9D63', down: '#CF2E3B' };
      assert.equal(tok('up').toUpperCase(), SEM.up, `${p.label}/${mode}: gain must be the semantic green`);
      assert.equal(tok('down').toUpperCase(), SEM.down, `${p.label}/${mode}: loss must be the semantic red`);
      assert.notEqual(tok('up').toUpperCase(), tok('brand').toUpperCase(), `${p.label}/${mode}: gain must not collapse into the brand hue`);
    }
  });
}

// ---- determinism ----------------------------------------------------------------------------
test('derivation is deterministic (same seed+mode -> identical tokens)', () => {
  for (const p of BRAND_PRESETS) {
    assert.deepEqual(deriveMinimalPalette(p.seed, 'dark'), deriveMinimalPalette(p.seed, 'dark'));
  }
});

// keep the type import referenced (compile-time guard on the public shape)
export type _PresetShape = BrandPreset;
