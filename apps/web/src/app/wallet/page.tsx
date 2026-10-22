'use client';

import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { WalletWidget } from '@/components/wallet/WalletWidget';
import { HistoryTabs } from '@/components/wallet/HistoryTabs';
import { useSession } from '@/lib/auth/session';
import { useAuthUi } from '@/lib/auth/ui';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useWalletFigures } from '@/lib/wallet/hooks';
import { useHydrated } from '@/lib/useHydrated';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { MT5Funds } from '@/components/wallet/MT5Funds';
import { MT5Screen } from '@/components/mt5/kit';

export default function WalletPage() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const openAuth = useAuthUi((s) => s.openAuth);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);
  const figures = useWalletFigures();
  // A candlestick brand's funding screen is the terminal's, not the site's generic wallet page.
  const mt5 = useTerminalSkin();

  // The title bar stays in every state: on a phone it is this screen's only navigation (MT5TitleBar).
  if (!hydrated) {
    return mt5
      ? <MT5Screen title="Funds"><div className="p-3"><Skeleton className="h-48 w-full" /></div></MT5Screen>
      : <Skeleton className="h-48 w-full" />;
  }

  if (!token) {
    const signIn = (
      <EmptyState
        title="Sign in to view your wallet"
        description="Log in to deposit, withdraw, and see your transaction history."
        action={<Button onClick={() => openAuth('login')}>Log in</Button>}
      />
    );
    return mt5 ? <MT5Screen title="Funds">{signIn}</MT5Screen> : signIn;
  }

  if (mt5) return <MT5Funds />;

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Wallet</h1>

      <WalletWidget />

      {/* DEMO-3: on the Demo account Deposit is the only money action — Withdraw is absent, not
          disabled, because play money must never be presented as cashable. */}
      <div className={figures.canWithdraw ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
        <Button size="lg" onClick={() => openDeposit()}>Deposit</Button>
        {figures.canWithdraw ? <Button size="lg" variant="secondary" onClick={openWithdraw}>Withdraw</Button> : null}
      </div>

      <h2 className="mt-2 text-base font-semibold">History</h2>
      <HistoryTabs />
    </section>
  );
}
