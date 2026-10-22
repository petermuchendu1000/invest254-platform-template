import type { Metadata } from 'next';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { currentBrand } from '@/lib/brand/currentBrand';
import { legalTitle, registerOf } from '@/lib/legal/legalPage';
import { presentsAsTradingProduct } from '@/lib/ui/terminalScreen';

/**
 * The page's own `<title>`, which its content cannot set: the page is a client component, because
 * the brand is resolved per host at runtime, and a client component may not export `metadata`.
 *
 * The title follows the same register the content does, so a broker's tab does not read
 * "Responsible Gaming" while the page under it reads "Risk disclosure".
 */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await currentBrand();
  const register = registerOf(presentsAsTradingProduct(brand.tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null));
  const { title, standfirst } = legalTitle(register);
  return { title, description: `${brand.name}: ${standfirst}` };
}

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
