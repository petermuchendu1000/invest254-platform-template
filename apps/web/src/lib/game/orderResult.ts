/**
 * What a terminal says when an order comes back.
 *
 * MetaQuotes, both platforms: *"Once an order is sent, its execution results will appear IN THE
 * WINDOW: either confirmation of a successful trade or a rejection with the reason specified"*
 * (docs/mt5/04-mobile-app.md section 5). So the order screen has to be able to say both, and this
 * module is the words it says, kept apart from the screens that say them because two surfaces place
 * the same order: the phone's classic ticket and its advanced dialog.
 *
 * `errorTitle` and `friendlyError` moved here from GameSocketProvider, where they were private to
 * the toast. They are the SAME sentences in both places deliberately: a rejection that reads one
 * way in a popup and another way in the window is two bugs waiting to be reported separately.
 */

/** A refusal this client makes itself, before anything is sent. */
export type LocalRefusal =
  /** One contract at a time: the engine's rule, enforced here so no frame is wasted. */
  | 'POSITION_OPEN'
  | 'LOGIN_REQUIRED'
  | 'OFFLINE'
  /** The chart is on a symbol this brand will not settle. */
  | 'WRONG_SYMBOL';

/**
 * The title MetaTrader would put on a rejection.
 *
 * Short, and never a bare engine code: a trader reading `ENGINE_ERROR` learns nothing they can act
 * on, which is the opposite of "the reason specified".
 */
export function errorTitle(code: string): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Log in to trade';
    case 'AUTH_INVALID':
      return 'Session expired: log in again';
    case 'INSUFFICIENT_FUNDS':
      return 'Insufficient balance';
    case 'SYSTEM_DISABLED':
      return 'Paused';
    default:
      return 'Trade rejected';
  }
}

/**
 * Reformat an engine error for display so amounts are shown in the brand's display currency, never
 * as raw KES cents. e.g. "STAKE_BELOW_MIN: min 25000" -> "Minimum stake is $1.92 (KES 250)".
 */
export function friendlyError(
  message: string | undefined,
  reasons: string[] | undefined,
  fmt: (c: number) => string,
): string | undefined {
  const raw = reasons && reasons.length > 0 ? reasons.join(' · ') : message;
  if (!raw) return raw;
  // Engine codes arrive as the message of an ENGINE_ERROR frame: never show a bare code.
  if (/^INSUFFICIENT_FUNDS\b/.test(raw)) return 'Top up or lower the stake.';
  if (/^CONTRACT_EXISTS\b/.test(raw)) return 'One contract at a time on this market.';
  if (/^(INVALID_INSTRUMENT|NO_SEED)\b/.test(raw)) return 'Market unavailable. Pick another.';
  if (/^stake must be integer cents/.test(raw)) return 'Enter a valid stake.';
  let m: RegExpExecArray | null;
  if ((m = /STAKE_BELOW_MIN:\s*min\s*(\d+)/i.exec(raw))) return `Minimum stake is ${fmt(Number(m[1]))}.`;
  if ((m = /STAKE_ABOVE_MAX:\s*max\s*(\d+)/i.exec(raw))) return `Maximum stake is ${fmt(Number(m[1]))}.`;
  // Generic safety: reformat any bare "min <cents>" / "max <cents>" so raw cents never leak through.
  return raw.replace(/\b(min|max)\s+(\d{3,})\b/gi, (_s, w: string, c: string) => `${w} ${fmt(Number(c))}`);
}

/**
 * The reason for a refusal this client made itself.
 *
 * `POSITION_OPEN` is the one worth reading twice. The engine takes one contract at a time and the
 * client enforces it, and a contract that is still SETTLING still counts: so the Trade screen can
 * say "No open positions" while an order is refused for the position it no longer shows. Before
 * this, that refusal was silent, and tapping SELL did nothing whatever for a reason nothing on
 * screen stated.
 */
export function refusalReason(code: LocalRefusal): { title: string; detail: string } {
  switch (code) {
    case 'POSITION_OPEN':
      return {
        title: 'Trade rejected',
        detail: 'One contract at a time on this market. The last one is still settling: it finishes on its own.',
      };
    case 'LOGIN_REQUIRED':
      return { title: 'Log in to trade', detail: 'Sign in and the order can be placed.' };
    case 'OFFLINE':
      return { title: 'Not connected', detail: 'Reconnecting: try again shortly.' };
    case 'WRONG_SYMBOL':
      return {
        title: 'Trade rejected',
        detail: 'This brand settles one symbol. Chart it to place an order.',
      };
  }
}

/**
 * MetaTrader's own one-line description of a fill: `sell 0.03 XAUUSD at 3082.07`.
 *
 * Lower-case side, volume to the instrument's own decimals, then the price. The same phrasing the
 * Close position screen puts under its title ("buy 0.61 GBPUSD at 1.33629"), so the two screens
 * describe one position the same way.
 */
export function fillLine(
  { direction, lots, symbol, price, digits, volDigits = 2 }: {
    direction: 'buy' | 'sell';
    lots: number;
    symbol: string;
    price: number | null;
    digits: number;
    volDigits?: number;
  },
): string {
  const at = price === null ? '' : ` at ${price.toFixed(digits)}`;
  return `${direction} ${lots.toFixed(volDigits)} ${symbol}${at}`;
}

/** What the order window is showing. */
export type OrderResult =
  /** Sent, and nothing has come back. MetaTrader's window waits here too. */
  | { kind: 'sending'; direction: 'buy' | 'sell' }
  /** The engine accepted it. `line` is `fillLine`; `ticket` is the position's own number. */
  | { kind: 'done'; line: string; ticket: string | null }
  | { kind: 'rejected'; title: string; detail: string | undefined };
