'use client';

import { PageHeader, Section } from '@/components/admin/ui';
import { BrandAddons } from '@/components/addons/BrandAddons';

/**
 * Site-admin view of its brand's add-on systems (Issue 2). Charts / trade UI / gateways with their
 * locked / owned / active state; locked ones are requested from the system admin. No siteId — the
 * server resolves the admin's own brand from its token.
 */
export default function AdminSystemsPage() {
  return (
    <>
      <PageHeader
        title="Add-ons & gateways"
      />
      <Section>
        <BrandAddons />
      </Section>
    </>
  );
}
