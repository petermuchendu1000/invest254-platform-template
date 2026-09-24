'use client';

import * as React from 'react';
import Link from 'next/link';
import { useGatewayConfigs, usePaymentProviders } from '@/lib/platform/hooks';
import { useMpesaConfig } from '@/lib/admin/hooks';
import { GatewayLogo } from '@/components/platform/GatewayLogo';
import { Skeleton } from '@/components/ui/Skeleton';
import { gatewayCopy } from '@/lib/payments/gatewayCopy';
import { cn } from '@/lib/cn';

type Status = { label: string; tone: 'up' | 'warn' | 'muted' | 'info' };
const TONE: Record<Status['tone'], string> = {
  up: 'bg-up/15 text-up', warn: 'bg-warn/15 text-warn', muted: 'bg-surface-2 text-muted', info: 'bg-info/15 text-info',
};

/**
 * UI-D — the System owner's gateways as ONE scannable list (Stripe "payment methods" pattern): what each does,
 * its state in one word, whether players are offered it (switch right there), and Manage. M-Pesa is listed
 * first (it was missing from this page, living on a separate one).
 */
export function PaymentsIndex() {
  const { data, isLoading } = useGatewayConfigs();
  const { data: providers } = usePaymentProviders();
  const mpesa = useMpesaConfig();
  if (isLoading) return <Skeleton className="h-72 w-full" />;
  const enabledOf = new Map((providers?.providers ?? []).map((p) => [p.code, p.enabledGlobal]));
  const items = data?.providers ?? [];
  const m = mpesa.data;
  const mpesaReady = !!m && !!m.shortcode && m.hasConsumerKey && m.hasConsumerSecret && m.hasPasskey;
  const mpesaPayouts = !!m && !!m.b2cInitiator && m.hasSecurityCredential;
  const live = items.filter((i) => i.schema.playerAvailable && enabledOf.get(i.code) && i.config.hasSecret).length + (mpesaReady ? 1 : 0);

  // UI-F: this list only shows state; switching a gateway on/off for players has one home — its own page.
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        <b className="text-fg">{live}</b> of {items.length + 1} gateways are live for players on the System accounts.
        Brands that use their own accounts set them up under <Link href="/platform/payment-accounts" className="text-accent hover:underline">Payment accounts</Link>.
      </p>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface" aria-label="Gateways">
        <Row
          code="mpesa" name="M-Pesa (Daraja)" href="/platform/mpesa"
          summary={gatewayCopy('mpesa', '').summary} offers={['Deposits', 'Payouts']}
          status={!m ? { label: '…', tone: 'muted' } : mpesaReady ? (mpesaPayouts ? { label: 'Live', tone: 'up' } : { label: 'Live · payouts not set up', tone: 'warn' }) : { label: 'Not set up', tone: 'warn' }}
        />
        {items.map(({ code, schema, config }) => {
          const copy = gatewayCopy(code, schema.blurb, schema.playerAvailable);
          const enabled = enabledOf.get(code) ?? false;
          const status: Status = !schema.playerAvailable
            ? { label: config.hasSecret ? 'Saved · coming soon' : 'Coming soon', tone: 'info' }
            : !config.hasSecret ? { label: 'Not set up', tone: 'muted' }
              : enabled ? { label: 'Live', tone: 'up' } : { label: 'Ready · not offered', tone: 'warn' };
          return <Row key={code} code={code} name={schema.displayName} href={`/platform/payments/${code}`} summary={copy.summary} offers={copy.offers} status={status} />;
        })}
      </ul>
    </div>
  );
}

function Row({ code, name, href, summary, offers, status }: {
  code: string; name: string; href: string; summary: string; offers: string[]; status: Status;
}) {
  return (
    <li className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 p-4 md:grid-cols-[auto_1fr_auto_auto]">
      <div className="flex w-28 justify-center"><GatewayLogo code={code} name={name} /></div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-fg">{name}</span>
          {offers.map((o) => <span key={o} className="rounded border border-border px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">{o}</span>)}
        </div>
        <p className="mt-0.5 text-xs text-muted">{summary}</p>
      </div>
      <span className={cn('col-start-2 w-fit whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium md:col-start-auto', TONE[status.tone])}>{status.label}</span>
      <Link href={href} className="col-start-2 inline-flex h-9 w-fit items-center rounded-brand border border-border px-3 text-sm font-medium transition hover:bg-surface-2 md:col-start-auto">Manage</Link>
    </li>
  );
}

export function Switch({ checked, onChange, disabled, label, title }: { checked: boolean; onChange: (n: boolean) => void; disabled?: boolean; label: string; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50', checked ? 'bg-accent' : 'bg-border')}>
      <span className={cn('inline-block h-5 w-5 transform rounded-full bg-white shadow transition', checked ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}
