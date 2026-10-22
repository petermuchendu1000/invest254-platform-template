'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SUPPORTED_DISPLAY_CURRENCIES } from '@invest254/shared/geo';
import { useAccountUi, useMyKyc, PLAYER_TWO_FACTOR } from '@/lib/account/accountUi';
import { useSession } from '@/lib/auth/session';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useBrand } from '@/lib/brand/BrandProvider';
import { readCurrencyCookie, writeCurrencyCookie } from '@/lib/brand/currency';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { useSound } from '@/lib/sound/sound';
import { applyTheme, currentTheme } from '@/lib/ui/theme';
import { useCan } from '@/lib/auth/can';
import { useReferral } from '@/lib/affiliate/hooks';
import { useDisplayMoney } from '@/lib/money';
import { useToast } from '@/lib/toast/ToastProvider';
import { MT5AccountPanel } from '@/components/account/MT5AccountPanel';
import { useWallet, useWalletFigures } from '@/lib/wallet/hooks';
import { mt5ServerName } from '@/lib/brand/mt5Server';
import { aboutRows, kycSub, kycTone } from '@/lib/account/mt5settings';
import { useRegister } from '@/lib/ui/useRegister';
import { MT5TitleBar, MT5Section as Section, MT5Row as Row } from '@/components/mt5/kit';
import { cn } from '@/lib/cn';

/**
 * MetaTrader 5's Settings screen.
 *
 * Built against the product's own screen (metatrader5.com/en/mobile-trading/android/help/settings):
 * a plain title bar, then groups under small uppercase headings, each row a label over the CURRENT
 * VALUE in grey, with a checkbox or a blue value on the right. MetaTrader puts the state in the
 * sub-label rather than in a switch, so you can read the whole screen's settings at a glance without
 * decoding a column of toggles — which is why the sub-label is never decoration here.
 *
 * The account sits at the top, as MetaTrader's own account screen does, and is the panel that was
 * already built for it.
 *
 * Every row does something real. MetaTrader's own list has entries this product has no equivalent
 * for — MetaQuotes ID, notification ringtone, tablet interface — and they are absent rather than
 * drawn as rows that go nowhere.
 */
export function MT5Settings() {
  const user = useSession((s) => s.user);
  const brand = useBrand();
  const { isMarketer } = useMarketerSkin();
  // A broker's Settings owes a risk disclosure, not a responsible-gaming page. See lib/ui/register.
  const { register } = useRegister();
  const { logout } = useAuthActions();
  const openDialog = useAccountUi((s) => s.open);
  const kyc = useMyKyc();
  const mayEarn = useCan('earn.referrals');
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <div className="flex flex-1 flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)]">
      {/* MetaTrader's Settings title bar is a single line — there is no second instrument-filter
          line the way the History screen has one. */}
      <MT5TitleBar title="Settings" back />

      {/* The title bar is full-bleed, as the terminal's chrome is; the settings themselves are a
          reading column — MetaTrader's own settings on a wide window are a panel, not an edge-to-edge
          list with the value a thousand pixels from its label. */}
      <div className="mx-auto w-full lg:max-w-3xl">
        {/*
          MetaTrader's phone puts the account at the top of Settings as a CARD, not as a panel with a
          blue header of its own: *"Account card (top): `John Smith` / `40739870 - MetaQuotes-Demo` /
          `Access Point EU 3`, with a green "Demo" corner ribbon and a chevron -> opens saved-accounts
          management"* (docs/mt5/04-mobile-app.md section 7).

          The panel below IS that saved-accounts management, so on a phone it waits behind the card
          rather than stacking a third blue band under the title bar and pushing every setting off
          the first screen. On a wide window there is room for both and the panel stays open, which
          is MetaTrader's desktop "Trading accounts" dialog.
        */}
        <div className="lg:hidden">
          <AccountCard open={accountOpen} onToggle={() => setAccountOpen((v) => !v)} />
          {accountOpen ? (
            <div className="border-b border-[var(--mt5-border)] p-3">
              <MT5AccountPanel embedded />
            </div>
          ) : null}
        </div>
        <div className="hidden p-3 lg:block">
          <MT5AccountPanel />
        </div>

      <Section title="Security">
        {PLAYER_TWO_FACTOR ? (
          <Row
            label="Two-factor authentication"
            sub="Ask for a code from your authenticator at sign-in"
            onClick={() => openDialog('twofactor')}
            chevron
          />
        ) : null}
        <Row
          label="Identity verification"
          sub={kycSub(kyc.data?.status)}
          subTone={kycTone(kyc.data?.status)}
          onClick={() => openDialog('verify')}
          chevron
        />
      </Section>

      {mayEarn ? <ReferralSection /> : null}

      <InterfaceSection />

      <Section title="About">
        {aboutRows(isMarketer, register).map((r) => (
          <Row key={r.id} label={r.label} sub={r.sub} href={r.href} chevron />
        ))}
        {/* No problem-gambling helpline here, and the row is GONE rather than conditional.
            It was written as `isMarketer || register === 'trading' ? null : <Row …>`, and on this
            screen both halves of that test are constants: `MT5Settings` renders only when
            `isTerminalScreen(terminal, isMarketer)` holds, which already means `terminal && not a
            marketer`, and `register` is `registerOf(terminal)`, which is `'trading'` for exactly
            that case. So the row could never draw, and a condition that cannot be false reads like
            a feature that is sometimes there. The reason it should not draw is unchanged and is
            worth keeping: a helpline for a service that does not cover what this reader is doing is
            worse than none. A gambling shell has its own settings screen and the footer's own row. */}
        {/* No "Operated under licence." fallback: a brand that publishes no licence line has not
            told us it is licensed, and saying so for it would be the platform inventing a claim
            about its own operator. */}
        <Row
          label="Operated by"
          sub={brand.licenceLine?.trim() ? brand.licenceLine : 'No licence details published. Ask support.'}
          value={brand.name || brand.slug}
        />
      </Section>

      <Section title="Session">
        {user ? <Row label="Signed in" sub="This device" value={`@${user.username}`} /> : null}
        <Row label="Log out" tone="bad" onClick={logout} />
      </Section>

        <div className="h-6" />
      </div>
    </div>
  );
}

