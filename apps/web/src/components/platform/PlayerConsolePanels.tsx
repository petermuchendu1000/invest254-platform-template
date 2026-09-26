'use client';

/**
 * docs/42 UI-10 — what a platform admin (and the owner) needs to manage ONE player from the console:
 *   PlayerSummary       the player's money + activity at a glance (was: nothing beyond the list row);
 *   BalanceAdjust       credit/debit a NAMED wallet (real cash vs bonus — the API supported both, the UI
 *                       never sent the kind, so every adjustment silently hit real cash), confirmed with a
 *                       plain before → after statement;
 *   PlayerOverridesForm per-player game overrides (the API existed with no UI), with the brand's own
 *                       limits shown up-front — the database refuses anything that favours the player.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/lib/toast/ToastProvider';
import { ApiError } from '@/lib/api/client';
import { formatAgo, formatNumber, formatDate } from '@/lib/format';
import { usePlatformUserDetail, usePlatformUserOverrides, useSetPlatformUserOverrides, usePlatformUserAction } from '@/lib/platform/hooks';
import type { SiteWithConfig } from '@/lib/platform/endpoints';
import type { UserOverridePatch } from '@/lib/admin/types';

const kes = (c: number | null | undefined) => (typeof c === 'number' ? `KES ${(c / 100).toLocaleString('en-KE')}` : '—');

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-fg">{value}</span>
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </div>
  );
}

/** 0.4999 → 49.99 (display %). */
const pctOf = (f: number) => Math.round(f * 10000) / 100;

export function PlayerSummary({ siteId, uid }: { siteId: string; uid: string }) {
  const q = usePlatformUserDetail(siteId, uid);
  const d = q.data;
  if (q.isLoading) return <p className="text-xs text-muted">Loading player…</p>;
  if (!d) return <p className="text-xs text-down">{q.error instanceof ApiError ? q.error.message : 'Could not load this player.'}</p>;
  return (
    <div className="flex flex-col gap-2" aria-label="Player summary">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Real balance" value={kes(d.realBalanceCents)} />
        <Stat label="Bonus balance" value={kes(d.bonusBalanceCents)} />
        <Stat label="Deposits" value={kes(d.depositsCents)} hint={`Withdrawn ${kes(d.withdrawalsCents)}`} />
        <Stat label="Net deposits" value={kes(d.netDepositsCents)} />
        <Stat label="Turnover" value={kes(d.turnoverCents)} hint={`${formatNumber(d.betCount)} bets`} />
        <Stat label="House GGR" value={kes(d.ggrCents)} />
        <Stat label="Last active" value={d.lastActiveAtMs ? `${formatAgo(d.lastActiveAtMs)}` : 'never'} />
        <Stat label="Joined" value={formatDate(d.createdAtMs)} hint={d.referredBy ? 'referred' : 'direct sign-up'} />
      </div>
      {d.lastTxKind ? (
        <p className="text-xs text-muted">Last transaction: {d.lastTxKind} {kes(d.lastTxAmountCents)} ({d.lastTxStatus}){d.lastTxAtMs ? `, ${formatAgo(d.lastTxAtMs)}` : ''}.</p>
      ) : null}
    </div>
  );
}

