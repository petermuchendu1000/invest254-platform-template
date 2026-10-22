/**
 * Which product this brand is, in the only terms the UI copy cares about.
 *
 * One deployment serves two: a brand whose shell is the MetaTrader terminal is a BROKER and its
 * users are traders; a brand on the classic or digits shell is a real-money prediction game and its
 * users are players. The shell is the single fact that decides it, so the rule lives here and every
 * surface asks rather than each one re-deriving it from `chartStyle`.
 *
 * `audienceWords` is for copy where the two registers differ by a NOUN and nothing else: an
 * affiliate's referrals are players on one product and traders on the other, and the sentence around
 * them is the same sentence. Where the two registers differ in substance rather than vocabulary, as
 * the legal page's disclosures do, each is written out instead; see lib/legal/legalPage.
 */

export type Register = 'trading' | 'gaming';

export const registerOf = (terminalBrand: boolean): Register =>
  terminalBrand ? 'trading' : 'gaming';

export interface AudienceWords {
  /** "trader" / "player". */
  one: string;
  /** "traders" / "players". */
  many: string;
  /** Possessive plural: "traders'" / "players'". */
  manyPossessive: string;
  /** What they do: "trading" / "play". */
  activity: string;
}

export const audienceWords = (register: Register): AudienceWords =>
  register === 'trading'
    ? { one: 'trader', many: 'traders', manyPossessive: "traders'", activity: 'trading' }
    : { one: 'player', many: 'players', manyPossessive: "players'", activity: 'play' };
