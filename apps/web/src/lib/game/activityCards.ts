import type { BrandActivityDto } from '@/lib/api/types';

/**
 * WHICH activity rows earn a notification card, and WHICH of them actually get one.
 *
 * Extracted from `ActivityNotice` and kept pure because this is precisely the logic that failed in
 * production. The component walked the feed with `.reverse()`, under a comment asserting the server
 * sends oldest-first. It does not — `recent()` sorts ascending by age, so index 0 is the freshest
 * row — and the reversal meant the three OLDEST eligible events were the ones shown. On a brand
 * whose newest real activity was a fortnight old, that was the same prolific trader's wins, over
 * and over, while genuinely fresh rows sat unused at the top of the array.
 *
 * None of that was visible to a type checker and none of it was reachable from a test while it
 * lived inside a `useEffect`. It is a function now.
 */

/** KES 1,000 — see `eligible`. */
export const MIN_WITHDRAWAL_CENTS = 100_000;

/**
 * WHICH ROWS EARN A CARD.
 *
 *  - `win`: all of them. A winning trade on this screen's own game is what the card is for.
 *  - `withdrawal`: above a floor. Money actually leaving for a player's phone is the strongest
 *    proof this product can show, and the server only reports withdrawals that were PAID — but the
 *    minimum withdrawal is a few hundred shillings and popping a card for one devalues every other
 *    card. The threshold is in KES cents because that is the money of record on every brand,
 *    foreign ones included; a display-currency threshold would drift with the FX rate.
 *  - `deposit`: never. Money going IN is not a win, and a deposit notice over a deposit button is
 *    an advert dressed as news.
 */
export function eligible(it: BrandActivityDto): boolean {
  if (it.kind === 'win') return true;
  if (it.kind === 'withdrawal') return it.amountCents >= MIN_WITHDRAWAL_CENTS;
  return false;
}

/**
 * Identity for "have I shown this already?".
 *
 * The DTO carries no id — `activity.pg.ts` deliberately withholds transaction ids from a public
 * feed — and `agoSeconds` is recomputed on every poll, so neither can be part of the key. Name +
 * kind + amount is what is left. Two separate wins of the same amount by the same trader collide
 * and the second is dropped, which is the right way to be wrong: a card too few is unnoticeable,
 * the same card twice looks fabricated.
 */
export function keyOf(it: BrandActivityDto): string {
  return `${it.kind}|${it.name}|${it.amountCents}`;
}

/**
 * Fisher–Yates, over a COPY, with the source of randomness injected.
 *
 * `rng` is a parameter so the selection can be tested deterministically — a shuffle that can only
 * be tested statistically is a shuffle nobody tests.
 */
export function shuffle<T>(rows: readonly T[], rng: () => number = Math.random): T[] {
  const out = rows.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

export interface CardSelection {
  /** The rows to show, freshest first. */
  take: BrandActivityDto[];
  /**
   * The keys of the rows actually SHOWN, and only those.
   *
   * It used to be every eligible row in the window, which made sense when the selection was "the
   * newest three": everything older was deliberately skipped for good. Under a random draw that
   * would be wrong — it would burn 37 of 40 rows to show 3, so the pool a player sees would be a
   * handful of events and then silence until the brand produced more.
   *
   * Marking only what was shown means each row gets its turn at most once, and the remaining pool
   * is re-drawn on the next poll. That is what makes the stream keep moving AND keep varying.
   */
  seenKeys: string[];
}

/**
 * Choose the next cards — a TOTALLY RANDOM draw from everything still unshown.
 *
 * Not "the newest few", which is what this did before. Position in the feed buys a row nothing:
 * every eligible row the player has not already been shown is equally likely, every poll.
 *
 * WHY THAT IS SAFE HERE, AND WAS NOT BEFORE. A random draw puts rows on screen out of time order,
 * and this surface used to print each row's age — so a column reading "2m ago / just now / 1h ago"
 * would have been instantly, visibly wrong. The ages are gone. With nothing on screen asserting
 * WHEN anything happened, order carries no claim and can be pure chance. Ordering by recency is
 * also what let one prolific trader own the screen, so the honest fix and the varied one coincide.
 *
 * @param items       the feed window, exactly as `recent()` returns it.
 * @param seen        keys already shown.
 * @param recentNames names the last few cards carried, lower-cased.
 * @param max         how many to take this batch.
 * @param rng         injected for tests; real callers use Math.random.
 */
export function selectCards(
  items: readonly BrandActivityDto[],
  seen: ReadonlySet<string>,
  recentNames: readonly string[],
  max: number,
  rng: () => number = Math.random,
): CardSelection {
  const fresh = items.filter(eligible).filter((it) => !seen.has(keyOf(it)));

  /**
   * ONE CARD PER TRADER, on top of the shuffle.
   *
   * Randomness alone does not prevent a repeat: an account holding many rows is drawn in
   * proportion to how many it holds, so a prolific one still surfaces more often than anybody
   * else. A feed meant to read as a room cannot keep naming one of its people. The server caps a
   * name at two rows per window as well — belt and braces, since the two layers fail independently.
   */
  const used = new Set(recentNames.map((n) => n.trim().toLowerCase()));
  const take: BrandActivityDto[] = [];
  for (const it of shuffle(fresh, rng)) {
    if (take.length >= max) break;
    const n = it.name.trim().toLowerCase();
    if (used.has(n)) continue;
    used.add(n);
    take.push(it);
  }

  return { take, seenKeys: take.map(keyOf) };
}
