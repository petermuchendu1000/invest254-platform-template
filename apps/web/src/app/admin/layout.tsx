import type { Metadata } from 'next';
import { AdminShell } from '@/components/admin/AdminShell';
import { ImpersonationBanner } from '@/components/platform/ImpersonationBanner';

export const metadata: Metadata = { title: 'Admin' };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ImpersonationBanner />
      <AdminShell>{children}</AdminShell>
    </>
  );
}
