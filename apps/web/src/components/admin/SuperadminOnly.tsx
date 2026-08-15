'use client';

import * as React from 'react';
import { useSession } from '@/lib/auth/session';

/** Gate for owner-only governance pages. Renders children for the system owner — the per-brand
 *  `superadmin` AND the cross-brand `platform_superadmin`, which OUTRANKS superadmin in the role
 *  hierarchy (ROLE_RANK: superadmin=4 < platform_superadmin=5) and is what the API's
 *  requireRole("superadmin") and AdminShell's `isSuper` already admit. Any lower admin sees a clear
 *  authority notice. The API enforces this too — this is UX clarity. Must mirror the hierarchy, not
 *  a strict `=== 'superadmin'`, or the higher platform_superadmin gets locked out of controls it owns. */
const OWNER_ROLES = new Set(['superadmin', 'platform_superadmin']);
export function SuperadminOnly({ children }: { children: React.ReactNode }) {
  const role = useSession((s) => s.user?.role);
  if (!role || !OWNER_ROLES.has(role)) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-warn/50 bg-warn/5 p-8 text-center">
        <span className="text-2xl">★</span>
        <p className="text-sm font-semibold text-fg">Owner-only area</p>
        <p className="max-w-md text-sm text-muted">
          This is a system-governance setting reserved for the superadmin (system owner). Operators don&apos;t have access —
          contact the owner if a change is required here.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
