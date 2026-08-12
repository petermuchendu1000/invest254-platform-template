import type { Metadata } from 'next';
import { AdminShell } from '@/components/admin/AdminShell';

export const metadata: Metadata = { title: 'Platform' };

// The platform console reuses the admin chrome (sidebar). AdminShell admits platform_superadmin
// and shows the Platform nav section; a plain admin lands on the "not authorised" gate.
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
