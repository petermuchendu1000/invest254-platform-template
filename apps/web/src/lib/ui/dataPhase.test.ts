import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connBadge, dataPhaseOf, phaseCopy, phaseIsBlocking, phaseNeedsRetry, tradeDisabledReason, valueIsStale } from './dataPhase.js';

/**
 * Dead states. Every shell mounted its chart as a bare container and waited, so a brand whose socket
 * was still connecting showed a full-height void — indistinguishable from a broken page, on a
 * product where "broken" reads as "my money is gone". These pin the rules that replace it.
 */

test('first load: the surface says what it is doing, never nothing', () => {
  assert.equal(dataPhaseOf('connecting', false), 'connecting');
  assert.equal(dataPhaseOf('open', false), 'waiting');
  assert.equal(dataPhaseOf('closed', false), 'offline');
  // All three must render a placeholder rather than an empty box.
  for (const p of ['connecting', 'waiting', 'offline'] as const) {
    assert.equal(phaseIsBlocking(p), true, p);
    assert.ok(phaseCopy(p).title.length > 0, p);
    assert.ok(phaseCopy(p).detail.length > 0, p);
  }
});

test('once data has arrived the chart is never blanked again', () => {
  // The whole point of `hasData`: a one-second drop must not wipe a trader's chart.
  assert.equal(dataPhaseOf('open', true), 'ready');
  assert.equal(dataPhaseOf('closed', true), 'reconnecting');
  assert.equal(dataPhaseOf('connecting', true), 'reconnecting');
  assert.equal(phaseIsBlocking('reconnecting'), false);
  assert.equal(phaseIsBlocking('ready'), false);
});

test('reconnecting says it is still showing the last prices, so a stale chart is not a silent lie', () => {
  assert.match(phaseCopy('reconnecting').detail, /last prices/i);
});

test('no phase blames the user or says "error" on a money screen', () => {
  for (const p of ['connecting', 'waiting', 'reconnecting', 'offline'] as const) {
    const { title, detail } = phaseCopy(p);
    assert.ok(!/error|failed|problem|wrong/i.test(`${title} ${detail}`), `${p}: ${title} ${detail}`);
  }
  // Even offline is framed as what it is doing next.
  assert.match(phaseCopy('offline').detail, /retry/i);
});

test('the subject is substitutable, so a non-chart surface can borrow the same copy', () => {
  assert.match(phaseCopy('waiting', 'your trades').title, /Fetching your trades/);
});

test('ready renders nothing — the placeholder must get out of the way', () => {
  assert.equal(phaseCopy('ready').title, '');
  assert.equal(phaseCopy('ready').detail, '');
});

test('the badge never says LIVE unless the socket is open', () => {
  // The candlestick quote band hardcoded a pulsing "LIVE" and never read the status, so a closed
  // socket advertised live prices. This is the regression that must not come back.
  assert.equal(connBadge('open').label, 'LIVE');
  assert.notEqual(connBadge('connecting').label, 'LIVE');
  assert.notEqual(connBadge('closed').label, 'LIVE');
  for (const s of ['connecting', 'closed'] as const) {
    assert.ok(!/live/i.test(connBadge(s).label), s);
  }
});

test('a dead feed does not pulse — motion reads as "working"', () => {
  assert.equal(connBadge('open').pulse, true);
  assert.equal(connBadge('connecting').pulse, true); // it IS doing something
  assert.equal(connBadge('closed').pulse, false);
});

test('each badge state has its own tone and a spelled-out hint for the 6px dot', () => {
  const tones = (['open', 'connecting', 'closed'] as const).map((s) => connBadge(s).tone);
  assert.deepEqual(tones, ['up', 'warn', 'down']);
  for (const s of ['open', 'connecting', 'closed'] as const) {
    assert.ok(connBadge(s).hint.length > 0, s);
  }
});

