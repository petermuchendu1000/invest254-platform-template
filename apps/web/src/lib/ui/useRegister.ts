'use client';

import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { useBrand } from '@/lib/brand/BrandProvider';
import { audienceWords, registerOf, type AudienceWords, type Register } from './register.js';
import { presentsAsTradingProduct } from '@/lib/ui/terminalScreen';

/**
 * This brand's register and the nouns that go with it, for copy that differs by audience.
 *
 * Separate from `lib/ui/register` on purpose: that module is pure, so it can be imported by other
 * pure modules (the legal page's content, the Company tab's links) and unit-tested without React.
 * This is the React seam over it, and nothing but a component should need it.
 */
export function useRegister(): { register: Register; words: AudienceWords; brandName: string } {
  const brand = useBrand();
  const register = registerOf(presentsAsTradingProduct(brand.tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null));
  return { register, words: audienceWords(register), brandName: brand.name };
}
