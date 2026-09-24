'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useSession } from '@/lib/auth/session';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useWallet, useSetAccountMode, useTopupDemo } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useAmountText } from '@/lib/game/useAmountText';
import { useDigitSession } from '@/lib/game/digitSession';
import { useLiveChat } from '@/lib/chat/liveChat';
import { useAccountUi, useMyKyc } from '@/lib/account/accountUi';
import { useToast } from '@/lib/toast/ToastProvider';
import { DIcon, type IconName } from '@/components/game/digits/icons';

/** Close a popover on outside click / Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
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
export function AccountPill({ compact = false }: { compact?: boolean }) {
  const { data } = useWallet();
  const amt = useAmountText();
  const auto = useDigitSession((s) => s.auto);
  const inPlay = useDigitSession((s) => !!s.open || !!s.auto);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);
  const setMode = useSetAccountMode();
  const topup = useTopupDemo();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  if (!data) return null;
  const demo = data.mode === 'demo';
  const spend = (data.real ?? 0) + (data.bonus ?? 0);
  const realB = data.realBalance ?? (demo ? 0 : data.real ?? 0);
  const bonusB = data.bonusBalance ?? (demo ? 0 : data.bonus ?? 0);
  const demoB = data.demoBalance ?? (demo ? data.real ?? 0 : 0);

  const switchTo = (mode: 'real' | 'demo') => {
    if (mode === data.mode || setMode.isPending) return;
    if (inPlay) { toast.push({ tone: 'info', title: 'Finish your trade first', description: 'Switch accounts once your open contract settles and Auto is stopped.' }); return; }
    setMode.mutate(mode, {
      onSuccess: (r) => { setOpen(false); toast.push({ tone: 'success', title: r.mode === 'demo' ? 'Demo account active' : 'Real account active', description: r.mode === 'demo' ? 'You are trading with play money.' : 'You are trading with real money.' }); },
      onError: (e) => toast.push({ tone: 'error', title: 'Could not switch', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  };

  const Row = ({ mode, label, cents, dot }: { mode: 'real' | 'demo'; label: string; cents: number; dot: string }) => {
    const active = (data.mode ?? 'real') === mode;
    return (
      <button type="button" role="menuitemradio" aria-checked={active} onClick={() => switchTo(mode)}
        disabled={mode === 'real' && data.modeLocked}
        className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition disabled:opacity-50', active ? 'bg-surface-2' : 'hover:bg-surface-2/60')}>
        <span className="flex items-center gap-2.5">
          <span className={cn('h-2 w-2 rounded-full', dot)} />
          <span>
            <span className="block text-[13px] font-semibold text-fg">{label}</span>
            <span className="block font-mono text-[12px] tabular-nums text-muted">{amt.prefix}{amt.num(cents)}</span>
          </span>
        </span>
        {active ? <span className="text-[11px] font-semibold text-accent">Active</span> : null}
      </button>
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${demo ? 'Demo' : 'Real'} account, ${amt.text(spend)}. Switch account`}
        className={cn('flex items-center rounded-xl border bg-surface/70 py-1 pl-1 transition hover:border-accent/50', demo ? 'border-warn/50' : 'border-border', compact ? 'h-10 gap-1.5 pr-1.5' : 'h-11 gap-2 pr-2')}
      >
        <span className={cn('grid shrink-0 place-items-center rounded-full font-bold', demo ? 'bg-warn text-black' : 'bg-down text-white', compact ? 'h-6 w-6 text-[10px]' : 'h-7 w-7 text-[11px]')}>{demo ? 'D' : 'R'}</span>
        {auto && compact ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-bg px-2.5 py-1 text-[11px] font-semibold text-fg">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />Auto · {auto.side.toUpperCase()}
          </span>
        ) : (
          <span className="flex flex-col items-start leading-none">
            <span className={cn('text-[9px] font-semibold uppercase tracking-wider', demo ? 'text-warn' : 'text-muted')}>{demo ? 'Demo' : 'Real'}</span>
            <span className={cn('mt-0.5 font-mono font-bold tabular-nums text-fg', compact ? 'text-[12px]' : 'text-[13px]')}>{amt.prefix}{amt.num(spend)}</span>
          </span>
        )}
        <DIcon name="chevronDown" className="h-3.5 w-3.5 text-muted" />
      </button>
      {open ? (
        <div className="absolute left-0 top-[calc(100%+8px)] z-50 w-72 rounded-xl border border-border bg-surface p-2 shadow-2xl sm:left-auto sm:right-0" role="dialog" aria-label="Switch account">
          <div className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Switch account</div>
          <div role="menu" className="flex flex-col gap-1">
            <Row mode="real" label="Real Account" cents={realB + bonusB} dot="bg-blue-500" />
            <Row mode="demo" label="Demo Account" cents={demoB} dot="bg-down" />
          </div>
          {bonusB > 0 ? <p className="px-3 pt-1 text-[11px] text-muted">Real includes {amt.prefix}{amt.num(bonusB)} bonus (play only).</p> : null}
          <p className="px-3 pt-2 text-[11px] leading-snug text-muted">Demo uses play money that can’t be withdrawn. Demo results can differ from real-money play.</p>
          <button type="button" disabled={topup.isPending}
            onClick={() => topup.mutate(undefined, {
              onSuccess: (r) => toast.push({ tone: 'success', title: 'Demo balance refreshed', description: `${amt.text(r.demoBalance)} play money.` }),
              onError: (e) => toast.push({ tone: 'error', title: 'Could not refresh', description: e instanceof ApiError ? e.message : 'Try again.' }),
            })}
            className="mt-2 flex w-full items-center justify-center gap-2 border-t border-border pt-2.5 text-[12px] font-medium text-muted hover:text-fg disabled:opacity-50">
            <DIcon name="refresh" className="h-3.5 w-3.5" />Refresh demo balance
          </button>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setOpen(false); openDeposit(); }} className="rounded-lg bg-accent py-2 text-[12px] font-bold text-accent-fg">Deposit</button>
            <button type="button" onClick={() => { setOpen(false); openWithdraw(); }} className="rounded-lg border border-border py-2 text-[12px] font-semibold text-fg hover:border-accent/50">Withdraw</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Mask everything but the first two and last four characters ("25*****5678"). */
function mask(v: string): string {
  if (v.length <= 6) return v;
  return `${v.slice(0, 2)}${'*'.repeat(Math.max(3, v.length - 6))}${v.slice(-4)}`;
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
            {user.phone ? <div className="font-mono text-[11px] text-muted">{mask(user.phone)}</div> : null}
          </div>
          <div className="py-1">
            <Item icon="user" label="Profile" href="/account" />
            <Item icon="lock" label="Change Password" onClick={() => setPw(true)} />
            <Item icon="shield" label="Two-Factor Auth" onClick={() => openDialog('twofactor')} />
            <Item icon="idcard" label={`Verify Identity${kyc.data?.status === 'approved' ? ' · verified' : kyc.data?.status === 'pending' ? ' · in review' : ''}`} onClick={() => openDialog('verify')} />
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
function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const token = useSession((s) => s.token);
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!open) { setCur(''); setNext(''); setConfirm(''); setErr(null); } }, [open]);
  if (!open) return null;

  const problem = next && next.length < 8 ? 'Use at least 8 characters.' : confirm && confirm !== next ? 'The new passwords do not match.' : null;
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