test('a figure is stale whenever the socket is not open, because the tick buffer outlives the drop', () => {
  assert.equal(valueIsStale('open'), false);
  assert.equal(valueIsStale('connecting'), true);
  assert.equal(valueIsStale('closed'), true);
});

test('a disabled BUY/SELL always says WHY', () => {
  assert.equal(tradeDisabledReason('ready'), null);
  for (const p of ['connecting', 'waiting', 'reconnecting', 'offline'] as const) {
    const reason = tradeDisabledReason(p);
    assert.ok(reason && reason.length > 0, p);
  }
  assert.match(tradeDisabledReason('waiting')!, /live prices/i);
  assert.match(tradeDisabledReason('offline')!, /reconnect/i);
});

/**
 * BUGLOG #136 — the refusal that looked like loading.
 *
 * Reported from production: "the graphs has been loading for the last 5mins". The socket was OPEN
 * and streaming ticks the whole time; the engine had answered the candles request in ~300ms with
 * `NO_CANDLES` ("this brand draws a line chart, not candles"), the chart discarded that rejection,
 * and the phase model had no state for it — so a definite "never" rendered as "Fetching market
 * data… The first prices are on their way", indefinitely.
 */
test('a REFUSED request is not the same as one still in flight', () => {
  // The exact production shape: socket open, nothing drawn, the request came back refused.
  assert.equal(dataPhaseOf('open', false, true), 'failed');
  // ...and without the failure it is still the honest "waiting", unchanged.
  assert.equal(dataPhaseOf('open', false, false), 'waiting');
  assert.equal(dataPhaseOf('open', false), 'waiting', 'the flag defaults off: every existing caller is untouched');
});

test('a failure never blanks a chart that already has bars, and never outranks a reconnect', () => {
  // Bars already drawn: a later failure must not throw away a trader's chart.
  assert.equal(dataPhaseOf('open', true, true), 'ready');
  assert.equal(dataPhaseOf('closed', true, true), 'reconnecting');
  // Socket gone: the reconnect will re-ask, so "reconnecting" is both truer and more useful than
  // asking the player to retry something that is already in hand.
  assert.equal(dataPhaseOf('closed', false, true), 'offline');
  assert.equal(dataPhaseOf('connecting', false, true), 'connecting');
});

test('the failed copy promises nothing it will not do, and offers the way out', () => {
  const { title, detail } = phaseCopy('failed');
  assert.doesNotMatch(title, /fetching|loading/i, 'it must not claim to be still fetching');
  assert.doesNotMatch(detail, /on their way|retrying/i, 'nothing is on its way without the player asking');
  // It must not claim a live price either: the price axis is carried BY the history reply, so a
  // chart with no history shows `—` where the price goes. An earlier draft of this copy said
  // "the live price is still running" and the screenshot showed a dash two inches above it.
  assert.doesNotMatch(detail, /live price/i, 'the screen shows no price in this state');
  // It still avoids alarming a player about their money, per the rule the other phases follow.
  assert.doesNotMatch(`${title} ${detail}`, /error|failed|problem/i);
  assert.match(detail, /try/i, 'it says what to do');
  // The subject is substituted like every other phase.
  assert.match(phaseCopy('failed', 'your chart').title, /your chart/);
});

test('only the failed phase draws a retry — everything else is already retrying itself', () => {
  assert.equal(phaseNeedsRetry('failed'), true);
  for (const p of ['connecting', 'waiting', 'reconnecting', 'offline', 'ready'] as const) {
    assert.equal(phaseNeedsRetry(p), false, p);
  }
  // It still blocks: there is nothing drawn underneath, so the placeholder must cover the pane.
  assert.equal(phaseIsBlocking('failed'), true);
});

test('a chart that could not load its history does NOT disable trading', () => {
  // The feed is open and the price is live — that is what a trade is priced from, not the bars.
  // Disabling BUY/SELL here would turn a cosmetic gap into a dead product.
  assert.equal(tradeDisabledReason('failed'), null);
});
