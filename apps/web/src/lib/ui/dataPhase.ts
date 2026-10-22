import type { ConnStatus } from '@/lib/game/types';

/**
 * What a live surface should SAY while it has nothing to draw.
 *
 * Every shell mounted its chart as a bare container and waited: `CandlestickTape` returned
 * `<div ref={hostRef} />` with `if (status !== 'open') return;` on the data effect, so a brand whose
 * socket was still connecting showed a full-height void with no explanation, indistinguishable from
 * a broken page. The digits chart and the wave did the same. A trading screen that shows nothing is
 * worse than one that admits it is loading: the player cannot tell whether to wait or to leave, and
 * a frozen screen on a money product reads as "my money is gone".
 *
 * The phase is derived from two facts only — the socket status and whether this surface has ever
 * received data — so it is pure and testable, and every shell says the same thing at the same time.
 */
export type DataPhase = 'connecting' | 'waiting' | 'reconnecting' | 'offline' | 'failed' | 'ready';

/**
 * @param status  the game socket's connection state.
 * @param hasData whether this surface has received anything to draw yet (a bar, a tick, a row).
 * @param failed  whether the request for that data came back REFUSED (or timed out) and will not
 *                arrive on its own.
 *
 * `hasData` is what separates "first load" from "we had it and lost it": a reconnect on a chart that
 * already has bars must NOT blank the chart — it keeps the last picture and says it is reconnecting,
 * because wiping a trader's chart on a one-second drop is its own kind of lie.
 *
 * `failed` is the state this model was missing, and the omission was expensive. The original pair
 * could only express "nothing yet" — so a request the engine REFUSED in 300ms looked exactly like
 * one still in flight, and the screen said "Fetching market data…" for as long as the player was
 * willing to watch it. Reported from production on a live brand: five minutes of that, over a
 * socket that was open, LIVE, and streaming ticks the whole time, because the engine had answered
 * the candles request with `NO_CANDLES` and the UI had nowhere to put that answer.
 *
 * A failure only wins while the socket is OPEN. If the socket has since dropped, "reconnecting" is
 * both truer and more useful — the reconnect will re-ask, so there is nothing for the player to do.
 */
export function dataPhaseOf(status: ConnStatus, hasData: boolean, failed = false): DataPhase {
  if (hasData) return status === 'open' ? 'ready' : 'reconnecting';
  if (status === 'open') return failed ? 'failed' : 'waiting';
  if (status === 'connecting') return 'connecting';
  return 'offline';
}

export interface PhaseCopy {
  /** The line shown in place of (or over) the surface. */
  title: string;
  /** One clause of reassurance; kept short enough for a 320px phone. */
  detail: string;
}

/**
 * The words. Deliberately plain and non-alarming: on a money product "Error" reads as "something
 * happened to my balance", so even the offline case says what it is doing (retrying) rather than
 * what has failed.
 */
export function phaseCopy(phase: DataPhase, subject = 'market data'): PhaseCopy {
  switch (phase) {
    case 'connecting':
      return { title: 'Connecting…', detail: 'Reaching the live feed.' };
    case 'waiting':
      return { title: `Fetching ${subject}…`, detail: 'The first prices are on their way.' };
    case 'reconnecting':
      return { title: 'Reconnecting…', detail: 'Showing the last prices received.' };
    case 'offline':
      return { title: 'Reconnecting…', detail: 'The live feed dropped. Retrying automatically.' };
    case 'failed':
      /*
       * The one phase that does NOT say it is retrying, because it is not: nothing further is
       * coming unless the player asks again. Saying "fetching" here is what produced a five-minute
       * spinner on a brand whose chart history the engine had already refused.
       *
       * It still avoids the word "error" — the rule above holds, and on this screen it is also
       * literally true that nothing is wrong with the money: the feed is live and the price is
       * ticking. Only the history is missing, so that is exactly what it says.
       */
      return { title: `No ${subject} to show`, detail: 'This chart could not load its history. Try again.' };
    case 'ready':
    default:
      return { title: '', detail: '' };
  }
}

/** True while the surface has nothing real to show and must render a placeholder instead. */
export const phaseIsBlocking = (phase: DataPhase): boolean =>
  phase === 'connecting' || phase === 'waiting' || phase === 'offline' || phase === 'failed';

/**
 * True when the only thing that will change this state is the player asking again.
 *
 * Every other blocking phase resolves itself — the socket connects, the reconnect lands, the first
 * bar arrives — so offering a button would be noise. This one does not, which is the whole reason
 * the phase exists, so this is what decides whether a placeholder draws a retry.
 */
export const phaseNeedsRetry = (phase: DataPhase): boolean => phase === 'failed';

/**
 * Why a trade control is disabled, in words, or null when it is usable.
 *
 * The BUY/SELL buttons went grey with no explanation whenever the socket was not open — the player
 * saw two dead buttons and no reason, which is the same dead-state problem in a control instead of
 * a canvas.
 */
export function tradeDisabledReason(phase: DataPhase): string | null {
  if (phase === 'ready') return null;
  // A CHART that could not load its history is not a reason to refuse a trade. The feed is open and
  // the price is live — that is what a trade is priced from, not the bars — so blocking the buttons
  // here would turn a cosmetic gap into a dead product.
  if (phase === 'failed') return null;
  if (phase === 'reconnecting' || phase === 'offline') return 'Reconnecting to the live feed…';
  return 'Waiting for live prices…';
}

export interface ConnBadge {
  /** The word next to the dot. Short enough for a 40px phone band. */
  label: string;
  /** Semantic tone, mapped to brand tokens by the component. */
  tone: 'up' | 'warn' | 'down';
  /** Whether the dot should pulse. A dead feed must NOT pulse — motion reads as "working". */
  pulse: boolean;
  /** Spelled-out state for `title`/`aria-label`, since the dot is 6px and tooltips miss touch. */
  hint: string;
}

/**
 * The live/offline badge, as words.
 *
 * The candlestick band hardcoded a pulsing dot and the word "LIVE" and never read `status`, so a
 * brand whose socket was closed advertised LIVE above a `—` price. That is worse than a blank: it
 * is the screen telling the player the prices are current when they are not. Every surface that
 * shows a connection dot now derives it from here.
 */
export function connBadge(status: ConnStatus): ConnBadge {
  if (status === 'open') return { label: 'LIVE', tone: 'up', pulse: true, hint: 'Live — prices are current' };
  if (status === 'connecting') return { label: 'SYNCING', tone: 'warn', pulse: true, hint: 'Connecting to the live feed' };
  return { label: 'OFFLINE', tone: 'down', pulse: false, hint: 'The live feed dropped — retrying' };
}

/**
 * True when a number on screen is a LAST-KNOWN value rather than a current one.
 *
 * The price headers keep their tick buffer across a drop, so the price, the % pill and the H/L
 * carry on showing figures from before the disconnect at full size and full confidence. This is
 * what lets those readouts dim themselves and say so.
 */
export const valueIsStale = (status: ConnStatus): boolean => status !== 'open';
