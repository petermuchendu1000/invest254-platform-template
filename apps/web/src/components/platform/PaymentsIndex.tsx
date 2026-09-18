'use client';

import Link from 'next/link';
import { useGatewayConfigs, usePaymentProviders } from '@/lib/platform/hooks';
import { GatewayLogo } from '@/components/platform/GatewayLogo';

/** Payments hub: one card per gateway, each linking to its dedicated configuration page. */
export function PaymentsIndex() {
  const { data, isLoading } = useGatewayConfigs();
  const { data: providers } = usePaymentProviders();
  if (isLoading) return <p className="text-sm text-muted">Loading gateways…</p>;
  const enabledOf = new Map((providers?.providers ?? []).map((p) => [p.code, p.enabledGlobal]));
  const items = data?.providers ?? [];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {items.map(({ code, schema, config }) => {
        const enabled = enabledOf.get(code) ?? false;
        return (
          <Link key={code} href={`/platform/payments/${code}`}
            className="group flex flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-5 transition hover:border-accent/50 hover:bg-surface">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <GatewayLogo code={code} name={schema.displayName} />
                <div>
                  <div className="text-sm font-semibold text-fg">{schema.displayName}</div>
                  <div className="text-[11px] text-muted">{code}</div>
                </div>
              </div>
              {schema.playerAvailable ? (
                <span className={['rounded-full border px-2 py-0.5 text-[11px] font-medium', enabled ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : 'border-border bg-border/30 text-muted'].join(' ')}>
                  {enabled ? 'Live' : 'Hidden'}
                </span>
              ) : (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">Config only</span>
              )}
            </div>
            <p className="line-clamp-2 text-xs text-muted">{schema.blurb}</p>
            <div className="mt-auto flex items-center justify-between pt-1">
              <span className={['text-[11px] font-medium', config.hasSecret ? 'text-accent' : 'text-muted'].join(' ')}>
                {config.hasSecret ? '● Configured' : config.exists ? '◐ Settings only' : '○ Not configured'}
              </span>
              <span className="text-xs font-semibold text-fg group-hover:text-accent">Configure →</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
