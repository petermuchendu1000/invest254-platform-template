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
        subtitle="Your brand's price chart, trade interface, and payment gateways. Locked systems can be requested from the system admin."
      />
      <Section title="Available systems">
        <BrandAddons />
      </Section>
    </>
  );
}
