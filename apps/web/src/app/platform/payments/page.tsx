'use client';

import { PageHeader } from '@/components/admin/ui';
import { PaymentsIndex } from '@/components/platform/PaymentsIndex';

/** Payments hub — pick a gateway to open its dedicated configuration page. */
export default function PaymentsPage() {
  return (
    <>
      <PageHeader title="Gateways" subtitle="The payment gateways the System accounts accept, and whether players are offered each one." />
      <PaymentsIndex />
    </>
  );
}
