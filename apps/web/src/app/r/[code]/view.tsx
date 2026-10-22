'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useBrand } from '@/lib/brand/BrandProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthUi } from '@/lib/auth/ui';
import { useSession } from '@/lib/auth/session';
import { storeReferral } from '@/lib/auth/referral';
import { api } from '@/lib/api/endpoints';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { registerOf, riskAnchor } from '@/lib/legal/legalPage';
import { presentsAsTradingProduct } from '@/lib/ui/terminalScreen';

// Referral landing: capture the code, then route the visitor into sign-up with it
// prefilled. Attribution is finalised server-side at registration (first-touch).
export default function ReferralLandingPage({ params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const openAuth = useAuthUi((s) => s.openAuth);
  const token = useSession((s) => s.token);

  useEffect(() => {
    storeReferral(code);
    // Funnel stage 0: record the click (fire-and-forget; tolerant server-side, never blocks the page).
    const host = typeof window !== 'undefined' ? window.location.hostname : undefined;
    void api.recordAffiliateClick(code, host).catch(() => {});
  }, [code]);

  const brand = useBrand();
  const register = registerOf(presentsAsTradingProduct(brand.tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null));
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-5 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent text-2xl font-bold text-accent-fg">
        {(brand.name || '?').charAt(0).toUpperCase()}
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">{brand.name}</h1>

      <Card className="flex w-full flex-col items-center gap-1">
        <span className="text-xs text-muted">Invite code</span>
        <span className="font-mono text-lg font-semibold tracking-widest text-fg">{code}</span>
      </Card>

      {token ? (
        <div className="flex flex-col items-center gap-2">
          <Link href="/">
            <Button>Go to trading</Button>
          </Link>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-2">
          <Button onClick={() => openAuth('register')} fullWidth size="lg">
            Create account
          </Button>
          <button
            onClick={() => openAuth('login')}
            className="text-sm text-muted hover:text-fg"
          >
            Already have an account? Log in
          </button>
        </div>
      )}

      {/* A broker owes the same age gate and the same warning; what differs is the word for what
          the visitor is about to do, and where the disclosure lives. See lib/legal/legalPage. */}
      <p className="text-xs text-muted">
        18+ only. {register === 'gaming' ? 'Play responsibly' : 'Trading carries risk'},{' '}
        <Link href={`/legal#${riskAnchor(register)}`} className="text-accent hover:underline">
          learn more
        </Link>
        .
      </p>
    </section>
  );
}
