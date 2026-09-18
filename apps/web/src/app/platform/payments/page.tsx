'use client';

import { PageHeader } from '@/components/admin/ui';
import { PaymentsIndex } from '@/components/platform/PaymentsIndex';

/** Payments hub — pick a gateway to open its dedicated configuration page. */
export default function PaymentsPage() {
  return (
    <>
      <PageHeader title="Payments" subtitle="Configure each deposit gateway — credentials, environment, availability, and a safe connection test. Each gateway has its own page." />
      <PaymentsIndex />
    </>
  );
}
