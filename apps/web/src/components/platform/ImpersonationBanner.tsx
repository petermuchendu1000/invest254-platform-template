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
    <div className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 border-b border-warn/40 bg-warn/15 px-4 py-2 text-sm">
      <span className="flex items-center gap-2 text-fg">
        <span className="inline-block h-2 w-2 rounded-full bg-warn animate-pulse" />
        Viewing <strong className="font-semibold">{brand.name}</strong> as <strong className="font-semibold">superadmin</strong>
        <span className="text-muted">· via platform console</span>
      </span>
      <button
        type="button"
        onClick={endImpersonation}
        className="rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-fg hover:bg-surface-2"
      >
        ← Exit to platform
      </button>
    </div>
  );
}
