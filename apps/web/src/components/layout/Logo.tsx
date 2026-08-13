'use client';

import Link from 'next/link';
import { useBrand } from '@/lib/brand/BrandProvider';
import { brandWordmark } from '@/lib/brand/brand';

/** invest254 chart mark: three ascending bars + a growth arrow. Colours are brand-driven via the
 *  design tokens (bars: muted → brand → accent; arrow: success/up), so the mark re-skins per brand
 *  from the same palette as the rest of the UI. A brand may still override with its own logo_url. */
export function LogoMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={`shrink-0 ${className}`} role="img" aria-hidden fill="none">
      {/* Shortest bar — neutral. */}
      <path d="M6 41 L8 28 L15 28 L13 41 Z" style={{ fill: 'var(--pp-muted)' }} />
      {/* Medium bar — brand primary. */}
      <path d="M16 41 L18 19 L26 19 L24 41 Z" style={{ fill: 'var(--pp-brand)' }} />
      {/* Tallest bar — accent. */}
      <path d="M27 41 L29 8 L40 8 L38 41 Z" style={{ fill: 'var(--pp-accent)' }} />
      {/* Growth arrow — success/up, confined to the brand/accent bars. */}
      <path
        d="M17 38 C 23 36 27 30 31 22 S 36 12 38 9.5"
        fill="none"
        style={{ stroke: 'var(--pp-up)' }}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Arrowhead at the tip of the tallest bar. */}
      <path d="M39.5 8 L30.5 10.2 L36.4 16.3 Z" style={{ fill: 'var(--pp-up)' }} />
    </svg>
  );
}

/** Brand lockup — the brand's logo image when set, else the chart mark + brand wordmark. */
export function Logo({ className = '' }: { className?: string }) {
  const brand = useBrand();
  const wordmark = brandWordmark(brand);
  return (
    <Link
      href="/"
      aria-label={`${brand.name} home`}
      className={`flex items-center gap-2 text-fg ${className}`}
    >
      {brand.logoUrl ? (
        // Brand-provided logo (served from the sites row). Height-constrained; width auto.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logoUrl} alt={brand.name} className="h-7 w-auto max-w-[160px] object-contain" />
      ) : (
        <LogoMark />
      )}
      <span className="text-base font-extrabold leading-none tracking-tight text-fg">
        {wordmark}
      </span>
    </Link>
  );
}
