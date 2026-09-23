'use client';

import * as React from 'react';
import type { Capability } from '@invest254/shared/capabilities';
import { useCan } from '@/lib/auth/can';

/**
 * docs/42 P1 — renders `children` only for sessions that hold `cap`; otherwise an explicit, calm
 * "not available here" card (never a broken page that 403s after it loads). Use for whole pages;
 * for single controls, branch on `useCan(cap)` and render nothing.
 */
export function RequireCapability({ cap, children, title = 'Not available in this session', hint }: {
  cap: Capability;
  children: React.ReactNode;
  title?: string;
  hint?: React.ReactNode;
}) {
  if (useCan(cap)) return <>{children}</>;
  return (
    <div role="note" className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-surface p-6 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      <p className="mt-2 text-sm text-muted">
        {hint ?? 'This area belongs to a different tier. The system owner manages it from the system console.'}
      </p>
    </div>
  );
}
