'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/endpoints';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useDisplayMoney, USD_LIMITS } from '@/lib/money';
import { resolveStakeUnits, type StakeUnits } from '@/lib/game/stakeLadder';

/**
 * STAKE-1 (BUGLOG #87): the brand's stake range in display units, its pills (multiples of 5 from the
 * minimum) and the matching KES cents. One source for the Deriv screen, Multipliers and the classic
 * bet panel. `minCents`/`maxCents` are what the client validates against (never looser than the
 * engine's enforced cents).
 */
export function useStakeLimits(): StakeUnits & { minCents: number; maxCents: number | undefined; ready: boolean } {
  // `maxCents === undefined` means NO brand ceiling, which is why an inverted range reports it that
  // way rather than as a number below `minCents`. See the guard below.
  const brand = useBrand();
  const { toDisplay, toKesCents, isForeign } = useDisplayMoney();
  const { data: cfg } = useQuery({ queryKey: ['gameConfig', brand.slug], queryFn: () => api.gameConfig(brand.slug), staleTime: 5 * 60_000 });
  return useMemo(() => {
    const u = resolveStakeUnits({
      nativeMin: cfg?.minStakeNative ?? null,
      nativeMax: cfg?.maxStakeNative ?? null,
      minDisplay: toDisplay(cfg?.minStakeCents ?? 25_000),
      maxDisplay: cfg?.maxStakeCents != null ? toDisplay(cfg.maxStakeCents) : null,
      floor: isForeign ? USD_LIMITS.minStake : 5,
    });
    const minCents = Math.max(toKesCents(u.min), cfg?.minStakeCents ?? 0);
    // An inverted range has no ceiling in display units, so the configured cents must not be put
    // back as one: that is where the inversion came from, and re-imposing it would drop `maxCents`
    // under `minCents` again and collapse the tradable volume to a single value.
    const ceilingCents = u.inverted
      ? undefined
      : u.max != null ? Math.min(toKesCents(u.max), cfg?.maxStakeCents ?? Number.POSITIVE_INFINITY) : cfg?.maxStakeCents;
    /**
     * One rule, enforced here as well as in `resolveStakeUnits`: a ceiling below the floor is no
     * ceiling. The resolver works in whole display units and this works in KES cents, so a rate
     * conversion can still invert a range the resolver found sound. Either way the symbol's own
     * ceiling stands and the condition is reported, never silently collapsed.
     */
    const usable = ceilingCents !== undefined && ceilingCents < minCents ? undefined : ceilingCents;
    return { ...u, inverted: u.inverted || usable !== ceilingCents, minCents, maxCents: usable, ready: !!cfg };
  }, [cfg, toDisplay, toKesCents, isForeign]);
}