/**
 * MetaTrader's account card: who you are, the login and server under it, and the account's own
 * balance, with the Demo/Real tag MetaTrader draws as a corner ribbon.
 *
 * Three lines and a chevron, because that is what MetaTrader's card is. The access point it prints
 * on its third line has no equivalent here, so the line carries the balance, which is the figure
 * this card is actually consulted for.
 */
function AccountCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const user = useSession((s) => s.user);
  const { data: wallet } = useWallet();
  const figures = useWalletFigures();
  const brand = useBrand();
  const money = useDisplayMoney();

  if (!user) return null;
  const demo = figures.demo;
  const server = mt5ServerName(brand, demo ? 'demo' : 'real');
  const balanceCents = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-3 border-b border-[var(--mt5-border)] px-3 py-3 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[15px] font-semibold leading-tight text-[var(--mt5-text)]">{user.username}</span>
          <span className="shrink-0 rounded-sm bg-[var(--mt5-border)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--mt5-muted)]">
            {demo ? 'Demo' : 'Real'}
          </span>
        </span>
        <span className="mt-0.5 block truncate font-mono text-[12px] leading-tight text-[var(--mt5-muted)]">
          {user.userId} - {server}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[13px] leading-tight text-[var(--mt5-blue-link)]">
          {money.fmt(balanceCents)}
        </span>
      </span>
      <span aria-hidden className={cn('shrink-0 text-[var(--mt5-muted)] transition-transform', open && 'rotate-90')}>&#8250;</span>
    </button>
  );
}

function ReferralSection() {
  const { data: r } = useReferral();
  const { fmt } = useDisplayMoney();
  const toast = useToast();
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  if (!r || !r.referralCode) return null;
  const link = typeof window !== 'undefined' && r.referralPath ? `${window.location.origin}${r.referralPath}` : (r.referralPath ?? '');

  const copy = async (text: string, what: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      toast.push({ tone: 'error', title: 'Copy failed' });
    }
  };

  return (
    <Section title="Invite &amp; earn">
      <Row
        label="Your referral code"
        sub={r.earnedCents > 0 ? `Earned ${fmt(r.earnedCents)} so far` : 'You earn 5% of every deposit by someone you invite'}
        value={copied === 'code' ? 'Copied' : r.referralCode}
        onClick={() => void copy(r.referralCode!, 'code')}
      />
      {link ? (
        <Row
          label="Invite link"
          sub={link}
          value={copied === 'link' ? 'Copied' : 'Copy'}
          onClick={() => void copy(link, 'link')}
        />
      ) : null}
    </Section>
  );
}

/**
 * MetaTrader's Interface group. Theme and sound are per-device preferences the app already stored;
 * this is the first screen that shows their current state in words rather than as a bare icon.
 */
function InterfaceSection() {
  const brand = useBrand();
  const router = useRouter();
  const muted = useSound((s) => s.muted);
  const toggleSound = useSound((s) => s.toggle);

  // Both of these live in browser storage, which the server cannot see, so they are read after mount
  // — rendering the stored value during SSR would be a hydration mismatch.
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [currency, setCurrency] = useState('');
  useEffect(() => {
    setTheme(currentTheme());
    setCurrency(readCurrencyCookie());
  }, []);

  // One writer for the whole app: see lib/ui/theme for why this used to be two.
  const setThemeTo = (next: 'dark' | 'light') => { setTheme(next); applyTheme(next); };

  const setCurrencyTo = (next: string) => {
    setCurrency(next);
    writeCurrencyCookie(next || null);
    // The resolved currency and its FX rate are read server-side, so every amount on the site
    // re-renders from the new cookie.
    router.refresh();
  };

  return (
    <Section title="Interface">
      <Row
        label="Dark theme"
        sub={theme === 'dark' ? 'Dark colour scheme' : 'Light colour scheme'}
        check={theme === 'dark'}
        onClick={() => setThemeTo(theme === 'dark' ? 'light' : 'dark')}
      />
      <Row
        label="Order sounds"
        sub="A sound when an order opens and when it settles"
        check={!muted}
        onClick={toggleSound}
      />
      <Row
        label="Display currency"
        sub="Amounts are converted for display; your balance is held in KES"
        control={
          <select
            value={currency}
            onChange={(e) => setCurrencyTo(e.target.value)}
            aria-label="Display currency"
            className="rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-2 py-1 text-[13px] text-[var(--mt5-blue-link)] outline-none focus:border-[var(--mt5-blue)]"
          >
            <option value="">Auto ({brand.currency || 'KES'})</option>
            {SUPPORTED_DISPLAY_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        }
      />
    </Section>
  );
}

// ───────────────────────────────── chrome ─────────────────────────────────



