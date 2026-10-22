import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketerSkinOn } from './skinPolicy.js';
import { isTerminalScreen } from '../ui/terminalScreen.js';

/**
 * OWNER POLICY, pinned: a marketer gets the PLAYER interface, exactly.
 *
 * Worth a test rather than a comment because the whole difference now hangs off one constant, and
 * every shared surface — money wording, Buy/Sell, nav, footer, the wave, the MetaTrader shell — reads
 * it through `useMarketerSkin()`. Flip it back by accident and a marketer silently gets a different
 * product again, with nothing failing to say so.
 */

test('a marketer sees the player interface, not the basic skin', () => {
  assert.equal(marketerSkinOn(true, false), false);
});

test('a player who chose Basic still gets Basic. That opt-in is what the skin is for now', () => {
  assert.equal(marketerSkinOn(false, true), true);
  // And a marketer who happens to have Basic stored gets it too: it is a per-device preference, so
  // it is theirs to set like anyone else's.
  assert.equal(marketerSkinOn(true, true), true);
});

test('a player on Classic gets the full interface', () => {
  assert.equal(marketerSkinOn(false, false), false);
});

test('the role no longer decides the skin. Only the preference does', () => {
  // The property, rather than the four rows above: for either role, the answer is the preference.
  for (const basic of [false, true]) {
    assert.equal(
      marketerSkinOn(true, basic),
      marketerSkinOn(false, basic),
      `role changed the skin at basic=${basic}`,
    );
  }
});

test('a marketer on a candlestick brand now gets the MetaTrader shell', () => {
  // This is the difference the screenshots showed: `isTerminalScreen` disqualifies a basic-skin
  // screen, so pinning marketers to Basic also denied them the terminal entirely.
  const terminalBrand = true;
  assert.equal(isTerminalScreen(terminalBrand, marketerSkinOn(true, false)), true);
  // A player on Basic is still turned away, which is the point of Basic.
  assert.equal(isTerminalScreen(terminalBrand, marketerSkinOn(false, true)), false);
  // And a line brand is not a terminal for anyone.
  assert.equal(isTerminalScreen(false, marketerSkinOn(true, false)), false);
});
