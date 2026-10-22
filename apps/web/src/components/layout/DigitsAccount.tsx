'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useSession } from '@/lib/auth/session';
import { maskPhoneForDisplay } from '@invest254/shared/payments';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useWallet, useSetAccountMode, useTopupDemo } from '@/lib/wallet/hooks';
// aliased: this file already exports its own `AccountMenu` (the avatar menu).
import { AccountMenu as AccountPanel } from '@/components/wallet/AccountMenu';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useAmountText } from '@/lib/game/useAmountText';
import { useDigitSession } from '@/lib/game/digitSession';
import { useMultSession } from '@/lib/game/multSession';
import { useLiveChat } from '@/lib/chat/liveChat';
import { useAccountUi, useMyKyc, kycLabelSuffix, PLAYER_TWO_FACTOR } from '@/lib/account/accountUi';
import { useToast } from '@/lib/toast/ToastProvider';
import { passwordError } from '@/lib/auth/validation';
import { DIcon, type IconName } from '@/components/game/digits/icons';
import { MK } from '@/lib/marketer/labels';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';

/** Close a popover on outside click / Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `mousedown`: on a touch screen the synthetic mouse event only arrives after
    // the tap completes, so a mousedown-only handler makes the popover feel slow to dismiss.
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

/**
 * Balance pill + account switcher (digits broker mock): the active account's badge ("R" real,
 * "D" demo), its label and spendable balance, and a chevron that opens SWITCH ACCOUNT — Real and
 * Demo with their balances, "Refresh demo balance", and Deposit / Withdraw. Switching is refused
 * while a contract is open (the server enforces it too). While AUTO is running on a phone, the pill
 * shows "Auto · <side>" instead.
 */
/** Balance text size by length: whole figure always visible, smaller only when it is long. */
function balanceSize(text: string, compact: boolean): string {
  if (compact) return text.length <= 10 ? 'text-[12px]' : text.length <= 13 ? 'text-[11px]' : 'text-[10px]';
  return text.length <= 14 ? 'text-[13px]' : 'text-[12px]';
}

