'use client';

import { useMemo } from 'react';
import { LOT_STAKE_CENTS } from '@invest254/shared/account';
import { effectiveVolume, volumeSpecOf, volumeDigitsOf } from '@invest254/shared/symbols';
import { useStakeLimits } from '@/lib/game/useStakeLimits';

/**
 * Decimals a volume prints to on a symbol, for any surface that renders one.
 *
 * MetaTrader prints a volume to the symbol's own volume digits everywhere it appears — the ticket's
 * field and its `min`/`max` hints, and every grid row (docs/mt5/09-toolbox.md 300, 313-318). The
 * order ticket worked this out for itself and nothing else did, so the same position read `0.025` in
 * the ticket and `0.03` in the Trade grid, the History grid and the phone position row: the lot size
 * appeared to change between the ticket and the row it produced.
 *
 * The range the digits follow from is the symbol's own spec intersected with the brand's stake
 * limits, which is the same intersection the ticket offers — see `effectiveVolume`. A brand whose
 * minimum stake is not a whole number of steps (KES 250 is 0.025 lots on a hundredth step) is
 * exactly the case that needs the third place.
 */
export function useVolumeDigits(symbol: string): number {
  const limits = useStakeLimits();
  return useMemo(() => {
    const brandMinLots = limits.minCents / LOT_STAKE_CENTS;
    // A brand may set no ceiling; the symbol's own then stands.
    const brandMaxLots = limits.maxCents === undefined ? null : limits.maxCents / LOT_STAKE_CENTS;
    return volumeDigitsOf(effectiveVolume(volumeSpecOf(symbol), brandMinLots, brandMaxLots));
  }, [symbol, limits.minCents, limits.maxCents]);
}
