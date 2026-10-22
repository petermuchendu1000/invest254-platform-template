import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dark is the platform's default, and a brand record cannot change that.
 *
 * It used to be `brand.theme === 'light' ? 'light' : 'dark'`, so one row in the sites table opened
 * light for everyone on that brand who had never touched the toggle. A terminal is a dark product:
 * MetaTrader's own desktop ships dark, and this one is a chart on a dark pane with a dark Market
 * Watch beside it. Light is a trader's choice now, not a brand's.
 *
 * Read from the root layout, because that is where the decision is made and there is no exported
 * function to call: the same reason `theme.test.ts` reads the stylesheet.
 */

const LAYOUT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'layout.tsx'),
  'utf8',
);

test('the first paint is dark, whatever the brand says', () => {
  assert.match(
    LAYOUT,
    /const defaultTheme = 'dark' as const;/,
    'the default theme is no longer a literal dark',
  );
  // And the pre-paint script seeds itself from THAT, not from the brand.
  assert.match(LAYOUT, /var d=\$\{JSON\.stringify\(defaultTheme\)\}/);
  assert.doesNotMatch(
    LAYOUT,
    /brandDefaultTheme/,
    'the old brand-driven default is back under its old name',
  );
});

test("but the brand's palette still follows the brand, which is a different question", () => {
  /**
   * The two were one value and had to come apart. `brand-light`/`brand-dark` says which mode the
   * brand's greys were AUTHORED for, so the stylesheet can use them there and the neutral palette
   * everywhere else. Deriving it from the new always-dark default would tag a light brand's greys
   * `brand-dark` and apply them in dark mode, which is the exact bug the class exists to prevent.
   */
  assert.match(
    LAYOUT,
    /const brandPaletteClass = brand\.theme === 'light' \? 'brand-light' : 'brand-dark';/,
    'the palette class must read brand.theme, not the default',
  );
});

test('a stored choice still wins, or the toggle would do nothing on a reload', () => {
  // `s || d`: the stored value first, the default only as a fallback.
  assert.match(LAYOUT, /localStorage\.getItem\('pp-theme'\);var t=s\|\|d;/);
});