export function AccountPill({ compact = false }: { compact?: boolean }) {
  const { data } = useWallet();
  const amt = useAmountText();
  const auto = useDigitSession((s) => s.auto);
  const multOpen = useMultSession((s) => !!s.position);
  const inPlay = useDigitSession((s) => !!s.open || !!s.auto) || multOpen;
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);
  const setMode = useSetAccountMode();
  const topup = useTopupDemo();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const { isMarketer: skin } = useMarketerSkin();
  if (!data) return null;
  // A MARKETER is a normal player with a Real account (their funny money) and a separate Demo practice
  // bucket (0176). Which tab is active is their `marketerPractice` flag — NOT account_mode, which stays
  // 'demo' server-side. So the pill reads Real (accent) on their funny money and Demo (warn) on
  // practice, exactly like a player — never the yellow "Demo" while they are on their real account.
  const marketer = data.modeLocked === true;
  const demo = marketer ? data.marketerPractice === true : data.mode === 'demo';
  const spend = (data.real ?? 0) + (data.bonus ?? 0);
  // MARKETER: neutralise the Real/Demo money vocabulary to game labels (Coins/Practice, C/P).
  const tabLabel = demo ? (skin ? MK.practiceTab : 'Demo') : (skin ? MK.realTab : 'Real');
  const tabBadge = demo ? (skin ? MK.practiceBadge : 'D') : (skin ? MK.realBadge : 'R');

  // A marketer's active tab is their practice flag (account_mode stays 'demo'), so guard against the
  // PRESENTED tab, not data.mode — otherwise tapping "Demo" (always === data.mode) would no-op.
  const current: 'real' | 'demo' = marketer ? (data.marketerPractice ? 'demo' : 'real') : (data.mode === 'demo' ? 'demo' : 'real');
  const switchTo = (mode: 'real' | 'demo') => {
    if (mode === current || setMode.isPending) return;
    if (inPlay) { toast.push({ tone: 'info', title: 'Trade open' }); return; }
    setMode.mutate(mode, {
      onSuccess: (r) => { setOpen(false); toast.push({ tone: 'success', title: r.mode === 'demo' ? 'Demo' : 'Real', description: amt.text(r.wallet.real + r.wallet.bonus) }); },
      onError: (e) => toast.push({ tone: 'error', title: 'Could not switch', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${tabLabel} account, ${amt.text(spend)}. Switch account`}
        className={cn('flex items-center rounded-xl border bg-surface/70 py-1 pl-1 transition hover:border-accent/50', demo ? 'border-warn/50' : 'border-border', compact ? 'h-10 gap-1.5 pr-1.5' : 'h-11 gap-2 pr-2')}
      >
        <span className={cn('grid shrink-0 place-items-center rounded-full font-bold', demo ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent', compact ? 'h-6 w-6 text-[10px]' : 'h-7 w-7 text-[11px]')}>{tabBadge}</span>
        {auto && compact ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-bg px-2.5 py-1 text-[11px] font-semibold text-fg">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />Auto · {auto.side.toUpperCase()}
          </span>
        ) : (
          <span className="flex flex-col items-start leading-none">
            <span className={cn('text-[9px] font-semibold uppercase tracking-wider', demo ? 'text-warn' : 'text-muted')}>{tabLabel}</span>
            {/* The full balance, never cut off: long figures step down a size so the phone header
                (menu, pill, Deposit, bell) still fits at 320px (BUGLOG #80). */}
            <span className={cn('mt-0.5 whitespace-nowrap font-mono font-bold tabular-nums text-fg', balanceSize(`${amt.prefix}${amt.num(spend)}`, compact))}>{amt.prefix}{amt.num(spend)}</span>
          </span>
        )}
        <DIcon name="chevronDown" className={cn('h-3.5 w-3.5 text-muted', compact && 'hidden min-[360px]:block')} />
      </button>
      {open ? (
        <AccountPanel
          wallet={data}
          fmt={(c: number) => amt.text(c)}
          // The compact pill lives on the LEFT of the phone bar (by the menu button); the full pill
          // is right-anchored in the desktop bar. Open the card away from the nearer screen edge.
          align={compact ? 'left' : 'right'}
          switching={setMode.isPending}
          toppingUp={topup.isPending}
          onSwitch={switchTo}
          onDeposit={() => { setOpen(false); openDeposit(); }}
          onWithdraw={() => { setOpen(false); openWithdraw(); }}
          onTopupDemo={() => topup.mutate(undefined, {
            onSuccess: (r) => toast.push({ tone: 'success', title: 'Demo balance topped up', description: amt.text(r.demoBalance) }),
            onError: (e) => toast.push({ tone: 'error', title: 'Could not top up', description: e instanceof ApiError ? e.message : 'Try again.' }),
          })}
        />
      ) : null}
    </div>
  );
}

/**
 * Avatar menu (digits broker mock): who is signed in, then Profile, Change password, Referrals,
 * support and Sign out. Only items the platform actually supports are listed.
 */
export function AccountMenu() {
  const user = useSession((s) => s.user);
  const brand = useBrand();
  const { logout } = useAuthActions();
  const setSupportOpen = useLiveChat((s) => s.setOpen);
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const openDialog = useAccountUi((s) => s.open);
  const kyc = useMyKyc(user?.role === 'player' || user?.role === 'marketer');
  const ref = useDismiss(open, () => setOpen(false));
  if (!user) return null;

  const Item = ({ icon, label, onClick, href, tone }: { icon: IconName; label: string; onClick?: () => void; href?: string; tone?: 'down' | 'up' }) => {
    const cls = cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium transition hover:bg-surface-2',
      tone === 'down' ? 'text-down' : tone === 'up' ? 'text-up' : 'text-fg');
    const inner = <><DIcon name={icon} className="h-4 w-4 shrink-0 opacity-80" />{label}</>;
    if (href && /^(https?:|mailto:)/.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer" className={cls} onClick={() => setOpen(false)}>{inner}</a>;
    return href
      ? <Link href={href} className={cls} onClick={() => setOpen(false)}>{inner}</Link>
      : <button type="button" className={cls} onClick={() => { setOpen(false); onClick?.(); }}>{inner}</button>;
  };

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label="Account menu" aria-expanded={open}
        className="grid h-10 w-10 place-items-center rounded-full border border-border bg-surface/70 text-fg transition hover:border-accent/50">
        <DIcon name="user" className="h-[18px] w-[18px]" />
      </button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 rounded-xl border border-border bg-surface p-1.5 shadow-2xl" role="menu">
          <div className="border-b border-border px-3 pb-3 pt-2">
            <div className="truncate text-[14px] font-semibold text-fg">@{user.username}</div>
            {/* The file-local mask here rendered "25*****5678" while the wallet rendered
                "0712 •••678" for the same number. One helper now, so the player sees one shape. */}
            {user.phone ? <div className="font-mono text-[11px] text-muted">{maskPhoneForDisplay(user.phone)}</div> : null}
          </div>
          <div className="py-1">
            <Item icon="user" label="Profile" href="/account" />
            <Item icon="lock" label="Change Password" onClick={() => setPw(true)} />
            {PLAYER_TWO_FACTOR ? <Item icon="shield" label="Two-Factor Auth" onClick={() => openDialog('twofactor')} /> : null}
            <Item icon="idcard" label={`Verify Identity${kycLabelSuffix(kyc.data?.status)}`} onClick={() => openDialog('verify')} />
            <Item icon="gift" label="Referrals" href="/account" />
          </div>
          <div className="border-t border-border py-1">
            <Item icon="chat" label="Live Chat" onClick={() => setSupportOpen(true)} tone="up" />
            {brand.supportWhatsapp ? <Item icon="whatsapp" label={`WhatsApp Care · ${brand.supportWhatsapp}`} href={`https://wa.me/${brand.supportWhatsapp.replace(/[^0-9]/g, '')}`} tone="up" /> : null}
            {brand.supportEmail ? <Item icon="mail" label={brand.supportEmail} href={`mailto:${brand.supportEmail}`} /> : null}
            <Item icon="logout" label="Sign Out" onClick={() => { void logout(); }} tone="down" />
          </div>
        </div>
      ) : null}
      <ChangePasswordModal open={pw} onClose={() => setPw(false)} />
    </div>
  );
}

/** Change password (existing POST /auth/password/change). */
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const token = useSession((s) => s.token);
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!open) { setCur(''); setNext(''); setConfirm(''); setErr(null); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  // the same rules the server applies (was length only → a round trip to learn "add a number")
  const problem = next && passwordError(next) ? passwordError(next)! : confirm && confirm !== next ? 'The new passwords do not match.' : null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || problem || !cur || !next) return;
    setBusy(true); setErr(null);
    try {
      await api.changePassword(token, { current_password: cur, new_password: next });
      toast.push({ tone: 'success', title: 'Password changed' });
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Could not change your password. Try again.');
    } finally { setBusy(false); }
  };
  const input = 'h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent';
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Change password">
      <button aria-label="Close" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <form onSubmit={submit} className="relative flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-border bg-surface p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-fg">Change password</h2>
        <input type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} className={input} />
        <input type="password" autoComplete="new-password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
        <input type="password" autoComplete="new-password" placeholder="Repeat new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
        {problem || err ? <p className="text-[12px] text-down">{problem ?? err}</p> : null}
        <div className="mt-1 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-border py-2.5 text-sm font-semibold text-fg">Cancel</button>
          <button type="submit" disabled={busy || !!problem || !cur || !next || !confirm} className="flex-1 rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-fg disabled:opacity-50">
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
}
