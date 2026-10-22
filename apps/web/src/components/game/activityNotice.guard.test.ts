import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * WHERE THE WIN RIBBON IS MOUNTED — enforced, because the browser that could catch it is not in CI.
 *
 * `ActivityNotice` is social proof over a trading screen, and the only thing standing between it
 * and the chart is where it is rendered. It used to be mounted INSIDE the wave shell's chart box
 * (`<ActivityNotice className="top-3" />` in a `relative min-h-[160px]` div) as a 288x73 card:
 * measured in Chromium, that covered 42.7% of the whole chart at 320x568 and 30.6% at 360x640,
 * right over the curve a player reads to choose Higher or Lower. Marketers demonstrating the app
 * reported it; `apps/web/e2e/activitynotice.e2e.mjs` is the measurement.
 *
 * That e2e needs a browser and a running dev server, so it cannot gate a merge. This can: every
 * property below is one a careless re-mount would break, and all of them are visible in the source.
 *
 * It is deliberately a SOURCE guard rather than a render test — there is no DOM in this runner (see
 * the root `test` script: plain `node --test` over `*.test.ts`) and adding one for four assertions
 * would be a heavier dependency than the thing it protects.
 */

const WEB = resolve(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(resolve(WEB, p), 'utf8');

const WAVE = 'src/components/game/TradeSurface.tsx';
const CANDLESTICK = 'src/components/game/candlestick/CandlestickTradeScreen.tsx';

/** Every `<ActivityNotice ... />` tag in a file, JSX comments and all. */
function mounts(src: string): string[] {
  return src.match(/<ActivityNotice\b[^>]*\/>/g) ?? [];
}

test('the ribbon is mounted exactly once per shell', () => {
  // Twice would be the expensive mistake: two instances poll the same feed into two independent
  // queues, so every event is shown twice — and on the candlestick screen, which renders a phone
  // tree and a desktop tree, that is a one-character slip away.
  assert.equal(mounts(read(WAVE)).length, 1, 'TradeSurface must mount ActivityNotice once');
  assert.equal(mounts(read(CANDLESTICK)).length, 1, 'CandlestickTradeScreen must mount ActivityNotice once');
});

test('each shell asks for the placement built for it', () => {
  assert.match(mounts(read(WAVE))[0]!, /placement="band"/);
  assert.match(mounts(read(CANDLESTICK))[0]!, /placement="ribbon"/);
});

test('the wave shell mounts it on the ticker row, not in the chart box', () => {
  const src = read(WAVE);

  // The chart box, from `relative min-h-[160px]` to the end of that element. Nothing social-proof
  // shaped may live inside it: anything absolutely positioned here is positioned against the CHART.
  const chartBox = src.slice(src.indexOf('<div className="relative min-h-[160px] flex-1">'));
  const chartBoxEnd = chartBox.indexOf('</div>', chartBox.indexOf('<GameCurve'));
  assert.ok(chartBoxEnd > 0, 'could not find the chart box — this guard needs updating with the layout');
  assert.doesNotMatch(
    chartBox.slice(0, chartBoxEnd),
    /<ActivityNotice\b/,
    'ActivityNotice is back inside the chart box: `placement="band"` means it covers the ticker row, '
      + 'and a mount here puts it over the curve again (see this file\'s header)',
  );

  // And it IS on the ticker row: `placement="band"` is `absolute inset-0`, so the ribbon lands on
  // whatever the nearest positioned ancestor is. If that wrapper stops being `relative`, `inset-0`
  // silently resolves against `<main>` instead and the ribbon reappears over the chart.
  const row = src.slice(src.indexOf('<TickerStrip />'));
  assert.match(row.slice(0, row.indexOf('</div>') + 6), /<ActivityNotice\b/,
    'the ribbon must be a sibling of TickerStrip, inside the row wrapper it is positioned against');
  const wrapperOpen = src.lastIndexOf('<div className="', src.indexOf('<TickerStrip />'));
  const wrapper = src.slice(wrapperOpen, src.indexOf('>', wrapperOpen));
  assert.match(wrapper, /\brelative\b/,
    'the ticker row wrapper must stay `relative`, or `inset-0` resolves against <main> and the '
      + 'ribbon lands over the chart');
});

test('the wave shell keeps the ribbon and the marquee under ONE visibility rule', () => {
  const src = read(WAVE);
  const wrapperOpen = src.lastIndexOf('<div className="', src.indexOf('<TickerStrip />'));
  const wrapper = src.slice(wrapperOpen, src.indexOf('>', wrapperOpen));
  // BUGLOG #129: under 640px tall the decorative ticker gives its row back to the chart, which at
  // 320x568 is already at its 160px floor. The ribbon rides that row, so it must be governed by the
  // same rule and on the same element — splitting them hands those 30px back and pushes the screen
  // past `h-dvh` inside an `overflow-hidden` shell.
  assert.match(wrapper, /\[@media\(max-height:640px\)\]:hidden/,
    'the ticker row (and the ribbon on it) must stay hidden under 640px tall — BUGLOG #129');
});

test('no other surface mounts it', () => {
  // Grown by hand rather than by scanning: a NEW shell wanting social proof should have to come
  // here, read why there are only two placements, and pick one.
  const SHELLS = [WAVE, CANDLESTICK];
  const others = [
    'src/components/game/digits/DigitsTradeScreen.tsx',
    'src/components/game/mobile/MT5MobileShell.tsx',
    'src/components/layout/AppShell.tsx',
    'src/components/game/GameCurve.tsx',
  ];
  for (const f of others) {
    assert.equal(mounts(read(f)).length, 0, `${f} must not mount ActivityNotice`);
  }
  assert.equal(SHELLS.length, 2);
});
