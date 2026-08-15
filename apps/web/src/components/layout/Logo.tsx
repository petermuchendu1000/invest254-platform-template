'use client';

import Link from 'next/link';
import { useId } from 'react';
import { useBrand } from '@/lib/brand/BrandProvider';
import { brandWordmark } from '@/lib/brand/brand';
import { buildMarkSvg, markVariant, MARK_COLORS_LIVE } from '@/lib/brand/mark';

/**
 * Brand mark — a THEME-AWARE vector rendered from the design tokens via CSS variables
 * (var(--pp-brand/--pp-accent/--pp-accent-fg)), so it recolours instantly when the brand theme or
 * light/dark changes and stays crisp at every size (phone → desktop). The SHAPE is chosen per brand
 * from `seed` (the slug) so clients look distinct while their colours always follow the theme. The
 * same generator (lib/brand/mark) bakes the favicon, so tab icon and in-app logo always match.
 */
export function LogoMark({ className = 'h-7 w-7', seed = '' }: { className?: string; seed?: string }) {
  const uid = useId();
  const svg = buildMarkSvg(MARK_COLORS_LIVE, { variant: markVariant(seed), idSuffix: uid, fluid: true });
  return (
    <span
      className={`inline-block shrink-0 ${className}`}
      aria-hidden
      // The mark is pure vector coloured by CSS vars; inlining lets it inherit the live theme tokens.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Brand lockup — a brand's uploaded logo image when set, else the theme-aware mark + wordmark. */
export function Logo({ className = '' }: { className?: string }) {
  const brand = useBrand();
  const wordmark = brandWordmark(brand);
  // Only treat a raster/hosted URL as a custom logo override; the default is the theme-aware mark.
  const custom = brand.logoUrl && !brand.logoUrl.startsWith('data:image/svg') ? brand.logoUrl : null;
  return (
    <Link
      href="/"
      aria-label={`${brand.name} home`}
      className={`flex items-center gap-2 text-fg ${className}`}
    >
      {custom ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={custom} alt={brand.name} className="h-7 w-auto max-w-[160px] object-contain" />
      ) : (
        <LogoMark seed={brand.slug} />
      )}
      <span className="text-base font-extrabold leading-none tracking-tight text-fg">
        {wordmark}
      </span>
    </Link>
  );
}
