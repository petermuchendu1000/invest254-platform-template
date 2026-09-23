import type { Metadata } from 'next';
import { PlatformShell } from '@/components/platform/PlatformShell';

export const metadata: Metadata = { title: 'Platform' };

// The platform console runs in its own operator shell: a left sidebar + ⌘K command palette,
// gated by capability (docs/42): console.enter = platform admin + system owner; everyone else gets a 404.
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