export function BalanceAdjust({ siteId, uid, username }: { siteId: string; uid: string; username: string }) {
  const action = usePlatformUserAction(siteId);
  const detail = usePlatformUserDetail(siteId, uid);
  const toast = useToast();
  const [wallet, setWallet] = useState<'real' | 'bonus'>('real');
  const [dir, setDir] = useState<'credit' | 'debit'>('credit');
  const [amt, setAmt] = useState('');
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);

  const cents = Math.round(Number(amt) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && reason.trim().length > 0;
  const current = wallet === 'real' ? detail.data?.realBalanceCents : detail.data?.bonusBalanceCents;
  const after = typeof current === 'number' ? current + (dir === 'debit' ? -cents : cents) : null;
  const overdraw = after != null && after < 0;
  const walletLabel = wallet === 'real' ? 'real-cash (withdrawable)' : 'bonus (non-withdrawable)';

  function submit() {
    action.mutate({ kind: 'balance', uid, amountCents: dir === 'debit' ? -cents : cents, reason: reason.trim(), balanceKind: wallet }, {
      onSuccess: () => { toast.push({ tone: 'success', title: `${dir === 'credit' ? 'Credited' : 'Debited'} ${kes(cents)} ${wallet === 'real' ? 'real cash' : 'bonus'}` }); setAmt(''); setReason(''); setArmed(false); },
      onError: (e) => { toast.push({ tone: 'error', title: 'Adjustment failed', description: (e as Error).message }); setArmed(false); },
    });
  }

  return (
    <div className="flex flex-col gap-2" aria-label="Adjust balance">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">Wallet
          <select aria-label="Wallet" value={wallet} onChange={(e) => { setWallet(e.target.value as 'real' | 'bonus'); setArmed(false); }} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-fg">
            <option value="real">Real cash</option><option value="bonus">Bonus</option>
          </select></label>
        <label className="flex flex-col gap-1 text-xs text-muted">Direction
          <select aria-label="Direction" value={dir} onChange={(e) => { setDir(e.target.value as 'credit' | 'debit'); setArmed(false); }} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-fg">
            <option value="credit">Credit +</option><option value="debit">Debit −</option>
          </select></label>
        <label className="flex flex-col gap-1 text-xs text-muted">Amount (KES)
          <input aria-label="Amount (KES)" value={amt} onChange={(e) => { setAmt(e.target.value); setArmed(false); }} type="number" min="0" className="h-9 w-28 rounded-lg border border-border bg-surface px-2 text-sm text-fg" /></label>
        <label className="flex flex-col gap-1 text-xs text-muted">Reason (required, audited)
          <input aria-label="Reason" value={reason} onChange={(e) => { setReason(e.target.value); setArmed(false); }} className="h-9 w-56 rounded-lg border border-border bg-surface px-2 text-sm text-fg" /></label>
        {!armed ? (
          <Button size="sm" disabled={!valid || overdraw || action.isPending} onClick={() => setArmed(true)}>Review adjustment</Button>
        ) : null}
      </div>
      {overdraw ? <p className="text-xs text-down">That would take the {walletLabel} balance below zero.</p> : null}
      {armed && valid ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 p-2 text-xs">
          <span>
            {dir === 'credit' ? 'Credit' : 'Debit'} <b>{kes(cents)}</b> {dir === 'credit' ? 'to' : 'from'} @{username}&apos;s <b>{walletLabel}</b> balance
            {current != null && after != null ? <> — {kes(current)} → <b>{kes(after)}</b></> : null}. Reason: “{reason.trim()}”.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setArmed(false)} disabled={action.isPending}>Cancel</Button>
          <Button size="sm" variant={dir === 'debit' ? 'down' : 'primary'} onClick={submit} disabled={action.isPending}>{action.isPending ? '…' : 'Confirm adjustment'}</Button>
        </div>
      ) : null}
    </div>
  );
}

const FIELDS = ['winRate', 'houseEdge', 'maxWinMultiplier', 'tradeDurationS', 'minStake', 'maxStake', 'notes'] as const;
type Field = (typeof FIELDS)[number];

