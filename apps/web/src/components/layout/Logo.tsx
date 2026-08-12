'use client';

import Link from 'next/link';
import { useBrand } from '@/lib/brand/BrandProvider';
import { brandWordmark } from '@/lib/brand/brand';

/** Brand colours (Kenyan-flag inspired) — fixed in both themes. The navy elements adapt to the
 *  theme via `currentColor` (dark on light backgrounds, light on dark) so the mark always reads. */
const GREEN = '#1F9E4D';
const RED = '#D62B2B';

/**
 * invest254 chart mark: three ascending bars (navy · green · red) with a white growth arrow
 * sweeping up through the green and red bars. The navy bar + wordmark text use `currentColor`,
 * so the caller's text colour (`text-fg`) drives light/dark theming; green, red and the white
 * arrow are fixed brand colours that stay legible on either background. The arrow is kept over
 * the saturated green/red bars only, so white never lands on a light surface.
 */
export function LogoMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={`shrink-0 ${className}`} role="img" aria-hidden fill="none">
      {/* Navy bar (shortest) — theme-adaptive. */}
      <path d="M6 41 L8 28 L15 28 L13 41 Z" fill="currentColor" />
      {/* Green bar (medium). */}
      <path d="M16 41 L18 19 L26 19 L24 41 Z" fill={GREEN} />
      {/* Red bar (tallest). */}
      <path d="M27 41 L29 8 L40 8 L38 41 Z" fill={RED} />
      {/* Growth arrow — white, confined to the green/red bars. */}
      <path
        d="M17 38 C 23 36 27 30 31 22 S 36 12 38 9.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Arrowhead pointing up-right at the tip of the red bar. */}
      <path d="M39.5 8 L30.5 10.2 L36.4 16.3 Z" fill="#FFFFFF" />
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
