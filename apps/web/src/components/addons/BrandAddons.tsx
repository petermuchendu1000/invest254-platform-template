'use client';

import { useCan } from '@/lib/auth/can';
import { Section } from '@/components/admin/ui';
import { AddonMarketplace, RequestHistory } from './Marketplace';

/**
 * One brand's add-ons (ADDON-1): the marketplace plus the brand's request history.
 * - Brand admin (/admin/systems): no siteId — the server resolves its own brand from the token.
 * - Platform admin (brand page tab / Add-ons page): siteId of a brand in its platform; requests and switches.
 * - System owner (brand page tab): assigns, removes and reviews directly.
 */
export function BrandAddons({ siteId }: { siteId?: string }) {
  const owner = useCan('console.system') && !!siteId;
  const platformTier = useCan('console.enter');
  return (
    <div className="flex flex-col gap-6">
      <AddonMarketplace {...(siteId ? { siteId } : {})} owner={owner} canSetUpGateways={platformTier} />
      <Section title="Requests">
        <RequestHistory {...(siteId ? { siteId } : {})} emptyText="Requests you send to the System owner, and their answers, show here." />
      </Section>
    </div>
  );
}
