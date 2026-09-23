'use client';

import * as React from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePlatformSites } from '@/lib/platform/hooks';
import { OpenBrandButton } from '@/components/platform/OpenBrandButton';

/**
 * docs/42 UI-2 (owner decision, 2026-09-23): the system owner works a brand's back office ONLY after
 * choosing the brand — every brand-level action then has an explicit brand (the opened session is a
 * brand `admin` session, `act`-marked). This replaces the old unscoped owner back office whose lists
 * mixed every brand while its settings silently wrote brand #1. Global settings live in the console.
 */
export function BrandPicker() {
  const sites = usePlatformSites();
  const [q, setQ] = React.useState('');
  const all = sites.data?.sites ?? [];
  const needle = q.trim().toLowerCase();
  const rows = needle
    ? all.filter((s) => [s.name, s.slug, s.primaryDomain ?? ''].some((v) => v.toLowerCase().includes(needle)))
    : all;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Choose a brand to open</h1>
        <p className="mt-1 text-sm text-muted">
          The back office always works on one brand, so every change lands where you intend. You&apos;ll enter it
          as its admin and can leave from the banner at any time. System-wide settings live in the{' '}
          <Link href="/platform" className="text-accent underline-offset-2 hover:underline">system console</Link>.
        </p>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search brands by name, slug or domain…"
        aria-label="Search brands"
        className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
      />
      {sites.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{all.length === 0 ? 'No brands yet — onboard one from the console.' : 'No brand matches that search.'}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface" aria-label="Brands">
          {rows.map((s) => (
            <li key={s.siteId} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{s.name}</p>
                <p className="truncate text-xs text-muted">{s.slug}{s.primaryDomain ? ` · ${s.primaryDomain}` : ''} · {s.status}</p>
              </div>
              <OpenBrandButton siteId={s.siteId} brandName={s.name} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
