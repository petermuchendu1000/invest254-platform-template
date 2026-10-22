'use client';

import Link from 'next/link';
import { useBrand } from '@/lib/brand/BrandProvider';
import { CurrencySwitcher } from '@/components/layout/CurrencySwitcher';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { registerOf, riskAnchor } from '@/lib/legal/legalPage';
import { presentsAsTradingProduct } from '@/lib/ui/terminalScreen';

// Global footer: risk messaging, 18+ badge and legal links.
// Required by FE7 (responsible gaming is first-class, not an afterthought).
// MARKETER: the 18+ / "trading involves real money & risk" / licence / gambling-helpline content is
// exactly what flags a TikTok Live — it is hidden for marketers, leaving only Terms/Privacy/Support.
//
// REGISTER: a brand whose shell is the MetaTrader terminal is a broker, not a gaming operator. It
// keeps the 18+ badge and the risk line, which a broker owes its traders just as much, and it links
// to the risk disclosure rather than a responsible-gaming statement. The statutory gambling
// helpline is a GAMING obligation and is not printed on a broker's footer: a number for a service
// that does not cover what the reader is doing is worse than none. See lib/legal/legalPage.
export function Footer() {
  const brand = useBrand();
  const { isMarketer } = useMarketerSkin();
  const register = registerOf(presentsAsTradingProduct(brand.tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null));
  const gaming = register === 'gaming';
  const year = new Date().getFullYear();
  return (
    <footer className="mt-8 border-t border-border bg-surface/60">
      <div className="mx-auto flex w-full max-w-app flex-col gap-4 px-4 py-6">
        {isMarketer ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="inline-flex h-7 items-center rounded-full border border-down px-2 text-xs font-bold text-down"
              aria-label="Eighteen plus only"
            >
              18+
            </span>
            <p className="text-xs leading-relaxed text-muted">
              Trading involves real money and risk. Only stake what you can afford to lose.
            </p>
          </div>
        )}

        <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
          {isMarketer ? null : (
            <Link href={`/legal#${riskAnchor(register)}`} className="text-muted hover:text-fg">
              {gaming ? 'Responsible Gaming' : 'Risk disclosure'}
            </Link>
          )}
          <Link href="/legal#terms" className="text-muted hover:text-fg">
            Terms
          </Link>
          <Link href="/legal#privacy" className="text-muted hover:text-fg">
            Privacy
          </Link>
          {isMarketer ? null : (
            <Link href="/legal#licence" className="text-muted hover:text-fg">
              Licence
            </Link>
          )}
          {brand.supportEmail ? (
            <a href={`mailto:${brand.supportEmail}`} className="text-muted hover:text-fg">
              Support
            </a>
          ) : null}
          {isMarketer || !gaming ? null : (
            <a href="tel:1190" className="text-muted hover:text-fg">
              Helpline 1190
            </a>
          )}
        </nav>

        {!isMarketer && brand.licenceLine ? (
          <p className="text-[11px] text-muted">{brand.licenceLine}</p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted">
            © {year} {brand.name}
          </p>
          {/* #10 geo-currency: display-currency picker (presentation only; balances stay in KES). */}
          <CurrencySwitcher />
        </div>
      </div>
    </footer>
  );
}
