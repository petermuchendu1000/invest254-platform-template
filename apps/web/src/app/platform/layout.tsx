import type { Metadata } from 'next';
import { PlatformShell } from '@/components/platform/PlatformShell';

export const metadata: Metadata = { title: 'Platform' };

// The platform console runs in its own operator shell: a left sidebar + ⌘K command palette,
// gated strictly to platform_superadmin (a plain admin lands on the "platform owner only" gate).
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
