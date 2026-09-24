'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatKes } from '@invest254/shared/money';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Empty, TableWrap, Th, Td } from '@/components/admin/ui';
import { useToast } from '@/lib/toast/ToastProvider';
import { useSession } from '@/lib/auth/session';
import { ApiError } from '@/lib/api/client';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  useInvoice, usePayNow, useRecordInvoicePayment, useSetInvoiceStatus,
  type Invoice, type InvoiceSummary,
} from '@/lib/billing/api';
import { invoiceState, subState, TONE_PILL, METHOD, parseKes, validPhone, localPhone, type Tone } from '@/lib/billing/labels';

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

export function Pill({ label, tone, className }: { label: string; tone: Tone; className?: string }) {
  return <span className={cn('inline-flex w-fit items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', TONE_PILL[tone], className)}>{label}</span>;
}
export function InvoicePill({ inv }: { inv: Pick<InvoiceSummary, 'status' | 'dueAt' | 'amountPaidCents'> }) {
  const s = invoiceState(inv); return <Pill label={s.label} tone={s.tone} />;
}
export function SubPill({ status }: { status: string }) {
  const s = subState(status); return <Pill label={s.label} tone={s.tone} />;
}

/** Invoices as a table on desktop and tappable cards on a phone. Row = link to the printable invoice. */
export function InvoiceList({ invoices, showPlatform, onPay, emptyTitle, emptyText, compact }: {
  invoices: InvoiceSummary[]; showPlatform?: boolean; onPay?: ((inv: InvoiceSummary) => void) | undefined; emptyTitle: string; emptyText?: string | undefined;
  /** Cards at every width (inside a dialog, where a 7-column table would be cramped). */
  compact?: boolean;
}) {
  const router = useRouter();
  if (!invoices.length) return <Empty title={emptyTitle} {...(emptyText ? { description: emptyText } : {})} />;
  const href = (i: InvoiceSummary) => `/platform/billing/invoices/${i.id}`;
  return (
    <>
      <div className={compact ? 'hidden' : 'hidden md:block'}>
        <TableWrap>
          <thead className="border-b border-border">
            <tr><Th>Invoice</Th>{showPlatform ? <Th>Platform</Th> : null}<Th>Issued</Th><Th>Due</Th><Th>Status</Th><Th numeric>Total</Th><Th numeric>Amount due</Th>{onPay ? <Th className="w-px" /> : null}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {invoices.map((i) => (
              <tr key={i.id} className="cursor-pointer transition hover:bg-surface-2/60" onClick={() => router.push(href(i))}>
                <Td><Link href={href(i)} onClick={(e) => e.stopPropagation()} className="font-mono text-sm font-medium text-fg hover:text-accent">{i.number}</Link>
                  <div className="text-xs text-muted">{i.kind === 'renewal' && i.periodStart ? `${formatDate(i.periodStart)} – ${formatDate(i.periodEnd!)}` : 'One-off invoice'}</div></Td>
                {showPlatform ? <Td className="max-w-[180px] truncate">{i.platformName}</Td> : null}
                <Td className="whitespace-nowrap">{formatDate(i.issuedAt)}</Td>
                <Td className="whitespace-nowrap">{formatDate(i.dueAt)}</Td>
                <Td><InvoicePill inv={i} /></Td>
                <Td numeric>{formatKes(i.totalCents)}</Td>
                <Td numeric className={cn(i.overdue && 'font-semibold text-down')}>{i.status === 'open' ? formatKes(i.amountDueCents) : '—'}</Td>
                {onPay ? <Td>{i.status === 'open' ? <Button size="sm" onClick={(e) => { e.stopPropagation(); onPay(i); }}>Pay</Button> : null}</Td> : null}
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
      <ul className={cn('flex flex-col gap-2', !compact && 'md:hidden')} aria-label="Invoices">
        {invoices.map((i) => (
          <li key={i.id} className="rounded-2xl border border-border bg-surface p-3">
            <Link href={href(i)} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-sm font-medium">{i.number}</div>
                <div className="truncate text-xs text-muted">{showPlatform ? `${i.platformName} · ` : ''}Due {formatDate(i.dueAt)}</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="whitespace-nowrap text-sm font-semibold tabular-nums">{formatKes(i.status === 'open' ? i.amountDueCents : i.totalCents)}</span>
                <InvoicePill inv={i} />
              </div>
            </Link>
            {onPay && i.status === 'open' ? <Button size="sm" className="mt-3 w-full" onClick={() => onPay(i)}>Pay {formatKes(i.amountDueCents)}</Button> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * M-Pesa Pay now: phone -> STK prompt -> "check your phone" (the invoice is polled) -> paid / failed.
 * One primary action per step; the amount is always visible so there is no surprise on the handset.
 */
export function PayNowModal({ invoiceId, open, onClose }: { invoiceId: string | null; open: boolean; onClose: () => void }) {
  const me = useSession((s) => s.user);
  const [phone, setPhone] = React.useState('');
  const [sentAt, setSentAt] = React.useState<number | null>(null);
  const [paymentId, setPaymentId] = React.useState<string | null>(null);
  const pay = usePayNow();
  const inv = useInvoice(open ? invoiceId : null);
  const toast = useToast();
  React.useEffect(() => { if (open) { setSentAt(null); setPaymentId(null); setPhone((p) => p || localPhone(me?.phone)); } }, [open, me?.phone]);
  const attempt = inv.data?.payments.find((p) => p.id === paymentId);
  const due = inv.data?.amountDueCents ?? 0;
  const shown = Math.ceil(due / 100) * 100;
  const paid = inv.data?.status === 'paid' || attempt?.status === 'succeeded';
  const failed = attempt?.status === 'failed';

  const send = () => {
    if (!invoiceId) return;
    pay.mutate({ id: invoiceId, phone }, {
      onSuccess: (r) => { setPaymentId(r.paymentId); setSentAt(Date.now()); void inv.refetch(); },
      onError: (e) => toast.push({ tone: 'error', title: 'Prompt not sent', description: errMsg(e) }),
    });
  };
  const step = paid ? 'paid' : failed ? 'failed' : sentAt ? 'waiting' : 'phone';
  return (
    <Modal open={open} onClose={onClose} title={step === 'paid' ? 'Payment received' : `Pay ${inv.data?.number ?? 'invoice'}`} size="sm"
      footer={step === 'phone' ? <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={send} disabled={!validPhone(phone) || pay.isPending || !inv.data}>{pay.isPending ? 'Sending…' : `Send prompt for ${formatKes(shown)}`}</Button>
      </> : step === 'waiting' ? <Button variant="outline" onClick={onClose}>Close — it will update by itself</Button>
        : step === 'failed' ? <><Button variant="outline" onClick={onClose}>Close</Button><Button onClick={() => { setSentAt(null); setPaymentId(null); }}>Try again</Button></>
          : <Button onClick={onClose}>Done</Button>}>
      {step === 'phone' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl bg-surface-2 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted">Amount</span><span className="font-semibold tabular-nums">{formatKes(shown)}</span></div>
            {shown !== due ? <p className="mt-1 text-xs text-muted">Rounded up to whole shillings; the extra is credited to your next invoice.</p> : null}
          </div>
          <Input label="M-Pesa phone number" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678"
            error={phone && !validPhone(phone) ? 'Enter a Safaricom number like 0712 345 678.' : undefined}
            hint="You'll get a prompt on this phone. Enter your M-Pesa PIN there to pay." />
        </div>
      ) : step === 'waiting' ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center" role="status" aria-live="polite">
          <span className="h-10 w-10 animate-spin rounded-full border-4 border-accent/30 border-t-accent" aria-hidden />
          <p className="font-medium">Check your phone</p>
          <p className="max-w-xs text-sm text-muted">Enter your M-Pesa PIN on {phone} to pay {formatKes(shown)}. This page confirms as soon as Safaricom does.</p>
        </div>
      ) : step === 'failed' ? (
        <div className="flex flex-col gap-2 py-2 text-sm" role="alert">
          <p className="font-medium text-down">The payment didn't go through.</p>
          <p className="text-muted">{attempt?.failureReason ?? 'The prompt was cancelled or timed out.'} Nothing was charged.</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 py-4 text-center" role="status">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-up/15 text-2xl text-up" aria-hidden>✓</span>
          <p className="font-medium">Thank you — {inv.data?.number} is paid.</p>
          {attempt?.reference ? <p className="text-sm text-muted">M-Pesa receipt {attempt.reference}</p> : null}
        </div>
      )}
    </Modal>
  );
}

/** Owner: record money that arrived outside Pay now (bank, cash, a manual M-Pesa). Defaults to the full balance. */
export function RecordPaymentModal({ inv, open, onClose }: { inv: Invoice | InvoiceSummary; open: boolean; onClose: () => void }) {
  const [method, setMethod] = React.useState('bank');
  const [amount, setAmount] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [note, setNote] = React.useState('');
  const rec = useRecordInvoicePayment();
  const toast = useToast();
  React.useEffect(() => { if (open) { setAmount(String(inv.amountDueCents / 100)); setReference(''); setNote(''); setMethod('bank'); } }, [open, inv.amountDueCents]);
  const cents = parseKes(amount);
  const bad = cents == null || cents <= 0 || cents > inv.amountDueCents;
  const save = () => rec.mutate({ id: inv.id, method, amountCents: cents!, reference: reference.trim(), note: note.trim() }, {
    onSuccess: () => { toast.push({ tone: 'success', title: 'Payment recorded', description: `${formatKes(cents!)} on ${inv.number}` }); onClose(); },
    onError: (e) => toast.push({ tone: 'error', title: 'Not recorded', description: errMsg(e) }),
  });
  return (
    <Modal open={open} onClose={onClose} title={`Record a payment on ${inv.number}`} description={`Balance due ${formatKes(inv.amountDueCents)}`} size="sm"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={bad || rec.isPending}>{rec.isPending ? 'Saving…' : 'Record payment'}</Button></>}>
      <div className="flex flex-col gap-3">
        <Select label="How was it paid?" value={method} onChange={(e) => setMethod(e.target.value)}>
          {Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Input label="Amount (KES)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
          error={amount && bad ? (cents != null && cents > inv.amountDueCents ? 'More than the balance due.' : 'Enter an amount.') : undefined}
          hint={cents != null && cents > 0 && cents < inv.amountDueCents ? `Part payment — ${formatKes(inv.amountDueCents - cents)} will still be due.` : undefined} />
        <Input label="Reference" optional value={reference} onChange={(e) => setReference(e.target.value)} placeholder={method === 'mpesa' ? 'M-Pesa receipt, e.g. QK12AB34CD' : 'Bank reference or slip number'} />
        <Input label="Note" optional value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

/** Owner: void (issued by mistake, nothing paid) or write off (won't be collected). A reason is required. */
export function CloseInvoiceModal({ inv, mode, onClose }: { inv: Invoice | InvoiceSummary; mode: 'void' | 'uncollectible' | null; onClose: () => void }) {
  const [reason, setReason] = React.useState('');
  const m = useSetInvoiceStatus();
  const toast = useToast();
  React.useEffect(() => { setReason(''); }, [mode]);
  const isVoid = mode === 'void';
  return (
    <Modal open={!!mode} onClose={onClose} size="sm" title={isVoid ? `Void ${inv.number}?` : `Write off ${inv.number}?`}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="down" disabled={!reason.trim() || m.isPending}
          onClick={() => m.mutate({ id: inv.id, status: mode!, reason: reason.trim() }, {
            onSuccess: () => { toast.push({ tone: 'success', title: isVoid ? 'Invoice voided' : 'Invoice written off' }); onClose(); },
            onError: (e) => toast.push({ tone: 'error', title: 'Not changed', description: errMsg(e) }),
          })}>{isVoid ? 'Void invoice' : 'Write off'}</Button></>}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted">{isVoid
          ? 'Use this when the invoice was sent by mistake. It stops counting as owed, and any charges on it go back to the queue for the next invoice.'
          : `Use this when ${formatKes(inv.amountDueCents)} won't be collected. It stays on record as written off and no longer holds the platform in overdue.`}</p>
        <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={isVoid ? 'e.g. Wrong plan price' : 'e.g. Agreed discount'} autoFocus />
      </div>
    </Modal>
  );
}

export function Meter({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max == null ? 0 : Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  const tone = max == null ? 'bg-up' : used >= max ? 'bg-down' : pct >= 80 ? 'bg-warn' : 'bg-up';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className={cn('tabular-nums', max != null && used >= max ? 'font-semibold text-down' : 'text-fg')}>
          {used.toLocaleString('en-KE')}{max == null ? <span className="text-muted"> · unlimited</span> : <span className="text-muted"> of {max.toLocaleString('en-KE')}</span>}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={max ?? used}>
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${max == null ? 100 : Math.max(pct, used > 0 ? 3 : 0)}%`, opacity: max == null ? 0.35 : 1 }} />
      </div>
    </div>
  );
}
