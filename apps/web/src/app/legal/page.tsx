'use client';

import Link from 'next/link';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { useBrand } from '@/lib/brand/BrandProvider';
import {
  legalSections, legalTitle, registerOf, type LegalBlock, type LegalSection,
} from '@/lib/legal/legalPage';
import { presentsAsTradingProduct } from '@/lib/ui/terminalScreen';

/**
 * The legal page, rendered from `lib/legal/legalPage`.
 *
 * It used to be hard-coded prose about one brand: its name, its support address and its regulator,
 * on a deployment that serves many brands, so a MuchWins trader was reading Invest254's terms and a
 * terminal user was reading a gaming operator's responsible-gaming statement. The content now comes
 * from that module, in the register the brand's own shell decides, with the brand's own name,
 * currency, licence line and support address in it.
 *
 * A client component because the brand is resolved per host at runtime; the page is static prose
 * either way, so there is nothing here to fetch.
 */
export default function LegalPage() {
  const brand = useBrand();
  const register = registerOf(presentsAsTradingProduct(brand.tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null));
  const sections = legalSections(register, {
    name: brand.name,
    licenceLine: brand.licenceLine ?? null,
    supportEmail: brand.supportEmail ?? null,
    currency: brand.currency,
  });
  const { title, standfirst } = legalTitle(register);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted">{standfirst}</p>
      </header>

      <div className="flex flex-col gap-8 md:flex-row md:items-start md:gap-10">
        {/* Sticky table of contents on desktop; inline chips on mobile. */}
        <nav aria-label="On this page" className="md:sticky md:top-20 md:w-56 md:flex-none">
          <ul className="flex flex-wrap gap-2 md:flex-col md:gap-1">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="inline-block rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-8">
          {sections.map((s) => <SectionView key={s.id} section={s} />)}

          <p className="text-xs text-muted">
            <Link href="/" className="text-accent hover:underline">
              ← Back to trading
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

function SectionView({ section }: { section: LegalSection }) {
  return (
    <section id={section.id} className="scroll-mt-20">
      <h2 className="mb-3 border-b border-border pb-2 text-lg font-semibold tracking-tight">
        {section.title}
      </h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-fg/90">
        {section.blocks.map((b, i) => <Block key={i} block={b} />)}
      </div>
    </section>
  );
}

function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'h3':
      return <h3 className="mt-2 text-sm font-semibold text-fg">{block.text}</h3>;
    case 'ul':
      return (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-fg/90">
          {block.items.map((it) => <li key={it}>{it}</li>)}
        </ul>
      );
    case 'contact':
      return (
        <p>
          {block.before}{' '}
          <a className="text-accent hover:underline" href={`mailto:${block.email}`}>{block.email}</a>
          {block.after}
        </p>
      );
    case 'helpline':
      return (
        <p>
          {block.before}{' '}
          <a className="text-accent hover:underline" href={`tel:${block.tel}`}>{block.label}</a>
          {block.after}
        </p>
      );
    default:
      return <p>{block.text}</p>;
  }
}
