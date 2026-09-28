'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { DepositForm } from '@/components/wallet/DepositForm';
import { PayBillDeposit } from '@/components/wallet/PayBillDeposit';
import { LipwaDeposit } from '@/components/wallet/LipwaDeposit';
import { useDepositProviders } from '@/lib/wallet/hooks';
import type { DepositMethodDto, DepositProviderDto } from '@/lib/api/types';

/**
 * Deposit surface, driven ENTIRELY by what the server says this brand can actually serve
 * (GET /deposits/providers → `methods`).
 *
 * The server resolves the system owner's gateway switches (migration 0116) AND each channel's real
 * readiness, so a channel only appears here if a player can complete it. That distinction matters:
 * an enabled gateway does NOT imply every rail works — PayHero's Lipwa checkout additionally needs
 * `lipwa_url`, and the manual Pay Bill is the System owner's and is hidden for a brand on its own
 * accounts. This panel previously inferred tabs from provider codes and so rendered a "Card & Bank"
 * tab that threw PAYHERO_LIPWA_NOT_CONFIGURED on submit.
 *
 * The gateway BRAND is never shown (docs/35) — the server labels every STK rail "M-Pesa". With one
 * method the tab strip is hidden entirely. Each body owns its state; `key` forces a clean remount so
 * a half-typed amount/code never leaks across methods.
 */

/** Legacy fallback: older API builds return only `providers`. One "M-Pesa" STK entry per gateway. */
function methodsFromProviders(providers: DepositProviderDto[]): DepositMethodDto[] {
  return providers.map((p, i) => ({
    id: `${p.code}-stk`,
    provider: p.code,
    channel: 'stk' as const,
    label: providers.length > 1 ? `M-Pesa (${i + 1})` : 'M-Pesa',
  }));
}

export function DepositPanel() {
  const { data, isLoading } = useDepositProviders();
  const methods: DepositMethodDto[] = data?.methods ?? methodsFromProviders(data?.providers ?? []);

  const [method, setMethod] = useState<string | null>(null);
  // Default to the first available method; if the chosen one disappears (switched off mid-session),
  // fall back to the first still-available method.
  const active = method && methods.some((m) => m.id === method) ? method : methods[0]?.id ?? null;
  const activeMethod = methods.find((m) => m.id === active) ?? null;

  if (isLoading) {
    return <p className="px-5 py-6 text-center text-sm text-muted">Loading payment options…</p>;
  }
  if (methods.length === 0) {
    return (
      <p className="px-5 py-6 text-center text-sm text-muted">
        Deposits are temporarily unavailable. Please check back shortly.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {methods.length > 1 ? (
        <div className="px-5 pt-3">
          <div className="flex rounded-xl border border-border bg-surface-2 p-1" role="tablist" aria-label="Deposit method">
            {methods.map((m) => {
              const isActive = active === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setMethod(m.id)}
                  className={cn(
                    'flex-1 rounded-lg py-2 text-sm font-semibold transition',
                    isActive ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:text-fg',
                  )}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {activeMethod?.channel === 'stk' ? (
        <DepositForm key={activeMethod.id} provider={activeMethod.provider as 'mpesa' | 'megapay' | 'payhero'} />
      ) : null}
      {activeMethod?.channel === 'lipwa' ? <LipwaDeposit key={activeMethod.id} /> : null}
      {activeMethod?.channel === 'paybill' ? <PayBillDeposit key={activeMethod.id} /> : null}
    </div>
  );
}
