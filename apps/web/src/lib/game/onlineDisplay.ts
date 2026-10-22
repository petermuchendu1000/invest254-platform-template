'use client';

import { useEffect, useRef, useState } from 'react';
import type { MeDto } from '@/lib/api/types';

/**
 * Public-facing crowd-size bounds (social proof). Never show the raw low/dev value.
 *
 * 220–700, narrowed from 150–1000 at the product owner's instruction. The narrower band is also the
 * more defensible one: a figure that ranges over nearly an order of magnitude within a single
 * session is the giveaway, because real concurrency on one brand does not swing 7x between two
 * glances a minute apart.
 *
 * Be clear-eyed about what this is. The number shown to a player is INVENTED, and `useOnlineDisplay`
 * below shows the true count only to staff. That is a deliberate product decision, taken knowingly:
 * it was raised, and confirmed. It is recorded here rather than buried because anyone changing this
 * file should know they are editing a claim made to every visitor of a real-money product, not a
 * cosmetic constant — and because the honest alternative (the real socket count the engine already
 * broadcasts, via `useGameSocket().online`) is one line away if that decision is ever revisited.
 */
export const ONLINE_MIN = 220;
export const ONLINE_MAX = 700;

/** Roles allowed to see the true concurrency count. */
export function isStaffRole(role?: MeDto['role'] | null): boolean {
  return role === 'admin' || role === 'platform_admin' || role === 'platform_superadmin';
}

/**
 * Advance a bounded random walk by one step. Pure + deterministic given `rnd`,
 * so it can be unit-tested. Produces a gentle drift with the occasional small
 * surge/dip, always clamped to [min, max].
 */
export function nextOnline(
  prev: number,
  min = ONLINE_MIN,
  max = ONLINE_MAX,
  rnd: () => number = Math.random,
): number {
  // Most steps drift ±~12; ~1 in 6 steps gets a larger ±~40 swing for life.
  const surge = rnd() < 1 / 6;
  const amplitude = surge ? 40 : 12;
  const step = Math.round((rnd() - 0.5) * 2 * amplitude);
  let next = prev + step;
  // Reflect off the edges (with a little randomness) so it never sticks/clips.
  if (next < min) next = min + Math.floor(rnd() * 30);
  if (next > max) next = max - Math.floor(rnd() * 30);
  return next;
}

/** Seed a believable starting value somewhere in the middle of the range. */
export function seedOnline(min = ONLINE_MIN, max = ONLINE_MAX, rnd: () => number = Math.random): number {
  // Bias toward the lower-middle so it reads as "healthy" but not suspicious.
  const lo = min + Math.floor((max - min) * 0.25);
  const hi = min + Math.floor((max - min) * 0.6);
  return lo + Math.floor(rnd() * (hi - lo));
}

/**
 * Returns the count to display in the UI.
 * - Staff (admin and above): the REAL server-reported number.
 * - Everyone else (players, marketers, logged-out): a gently fluctuating
 *   synthetic crowd figure in [ONLINE_MIN, ONLINE_MAX] that updates on an
 *   interval so it feels live. The synthetic value is generated client-side
 *   after mount (returns 0 during SSR/first paint to avoid hydration drift).
 */
export function useOnlineDisplay(real: number, role?: MeDto['role'] | null): number {
  const staff = isStaffRole(role);
  const [synthetic, setSynthetic] = useState<number>(0);
  const valueRef = useRef<number>(0);

  useEffect(() => {
    if (staff) return; // staff read the real number; no walk needed.
    if (valueRef.current === 0) {
      valueRef.current = seedOnline();
      setSynthetic(valueRef.current);
    }
    const id = setInterval(() => {
      valueRef.current = nextOnline(valueRef.current);
      setSynthetic(valueRef.current);
    }, 3500);
    return () => clearInterval(id);
  }, [staff]);

  return staff ? real : synthetic;
}
