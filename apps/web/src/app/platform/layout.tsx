import type { Metadata } from 'next';
import { PlatformShell } from '@/components/platform/PlatformShell';
import { requireOperatorHost } from '@/lib/brand/operatorGuard';

export const metadata: Metadata = { title: 'Platform' };

// The platform console runs in its own operator shell: a left sidebar + ⌘K command palette,
// gated by capability (docs/42): console.enter = platform admin + system owner; everyone else gets a 404.
// It is also gated by HOST — the operator domain only, which is checked before the shell renders so a
// brand domain never serves the sign-in form. See `requireOperatorHost`.
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  requireOperatorHost();
  return <PlatformShell>{children}</PlatformShell>;
}
