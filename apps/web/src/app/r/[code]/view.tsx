'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthUi } from '@/lib/auth/ui';
import { useSession } from '@/lib/auth/session';
import { storeReferral } from '@/lib/auth/referral';
import { api } from '@/lib/api/endpoints';

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

  return (
    <section className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-5 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent text-2xl font-bold text-accent-fg">
        P
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">You&apos;re invited to Invest254</h1>
        <p className="text-sm leading-relaxed text-muted">
          Predict BUY/SELL on the live BTC/KES curve and win in real Kenyan Shillings. Sign up with
          this invite to get started.
        </p>
      </div>

      <Card className="flex w-full flex-col items-center gap-1">
        <span className="text-xs text-muted">Your invite code</span>
        <span className="font-mono text-lg font-semibold tracking-widest text-fg">{code}</span>
        <span className="text-xs text-muted">It&apos;s applied automatically at sign-up.</span>
      </Card>

      {token ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-muted">You&apos;re already signed in.</p>
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

      <p className="text-xs text-muted">
        18+ only. Play responsibly —{' '}
        <Link href="/legal#responsible-gaming" className="text-accent hover:underline">
          learn more
        </Link>
        .
      </p>
    </section>
  );
}
