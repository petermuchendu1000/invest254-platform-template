'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { RequireCapability } from '@/components/auth/RequireCapability';
import { PageHeader } from '@/components/admin/ui';
import { PaymentAccounts } from '@/components/platform/PaymentAccounts';

/** PAY-1 (docs/43): whose gateway accounts a platform's / brand's money flows through. */
function Inner() {
  const sp = useSearchParams();
  const raw = sp.get('scope') ?? '';
  const [t, id] = raw.split(':');
  const initial = (t === 'platform' || t === 'site') && id ? { type: t, id } as const : undefined;
  return (
    <>
      <PageHeader title="Payment accounts" subtitle="Run your brands on the System's payment accounts, or bring your own M-Pesa / gateway accounts — for the whole platform or one brand." />
      <PaymentAccounts initialScope={initial} />
    </>
  );
}

export default function PaymentAccountsPage() {
  return (
    <RequireCapability cap="console.payment_accounts" title="Payment accounts are for platform admins">
      <Suspense fallback={null}><Inner /></Suspense>
    </RequireCapability>
  );
}
