'use client';

import { Button } from '@/components/ui/Button';
import { useImpersonate } from '@/lib/platform/hooks';
import { startImpersonation } from '@/lib/platform/impersonate';

/**
 * Open a brand's back office. For BOTH the system owner and a platform admin the server mints a
 * brand-scoped `admin` session marked with an `act` claim (docs/42 UI-3), so the label says exactly that
 * (UI-13). Used by the console brand page and the owner's brand picker (UI-2).
 */
export function OpenBrandButton({ siteId, brandName, size = 'sm', variant = 'outline' }: {
  siteId: string;
  brandName: string;
  size?: 'sm' | 'md';
  variant?: 'outline' | 'primary';
}) {
  const impersonate = useImpersonate();
  return (
    <Button
      size={size}
      variant={variant}
      disabled={impersonate.isPending}
      onClick={() => impersonate.mutate(siteId, { onSuccess: (res) => startImpersonation(res) })}
      title={`Open ${brandName}'s back office as its admin (leave any time from the banner)`}
    >
      {impersonate.isPending ? 'Opening…' : 'Open as admin'}
    </Button>
  );
}
