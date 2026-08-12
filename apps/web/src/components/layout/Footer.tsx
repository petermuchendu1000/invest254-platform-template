'use client';

import Link from 'next/link';
import { useBrand } from '@/lib/brand/BrandProvider';

// Global footer: responsible-gaming messaging, 18+ badge and legal links.
// Required by FE7 (responsible gaming is first-class, not an afterthought).
export function Footer() {
  const brand = useBrand();
  const year = new Date().getFullYear();
  return (
    <footer className="mt-8 border-t border-border bg-surface/60">
      <div className="mx-auto flex w-full max-w-app flex-col gap-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="inline-flex h-7 items-center rounded-full border border-down px-2 text-xs font-bold text-down"
            aria-label="Eighteen plus only"
          >
            18+
          </span>
          <p className="text-xs leading-relaxed text-muted">
            Trading involves real money and risk. Play responsibly — only stake what you can afford
            to lose. Must be 18 or older.
          </p>
        </div>

        <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
          <Link href="/legal#responsible-gaming" className="text-muted hover:text-fg">
            Responsible Gaming
          </Link>
          <Link href="/legal#terms" className="text-muted hover:text-fg">
            Terms
          </Link>
          <Link href="/legal#privacy" className="text-muted hover:text-fg">
            Privacy
          </Link>
          <Link href="/legal#licence" className="text-muted hover:text-fg">
            Licence
          </Link>
          {brand.supportEmail ? (
            <a href={`mailto:${brand.supportEmail}`} className="text-muted hover:text-fg">
              Support
            </a>
          ) : null}
          <a href="tel:1190" className="text-muted hover:text-fg">
            Helpline 1190
          </a>
        </nav>

        {brand.licenceLine ? (
          <p className="text-[11px] text-muted">{brand.licenceLine}</p>
        ) : null}
        <p className="text-[11px] text-muted">
          © {year} {brand.name}. Self-control is the best game plan.
        </p>
      </div>
    </footer>
  );
}
