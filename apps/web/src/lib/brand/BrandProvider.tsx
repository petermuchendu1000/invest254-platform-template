'use client';

import { createContext, useContext } from 'react';
import { type Brand, DEFAULT_BRAND } from './brand';

/**
 * Client-side brand context. The root layout resolves the brand server-side (by host) and hands
 * it down here, so every client component (logo, footer, live socket, …) renders the current
 * brand without re-fetching. Falls back to DEFAULT_BRAND if a consumer is somehow mounted outside
 * a provider (keeps the UI rendering).
 */
const BrandCtx = createContext<Brand>(DEFAULT_BRAND);

export function BrandProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  return <BrandCtx.Provider value={brand}>{children}</BrandCtx.Provider>;
}

/** The brand the current request/host resolved to. */
export function useBrand(): Brand {
  return useContext(BrandCtx);
}
