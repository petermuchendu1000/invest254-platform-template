'use client';

import * as React from 'react';
import Link from 'next/link';
import { formatKes } from '@invest254/shared/money';
import { useCan } from '@/lib/auth/can';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty } from '@/components/admin/ui';
import { useInvoice } from '@/lib/billing/api';
import { InvoiceDocument } from '@/components/billing/InvoiceDocument';
import { CloseInvoiceModal, InvoicePill, PayNowModal, RecordPaymentModal } from '@/components/billing/parts';

/** BILL-1: one invoice — the printable document plus only the actions this viewer may take. */
export default function InvoiceView({ params }: { params: { id: string } }) {
  const isOwner = useCan('console.system');
  const q = useInvoice(params.id);
  const [pay, setPay] = React.useState(false);
  const [record, setRecord] = React.useState(false);
  const [close, setClose] = React.useState<'void' | 'uncollectible' | null>(null);
  const inv = q.data;
  if (q.isLoading) return <Skeleton className="h-[480px] w-full" />;
  if (!inv) return <Empty title="Invoice not found" description="It may belong to another platform, or the link is wrong." action={<Link href="/platform/billing" className="text-accent hover:underline">Back to billing</Link>} />;
  const open = inv.status === 'open';
  const pending = inv.payments.some((p) => p.status === 'pending');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex min-w-0 flex-col gap-1">
          <Link href={isOwner ? '/platform/billing?tab=invoices' : '/platform/billing'} className="text-sm text-muted hover:text-fg">← Billing</Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-xl font-semibold tracking-tight">{inv.number}</h1>
            <InvoicePill inv={inv} />
          </div>
          <p className="text-sm text-muted">{inv.platformName} · {formatKes(inv.totalCents)}{open ? ` · ${formatKes(inv.amountDueCents)} due` : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => window.print()}>Print / Save PDF</Button>
          {isOwner && open ? <>
            <Button variant="outline" size="sm" onClick={() => setClose('uncollectible')}>Write off</Button>
            {inv.amountPaidCents === 0 ? <Button variant="outline" size="sm" onClick={() => setClose('void')}>Void</Button> : null}
            <Button variant="secondary" size="sm" onClick={() => setRecord(true)}>Record payment</Button>
          </> : null}
          {open && inv.seller.mpesaPayEnabled ? <Button size="sm" onClick={() => setPay(true)} disabled={pending}>{pending ? 'Waiting for PIN…' : `Pay ${formatKes(inv.amountDueCents)}`}</Button> : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-4xl">
        <InvoiceDocument inv={inv} />
      </div>
      <PayNowModal invoiceId={inv.id} open={pay} onClose={() => setPay(false)} />
      {isOwner ? <RecordPaymentModal inv={inv} open={record} onClose={() => setRecord(false)} /> : null}
      {isOwner ? <CloseInvoiceModal inv={inv} mode={close} onClose={() => setClose(null)} /> : null}
    </div>
  );
}
