'use client';

import * as React from 'react';
import { formatKes } from '@invest254/shared/money';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Invoice } from '@/lib/billing/api';
import { LINE_KIND, METHOD, bpToPct, invoiceState } from '@/lib/billing/labels';
import { mpesaRefFor } from '@/lib/billing/ref';

/**
 * A printable invoice (the Stripe/Xero layout): seller and "Invoice" + number at the top, bill-to and the key
 * dates, lines grouped as the platform reads them (plan first, then each brand's add-ons), totals, then how to
 * pay. It is the page itself — Print / Save as PDF uses the browser, and the console chrome is hidden in print.
 */
export function InvoiceDocument({ inv }: { inv: Invoice }) {
  const state = invoiceState(inv);
  const stamp = inv.status === 'paid' ? 'PAID' : inv.status === 'void' ? 'VOID' : inv.status === 'uncollectible' ? 'WRITTEN OFF' : inv.overdue ? 'OVERDUE' : null;
  return (
    <article className="rounded-2xl border border-border bg-surface p-5 text-sm sm:p-8 print:rounded-none print:border-0 print:p-0" aria-label={`Invoice ${inv.number}`}>
      <header className="flex flex-col-reverse gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-base font-semibold">{inv.seller.name}</div>
          {inv.seller.address ? <div className="whitespace-pre-line text-muted">{inv.seller.address}</div> : null}
          <div className="text-muted">{[inv.seller.email, inv.seller.phone].filter(Boolean).join(' · ')}</div>
          {inv.seller.taxPin ? <div className="text-muted">KRA PIN {inv.seller.taxPin}</div> : null}
        </div>
        <div className="sm:text-right">
          <div className="text-2xl font-bold tracking-tight">Invoice</div>
          <div className="font-mono text-base">{inv.number}</div>
        </div>
      </header>

      <section className="grid gap-4 border-b border-border py-5 sm:grid-cols-[1.4fr_1fr]">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Bill to</div>
          <div className="mt-1 font-semibold">{inv.platformName}</div>
          <div className="text-muted">Platform account</div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          <dt className="text-muted">Issued</dt><dd className="text-right tabular-nums">{formatDate(inv.issuedAt)}</dd>
          <dt className="text-muted">Due</dt><dd className={cn('text-right tabular-nums', inv.overdue && 'font-semibold text-down')}>{formatDate(inv.dueAt)}</dd>
          {inv.periodStart ? <><dt className="text-muted">Service period</dt><dd className="text-right tabular-nums sm:whitespace-nowrap">{formatDate(inv.periodStart)} – {formatDate(inv.periodEnd!)}</dd></> : null}
          <dt className="text-muted">Status</dt><dd className="text-right font-medium">{state.label}</dd>
        </dl>
      </section>

      <div className="-mx-5 overflow-x-auto sm:mx-0">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <th className="px-5 py-2.5 text-left font-medium sm:px-0">Description</th>
              <th className="px-2 py-2.5 text-right font-medium">Qty</th>
              <th className="px-2 py-2.5 text-right font-medium">Unit</th>
              <th className="px-5 py-2.5 text-right font-medium sm:px-0">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-5 py-3 sm:px-0">
                  <div className="font-medium">{l.description}</div>
                  <div className="text-xs text-muted">{LINE_KIND[l.kind] ?? l.kind}{l.periodStart ? ` · ${formatDate(l.periodStart)} – ${formatDate(l.periodEnd!)}` : ''}</div>
                </td>
                <td className="px-2 py-3 text-right tabular-nums">{l.quantity}</td>
                <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums">{formatKes(l.unitCents)}</td>
                <td className={cn('whitespace-nowrap px-5 py-3 text-right tabular-nums sm:px-0', l.amountCents < 0 && 'text-up')}>{formatKes(l.amountCents)}</td>
              </tr>
            ))}
            {!inv.lines.length ? <tr><td colSpan={4} className="py-6 text-center text-muted">No lines.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <section className="flex items-center justify-between gap-4 border-t border-border pt-4">
        {stamp ? (
          <span aria-hidden className={cn('ml-2 hidden -rotate-12 select-none rounded-md border-4 px-3 py-1 text-xl font-black tracking-widest opacity-25 sm:block',
            stamp === 'PAID' ? 'border-up text-up' : stamp === 'OVERDUE' ? 'border-down text-down' : 'border-muted text-muted')}>{stamp}</span>
        ) : <span />}
        <dl className="grid w-full max-w-xs grid-cols-2 gap-y-1.5">
          <dt className="text-muted">Subtotal</dt><dd className="text-right tabular-nums">{formatKes(inv.subtotalCents)}</dd>
          {inv.taxRateBp > 0 ? <><dt className="text-muted">{inv.seller.taxLabel} {bpToPct(inv.taxRateBp)}</dt><dd className="text-right tabular-nums">{formatKes(inv.taxCents)}</dd></> : null}
          <dt className="border-t border-border pt-1.5 font-semibold">Total</dt><dd className="border-t border-border pt-1.5 text-right font-semibold tabular-nums">{formatKes(inv.totalCents)}</dd>
          {inv.amountPaidCents > 0 ? <><dt className="text-muted">Paid</dt><dd className="text-right tabular-nums text-up">−{formatKes(inv.amountPaidCents)}</dd></> : null}
          <dt className="text-base font-bold">Amount due</dt>
          <dd className={cn('text-right text-base font-bold tabular-nums', inv.overdue && 'text-down')}>{formatKes(inv.status === 'open' ? inv.amountDueCents : 0)}</dd>
        </dl>
      </section>

      {inv.status === 'open' ? (
        <section className="mt-6 grid gap-4 rounded-xl bg-surface-2 p-4 sm:grid-cols-2 print:bg-transparent print:p-0">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Pay by M-Pesa</div>
            <p className="mt-1">{inv.seller.mpesaPayEnabled ? 'Use Pay now on this page — a prompt is sent to your phone.' : 'Pay using the instructions alongside.'}</p>
            <p className="mt-1 text-muted">Account / reference: <span className="font-mono text-fg">{mpesaRefFor(inv.number)}</span></p>
          </div>
          {inv.seller.paymentInstructions ? (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted">Other ways to pay</div>
              <p className="mt-1 whitespace-pre-line">{inv.seller.paymentInstructions}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      {inv.notes ? <p className="mt-5 whitespace-pre-line text-muted"><span className="font-medium text-fg">Note: </span>{inv.notes}</p> : null}
      {inv.statusReason && (inv.status === 'void' || inv.status === 'uncollectible') ? <p className="mt-2 text-muted">{inv.status === 'void' ? 'Voided' : 'Written off'}: {inv.statusReason}</p> : null}

      {inv.payments.length ? (
        <section className="mt-6">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Payments</div>
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {inv.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium">{METHOD[p.method] ?? p.method}{p.reference ? <span className="font-mono text-muted"> · {p.reference}</span> : null}</div>
                  <div className="text-xs text-muted">{formatDateTime(p.settledAt ?? p.createdAt)}{p.phone ? ` · ${p.phone}` : ''}{p.failureReason ? ` · ${p.failureReason}` : ''}{p.note ? ` · ${p.note}` : ''}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium',
                    p.status === 'succeeded' ? 'bg-up/15 text-up' : p.status === 'pending' ? 'bg-warn/15 text-warn' : 'bg-surface-2 text-muted')}>
                    {p.status === 'succeeded' ? 'Received' : p.status === 'pending' ? 'Waiting for PIN' : 'Failed'}
                  </span>
                  <span className="whitespace-nowrap font-medium tabular-nums">{formatKes(p.amountCents)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {inv.seller.footerNote ? <footer className="mt-6 border-t border-border pt-4 text-center text-xs text-muted">{inv.seller.footerNote}</footer> : null}
    </article>
  );
}
