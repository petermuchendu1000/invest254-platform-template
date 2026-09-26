'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { useToast } from '@/lib/toast/ToastProvider';
import { useAccountUi, useMyKyc, useSubmitKyc, DOC_LABEL, PLAYER_TWO_FACTOR } from '@/lib/account/accountUi';
import { compressImage } from '@/lib/chat/liveChat';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MfaEnrollDto } from '@/lib/api/types';
import { DIcon } from '@/components/game/digits/icons';

function Shell({ title, sub, icon, onClose, children }: { title: string; sub?: string; icon: Parameters<typeof DIcon>[0]['name']; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="Close" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-[460px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border bg-gradient-to-r from-accent/10 to-transparent px-5 py-4">
          <span className="grid h-9 w-9 place-items-center rounded-xl border border-accent/40 bg-accent/10 text-accent"><DIcon name={icon} className="h-5 w-5" /></span>
          <div className="flex-1"><h2 className="text-[14px] font-semibold text-fg">{title}</h2>{sub ? <p className="text-[11px] text-muted">{sub}</p> : null}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg"><DIcon name="close" className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
const input = 'h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent';
const btn = 'rounded-lg bg-accent px-4 py-2.5 text-sm font-bold text-accent-fg disabled:opacity-50';

/** ACCT-1: Two-factor authentication for players (TOTP; the API already enforces it at sign-in). */
export function TwoFactorDialog() {
  const token = useSession((s) => s.token);
  const close = useAccountUi((s) => s.close);
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['mfa', 'status'], enabled: !!token, queryFn: () => api.mfaStatus(token as string) });
  const [enroll, setEnroll] = useState<MfaEnrollDto | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const on = status.data?.enabled === true;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await fn(); toast.push({ tone: 'success', title: ok }); setCode(''); setEnroll(null); await qc.invalidateQueries({ queryKey: ['mfa'] }); }
    catch (e) { setErr(e instanceof ApiError && e.code === 'MFA_INVALID' ? 'That code is wrong or expired. Use the newest code in your app.' : e instanceof ApiError ? e.message : 'Try again.'); }
    finally { setBusy(false); }
  };

  return (
    <Shell title="Two-Factor Auth" sub="A code from your phone at every sign-in" icon="shield" onClose={close}>
      {status.isLoading ? <p className="text-sm text-muted">Loading…</p> : on ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="flex items-center gap-2 font-semibold text-up"><DIcon name="shield" className="h-4 w-4" />Two-factor is on</p>
          <p className="text-muted">Signing in asks for a 6-digit code from your authenticator app. {status.data?.recoveryCodesLeft ?? 0} recovery codes left.</p>
          <label className="flex flex-col gap-1 text-xs text-muted">To turn it off, enter a current code
            <input className={input} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} />
          </label>
          {err ? <p className="text-[12px] text-down" role="alert">{err}</p> : null}
          <button type="button" disabled={busy || code.length !== 6} onClick={() => run(() => api.mfaDisable(token as string, code), 'Two-factor turned off')} className="rounded-lg border border-down/50 px-4 py-2.5 text-sm font-semibold text-down disabled:opacity-50">Turn off two-factor</button>
        </div>
      ) : enroll ? (
        <div className="flex flex-col gap-3 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, Authy).</li>
            <li>Scan this QR code, or type the key.</li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          <div className="flex items-center gap-4">
            <div className="rounded-lg bg-white p-2"><QRCodeSVG value={enroll.otpauthUrl} size={132} level="M" /></div>
            <code className="break-all rounded bg-surface-2 px-2 py-1 font-mono text-[12px] text-fg">{enroll.secret}</code>
          </div>
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-3">
            <p className="text-[12px] font-semibold text-warn">Save these recovery codes</p>
            <p className="mb-2 text-[11px] text-muted">Each works once if you lose your phone. They won’t be shown again.</p>
            <div className="grid grid-cols-2 gap-1 font-mono text-[12px] text-fg">{enroll.recoveryCodes.map((c) => <span key={c}>{c}</span>)}</div>
            <label className="mt-2 flex items-center gap-2 text-[12px] text-fg"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved my recovery codes</label>
          </div>
          <input className={input} inputMode="numeric" autoComplete="one-time-code" aria-label="Code from your app" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} />
          {err ? <p className="text-[12px] text-down" role="alert">{err}</p> : null}
          <button type="button" className={btn} disabled={busy || code.length !== 6 || !saved} onClick={() => run(() => api.mfaConfirm(token as string, code), 'Two-factor is on')}>Turn on two-factor</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted">Protect your balance: even if someone learns your password, they can’t sign in without the code from your phone.</p>
          {err ? <p className="text-[12px] text-down" role="alert">{err}</p> : null}
          <button type="button" className={btn} disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { setEnroll(await api.mfaEnroll(token as string)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Try again.'); } finally { setBusy(false); }
          }}>Set up two-factor</button>
        </div>
      )}
    </Shell>
  );
}

