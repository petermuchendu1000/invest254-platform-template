'use client';

import { useCan } from '@/lib/auth/can';
import { usePlatforms } from '@/lib/platform/hooks';

export const DEFAULT_PLATFORM_ID = '10000000-0000-0000-0000-000000000001';

/**
 * docs/42 UI-9 — "which platform am I acting for?" for the System admin. Platform-scoped console tools
 * (registrar, domain import, pool) used to act silently on the default platform (or on everything) for
 * the owner. Rendered ONLY for the System admin (a platform admin is pinned to its own platform by the
 * API, so it never sees a picker). Always shows the choice explicitly — no hidden default (mode errors).
 */
export function OwnerPlatformPicker({ value, onChange, label = 'Acting for platform', hint }: {
  value: string; onChange: (platformId: string) => void; label?: string; hint?: string;
}) {
  const isSystem = useCan('console.system');
  const q = usePlatforms(isSystem);
  if (!isSystem) return null;
  const platforms = q.data?.platforms ?? [];
  return (
    <label className="flex max-w-md flex-col gap-1.5 text-sm">
      <span className="font-medium text-fg">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full rounded-brand border border-border bg-surface-2 px-3 text-fg"
      >
        {platforms.length === 0 ? <option value={DEFAULT_PLATFORM_ID}>Default platform</option> : null}
        {platforms.map((p) => <option key={p.platformId} value={p.platformId}>{p.name} ({p.slug})</option>)}
      </select>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
