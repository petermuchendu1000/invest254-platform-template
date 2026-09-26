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
    const maxCents = u.max != null ? Math.min(toKesCents(u.max), cfg?.maxStakeCents ?? Number.POSITIVE_INFINITY) : cfg?.maxStakeCents;
    return { ...u, minCents, maxCents, ready: !!cfg };
  }, [cfg, toDisplay, toKesCents, isForeign]);
}
