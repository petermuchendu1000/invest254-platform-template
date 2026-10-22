import type { Metadata } from 'next';
import { AdminShell } from '@/components/admin/AdminShell';
import { ImpersonationBanner } from '@/components/platform/ImpersonationBanner';
import { requireOperatorHost } from '@/lib/brand/operatorGuard';

export const metadata: Metadata = { title: 'Admin' };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // The brand back office is on the operator domain only — see `requireOperatorHost`. This covers
  // every `/admin/**` page, including the ones impersonation lands on (it navigates same-origin, so
  // an operator who got here from `/platform` is already on an allowed host).
  requireOperatorHost();
  return (
    <>
      <ImpersonationBanner />
      <AdminShell>{children}</AdminShell>
    </>
  );
}
