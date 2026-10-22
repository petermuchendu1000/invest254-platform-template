'use client';

import { useAccountUi, useMyKyc, PLAYER_TWO_FACTOR } from '@/lib/account/accountUi';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useSession } from '@/lib/auth/session';
import { useAuthUi } from '@/lib/auth/ui';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';
import { ReferralInviteCard } from '@/components/account/ReferralInviteCard';
import { SecurityCard } from '@/components/account/SecurityCard';
import { MT5AccountPanel } from '@/components/account/MT5AccountPanel';
import { MT5Settings } from '@/components/account/MT5Settings';
import { MT5Screen } from '@/components/mt5/kit';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { isTerminalScreen, isBrokerTerminalBrand } from '@/lib/ui/terminalScreen';
import { useBrand } from '@/lib/brand/BrandProvider';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { useCan } from '@/lib/auth/can';

export default function AccountPage() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const openAuth = useAuthUi((s) => s.openAuth);
  const { logout } = useAuthActions();
  // docs/42 UI-12: operators never get a referral code/link (the API refuses /me/referral for them).
  const mayEarn = useCan('earn.referrals');
  // A terminal brand gets MetaTrader's account panel; every other shell keeps the plain username card.
  const brand = useBrand();
  const { isMarketer } = useMarketerSkin();
  const terminal = isBrokerTerminalBrand(brand.tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null);
  // …and on a candlestick brand the WHOLE page is MetaTrader's Settings screen, which carries that
  // panel at its top. A marketer screen never gets terminal chrome.
  const mt5 = isTerminalScreen(terminal, isMarketer);

  /**
   * Every state of this route keeps MetaTrader's title bar, because on a phone that bar carries the
   * hamburger and is the only navigation on screen (see MT5TitleBar). A skeleton with no bar would
   * be a screen with no way off it.
   */
  if (!hydrated) {
    return mt5
      ? <MT5Screen title="Settings"><div className="p-3"><Skeleton className="h-48 w-full" /></div></MT5Screen>
      : <Skeleton className="h-48 w-full" />;
  }

  if (!token) {
    const signIn = (
      <EmptyState
        title="Account"
        action={<Button onClick={() => openAuth('login')}>Log in</Button>}
      />
    );
    return mt5 ? <MT5Screen title="Settings">{signIn}</MT5Screen> : signIn;
  }

  if (!user) {
    return mt5
      ? <MT5Screen title="Settings"><div className="p-3"><Skeleton className="h-48 w-full" /></div></MT5Screen>
      : <Skeleton className="h-48 w-full" />;
  }

  if (mt5) return <MT5Settings />;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <Button variant="secondary" size="sm" onClick={logout}>
          Log out
        </Button>
      </div>

      {terminal ? (
        <MT5AccountPanel />
      ) : (
        <Card className="flex flex-col gap-3">
          <Row label="Username" value={`@${user.username}`} />
        </Card>
      )}

      {/* Referral link + code, right under the username (item 3) — players and marketers only (UI-12) */}
      {mayEarn ? <ReferralInviteCard /> : null}

      {/* ACCT-1: player security + identity (operators manage 2FA in the card below). */}
      {user.role === 'player' || user.role === 'marketer' ? <PlayerSecurityCard /> : null}

      {/* Admin/operator security controls (2FA management) — hidden for players. */}
      <SecurityCard />
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-fg">{value}</span>
    </div>
  );
}

function PlayerSecurityCard() {
  const open = useAccountUi((s) => s.open);
  const kyc = useMyKyc();
  const st = kyc.data?.status ?? 'none';
  const label = st === 'approved' ? 'Verified' : st === 'pending' ? 'In review' : st === 'rejected' ? 'Not approved' : 'Not verified';
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-fg">{PLAYER_TWO_FACTOR ? 'Security & identity' : 'Identity'}</h2>
      {PLAYER_TWO_FACTOR ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted">Two-factor authentication</span>
          <Button variant="secondary" size="sm" onClick={() => open('twofactor')}>Manage</Button>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted">{PLAYER_TWO_FACTOR ? 'Identity · ' : null}<span className={st === 'approved' ? 'text-up' : st === 'rejected' ? 'text-down' : 'text-fg'}>{label}</span></span>
        {/* "View" for anything already sent, not just an approval: a pending submission has nothing
                  left to do and inviting a second one is the defect this screen had. */}
        <Button variant="secondary" size="sm" onClick={() => open('verify')}>{st === 'approved' || st === 'pending' ? 'View' : 'Verify'}</Button>
      </div>
    </Card>
  );
}
