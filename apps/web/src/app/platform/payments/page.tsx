'use client';

import { PageHeader } from '@/components/admin/ui';
import { PaymentsIndex } from '@/components/platform/PaymentsIndex';

/** Payments hub — pick a gateway to open its dedicated configuration page. */
export default function PaymentsPage() {
  return (
    <>
      <PageHeader title="Gateways" />
      <PaymentsIndex />
    </>
  );
}
