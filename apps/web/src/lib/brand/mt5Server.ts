/**
 * The trading server's NAME, derived the way MetaTrader 5 brokers actually name theirs.
 *
 * Every real MT5 account carries a server string of the form `<BrokerShortName>-<Purpose><NN>`:
 * "MetaQuotes-Demo", "ICMarketsSC-Live07", "Pepperstone-Edge01", "Exness-Real12". Three properties
 * of that convention are what make it read as a real broker rather than a label we invented:
 *
 *   1. The broker token is ONE CamelCase word. No spaces, no punctuation — the string is a server
 *      address in MetaTrader's own account list, so "Much Wins-Live" could never appear there.
 *   2. A live server carries a zero-padded two-digit index, because brokers run a FARM of them and
 *      an account is pinned to one of them ("Live07", never "Live7" and never "Live").
 *   3. A demo server carries no index. MetaQuotes' own demo server is plain "MetaQuotes-Demo", and
 *      brokers follow it, so adding an index to demo is the one thing that would look wrong.
 *
 * The index is HASHED from the brand, not random and not stored: a brand must always show the same
 * server (a trader who screenshots "MuchWins-Live07" today and reopens the app tomorrow would
 * notice it moving), while two brands on this platform land on different servers.
 */

/** The brand fields this needs. Accepts a full `Brand` as-is. */
export interface ServerBrand {
  name?: string | null;
  slug?: string | null;
}

/** Which account the string describes. The two differ in shape, not just in wording. */
export type AccountMode = 'real' | 'demo';

/** The brand to fall back to, matching the app's own last-resort brand. */
const FALLBACK_BRAND = 'invest254';

/**
 * How many live servers the "farm" has. Brokers number theirs from 01 upward in a small range
 * (ICMarkets runs Live01..Live30ish), so a two-digit index stays inside the convention.
 */
const LIVE_SERVER_COUNT = 20;

/**
 * Broker short names are short. "ICMarketsSC" and "Pepperstone" are the long end of what MT5
 * actually shows, so a brand with a sentence for a name is abbreviated rather than printed whole.
 */
const MAX_BROKER_TOKEN = 20;

/**
 * The brand as a single CamelCase broker token: "Much Wins" -> "MuchWins", "invest254" ->
 * "Invest254", "ic-markets-sc" -> "IcMarketsSc". Punctuation splits words instead of surviving,
 * and existing inner capitals are kept, so a brand already written CamelCase passes through
 * untouched ("MuchWins" stays "MuchWins", "FTMO" stays "FTMO").
 */
export function mt5BrokerToken(brand: ServerBrand): string {
  const source = (brand.name || '').trim() || (brand.slug || '').trim() || FALLBACK_BRAND;
  const token = source
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  // A brand whose name is entirely punctuation (or empty after the split) still needs a server.
  if (!token) return mt5BrokerToken({ name: FALLBACK_BRAND });
  return token.slice(0, MAX_BROKER_TOKEN);
}

/**
 * Which live server in the farm this brand's accounts sit on, as MT5's zero-padded two digits.
 * Seeded from the slug (the brand's stable identity) so a display-name tweak does not move every
 * account to a different server. Indexes start at 01: there is no "Live00".
 */
function liveServerIndex(brand: ServerBrand): string {
  const seed = ((brand.slug || '').trim() || (brand.name || '').trim() || FALLBACK_BRAND).toLowerCase();
  let x = 0;
  for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) >>> 0;
  // The low bits of a *31 hash barely move between similar slugs, and it is exactly the low bits
  // that survive the modulo — so mix them with the high ones before taking the index.
  x ^= x >>> 15;
  x = (Math.imul(x, 0x2545f491) >>> 0) ^ (x >>> 13);
  return String(((x >>> 0) % LIVE_SERVER_COUNT) + 1).padStart(2, '0');
}

/**
 * The server string MetaTrader would print for this brand and account mode:
 * `MuchWins-Live07` for a real account, `MuchWins-Demo` for a demo one.
 */
export function mt5ServerName(brand: ServerBrand, mode: AccountMode): string {
  const broker = mt5BrokerToken(brand);
  return mode === 'demo' ? `${broker}-Demo` : `${broker}-Live${liveServerIndex(brand)}`;
}
