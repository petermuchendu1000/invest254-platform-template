'use client';

import { useEffect, useState } from 'react';
import { getImpersonatingBrand, endImpersonation, type ImpersonatedBrand } from '@/lib/platform/impersonate';

/**
 * Sticky banner shown in the admin console while the platform owner is impersonating a brand's
 * superadmin (docs/24). Makes the impersonation obvious (so an operator never mistakes it for their
 * own account) and offers a one-click return to the platform console, restoring the platform token.
 * Renders nothing when not impersonating. Mount it high in the admin layout.
 */
export function ImpersonationBanner() {
  const [brand, setBrand] = useState<ImpersonatedBrand | null>(null);

  // sessionStorage is client-only — read after mount to avoid an SSR/CSR hydration mismatch.
  useEffect(() => { setBrand(getImpersonatingBrand()); }, []);

  if (!brand) return null;
  return (
    <div className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 border-b border-warn/50 bg-warn/20 px-4 py-2 text-sm">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fg">
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-warn animate-pulse" />
        <span>
          Logged in as <strong className="font-semibold">superadmin</strong> · accessing{' '}
          <strong className="font-semibold">{brand.name}</strong>
        </span>
        <span className="font-mono text-xs text-muted">{brand.primaryDomain ?? brand.slug}</span>
      </span>
      <button
        type="button"
        onClick={endImpersonation}
        className="rounded-lg border border-warn/50 bg-warn/15 px-2.5 py-1 text-xs font-semibold text-warn hover:bg-warn/25"
      >
        ← Exit to platform
      </button>
    </div>
  );
}