function FilePick({ label, hint, accept, capture, file, onFile }: { label: string; hint: string; accept: string; capture?: 'user' | 'environment'; file: File | null; onFile: (f: File | null) => void }) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-3 py-3 transition', file ? 'border-up/60 bg-up/5' : 'border-border hover:border-accent/60')}>
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', file ? 'bg-up/15 text-up' : 'bg-surface-2 text-muted')}><DIcon name={file ? 'shield' : 'idcard'} className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-fg">{label}</span>
        <span className="block truncate text-[11px] text-muted">{file ? file.name : hint}</span>
      </span>
      <input type="file" className="sr-only" accept={accept} {...(capture ? { capture } : {})} aria-label={label} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </label>
  );
}

/** ACCT-1: Verify identity — document + selfie, reviewed by the brand's team. */
export function VerifyIdentityDialog() {
  const close = useAccountUi((s) => s.close);
  const me = useMyKyc();
  const submit = useSubmitKyc();
  const toast = useToast();
  const [docType, setDocType] = useState('national_id');
  const [fullName, setFullName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [dob, setDob] = useState('');
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  const st = me.data?.status ?? 'none';
  const needsBack = docType !== 'passport';
  const ready = fullName.trim().length >= 3 && idNumber.trim().length >= 4 && !!dob && !!front && !!selfie && (!needsBack || !!back);

  const shrink = async (f: File) => (f.type.startsWith('image/') ? new File([await compressImage(f)], f.name, { type: 'image/jpeg' }) : f);
  const go = async () => {
    setErr(null);
    try {
      await submit.mutateAsync({ docType, fullName: fullName.trim(), idNumber: idNumber.trim(), dateOfBirth: dob, front: await shrink(front!), back: needsBack && back ? await shrink(back) : null, selfie: await shrink(selfie!) });
      toast.push({ tone: 'success', title: 'Documents sent' });
      setRetry(false);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not send your documents. Try again.'); }
  };

  const status = (
    st === 'approved' ? <p className="flex items-center gap-2 rounded-lg bg-up/10 px-3 py-2.5 text-sm font-semibold text-up"><DIcon name="shield" className="h-4 w-4" />Your identity is verified.</p>
    : st === 'pending' ? <p className="rounded-lg bg-warn/10 px-3 py-2.5 text-sm text-warn"><b>Under review</b> · {DOC_LABEL[me.data?.latest?.docType ?? ''] ?? 'Documents'}</p>
    : st === 'rejected' ? <div className="rounded-lg bg-down/10 px-3 py-2.5 text-sm text-down"><b>Not approved.</b> {me.data?.latest?.reviewNote}</div>
    : null
  );
  const showForm = st === 'none' || (st === 'rejected' && retry);
  return (
    <Shell title="Verify Identity" icon="idcard" onClose={close}>
      {me.isLoading ? <p className="text-sm text-muted">Loading…</p> : (
        <div className="flex flex-col gap-3">
          {status}
          {st === 'rejected' && !retry ? <button type="button" className={btn} onClick={() => setRetry(true)}>Send new documents</button> : null}
          {showForm ? (
            <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ready) void go(); }}>
              <label className="flex flex-col gap-1 text-xs text-muted">Document
                <select className={input} value={docType} onChange={(e) => setDocType(e.target.value)}>
                  {Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">Full name, as on the document
                <input className={input} value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted">Document number
                  <input className={input} value={idNumber} onChange={(e) => setIdNumber(e.target.value.slice(0, 40))} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted">Date of birth
                  <input className={input} type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={new Date(Date.now() - 18 * 365.25 * 86400_000).toISOString().slice(0, 10)} />
                </label>
              </div>
              <FilePick label={needsBack ? 'Front of the document' : 'Photo page'} hint="Photo or PDF, all corners visible" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" file={front} onFile={setFront} />
              {needsBack ? <FilePick label="Back of the document" hint="Photo or PDF" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" file={back} onFile={setBack} /> : null}
              <FilePick label="Selfie" hint="Your face, clearly lit, no glasses or hat" accept="image/jpeg,image/png,image/webp" capture="user" file={selfie} onFile={setSelfie} />
              <p className="text-[11px] text-muted">Your documents are only seen by this brand’s support team to confirm your identity.</p>
              {err ? <p className="text-[12px] text-down" role="alert">{err}</p> : null}
              <button type="submit" className={btn} disabled={!ready || submit.isPending}>{submit.isPending ? 'Sending…' : 'Send for review'}</button>
            </form>
          ) : null}
        </div>
      )}
    </Shell>
  );
}

/** Mounts whichever account dialog is open. */
export function AccountDialogs() {
  const d = useAccountUi((s) => s.dialog);
  return d === 'twofactor' && PLAYER_TWO_FACTOR ? <TwoFactorDialog /> : d === 'verify' ? <VerifyIdentityDialog /> : null;
}