export function PlayerOverridesForm({ site, uid }: { site: SiteWithConfig; uid: string }) {
  const q = usePlatformUserOverrides(site.siteId, uid);
  const m = useSetPlatformUserOverrides(site.siteId, uid);
  const toast = useToast();
  const [form, setForm] = useState<Record<Field, string>>({ winRate: '', houseEdge: '', maxWinMultiplier: '', tradeDurationS: '', minStake: '', maxStake: '', notes: '' });

  useEffect(() => {
    const o = q.data;
    if (!o) return;
    setForm({
      winRate: o.winRate != null ? String(pctOf(o.winRate)) : '', houseEdge: o.houseEdge != null ? String(pctOf(o.houseEdge)) : '',
      maxWinMultiplier: o.maxWinMultiplier != null ? String(o.maxWinMultiplier) : '', tradeDurationS: o.tradeDurationS != null ? String(o.tradeDurationS) : '',
      minStake: o.minStakeCents != null ? String(o.minStakeCents / 100) : '', maxStake: o.maxStakeCents != null ? String(o.maxStakeCents / 100) : '',
      notes: o.notes ?? '',
    });
  }, [q.data]);

  const num = (s: string): number | null => { const t = s.trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
  const cfg = site.config;
  // The database's fairness fence (0135): an override may only be as good for the player as the brand itself.
  // Entered in % like every other economy editor (BUGLOG #112: these two alone took 0–1 fractions).
  const frac = (v: number | null) => (v == null || Number.isNaN(v) ? v : Math.round(v * 1000) / 100000);
  const wr = frac(num(form.winRate)), he = frac(num(form.houseEdge)), mm = num(form.maxWinMultiplier), dur = num(form.tradeDurationS);
  const errors: string[] = [];
  if (wr != null && (Number.isNaN(wr) || wr <= 0 || wr > cfg.targetWinRate)) errors.push(`Win rate: above 0%, at most ${pctOf(cfg.targetWinRate)}%.`);
  if (he != null && (Number.isNaN(he) || he < cfg.houseEdge || he >= 1)) errors.push(`House edge: at least ${pctOf(cfg.houseEdge)}%, below 100%.`);
  if (mm != null && (Number.isNaN(mm) || mm <= 1 || mm > cfg.maxMultiplier)) errors.push(`Max win multiplier must be above 1 and at most the brand's ×${cfg.maxMultiplier}.`);
  if (dur != null && (Number.isNaN(dur) || !Number.isInteger(dur) || dur < 1 || dur > 3600)) errors.push('Auto-sell duration must be a whole number of seconds (1–3600).');
  for (const k of ['minStake', 'maxStake'] as const) { const v = num(form[k]); if (v != null && (Number.isNaN(v) || v <= 0)) errors.push(`${k === 'minStake' ? 'Min' : 'Max'} stake must be a positive amount.`); }

  function save() {
    const cents = (s: string) => { const v = num(s); return v == null ? null : Math.round(v * 100); };
    const patch: UserOverridePatch = {
      winRate: wr, houseEdge: he, maxWinMultiplier: mm, tradeDurationS: dur,
      minStakeCents: cents(form.minStake), maxStakeCents: cents(form.maxStake),
      notes: form.notes.trim() ? form.notes.trim() : null,
    };
    m.mutate(patch, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Overrides saved' }),
      onError: (e) => toast.push({ tone: 'error', title: 'Save failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  const input = (k: Field, label: string, placeholder: string) => (
    <label className="flex flex-col gap-1 text-xs text-muted">{label}
      <input aria-label={label} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={placeholder}
        className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-fg" />
    </label>
  );

  return (
    <div className="flex flex-col gap-2" aria-label="Player overrides">
      <p className="text-xs tabular-nums text-muted">
        Blank = brand · win ≤ <b className="text-fg">{pctOf(cfg.targetWinRate)}%</b> · edge ≥ <b className="text-fg">{pctOf(cfg.houseEdge)}%</b> · ×≤ <b className="text-fg">{cfg.maxMultiplier}</b>
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {input('winRate', 'Win rate (%)', `brand ${pctOf(cfg.targetWinRate)}`)}
        {input('houseEdge', 'House edge (%)', `brand ${pctOf(cfg.houseEdge)}`)}
        {input('maxWinMultiplier', 'Max win multiplier', `brand ×${cfg.maxMultiplier}`)}
        {input('tradeDurationS', 'Auto-sell duration (s)', `brand ${cfg.defaultDurationS}`)}
        {input('minStake', 'Min stake (KES)', `brand ${cfg.minStakeCents / 100}`)}
        {input('maxStake', 'Max stake (KES)', `brand ${cfg.maxStakeCents / 100}`)}
        {input('notes', 'Notes', 'optional, audited')}
      </div>
      {errors.length ? <ul className="list-disc pl-5 text-xs text-down">{errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={q.isLoading || m.isPending || errors.length > 0}>{m.isPending ? 'Saving…' : 'Save overrides'}</Button>
        {q.data?.updatedAtMs ? <span className="text-xs text-muted">Last updated {formatAgo(q.data.updatedAtMs)}.</span> : null}
      </div>
    </div>
  );
}
