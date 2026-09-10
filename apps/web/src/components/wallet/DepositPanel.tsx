'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { DepositForm } from '@/components/wallet/DepositForm';
import { PayBillDeposit } from '@/components/wallet/PayBillDeposit';
import { useDepositProviders } from '@/lib/wallet/hooks';

type Method = 'stk' | 'megapay' | 'paybill';
interface MethodDef { id: Method; label: string }

/**
 * Deposit surface with a method switch. "STK Push" (M-Pesa prompt) and "Pay Bill" are always
 * present; "Mega Pay" (migration 0116) appears ONLY when the superadmin has switched that gateway on
 * for this brand (GET /deposits/providers resolves the global switch + per-site override). Each body
 * owns its own state; the `key` forces a clean remount when switching so a half-typed amount/code
 * never leaks across methods.
 */
export function DepositPanel() {
  const { data: providers } = useDepositProviders();
  const megapayOn = (providers ?? []).some((p) => p.code === 'megapay');

  const methods: MethodDef[] = [
    { id: 'stk', label: 'STK Push' },
    ...(megapayOn ? [{ id: 'megapay' as Method, label: 'Mega Pay' }] : []),
    { id: 'paybill', label: 'Pay Bill' },
  ];

  const [method, setMethod] = useState<Method>('stk');
  // If the selected method disappears (e.g. Mega Pay switched off mid-session), fall back to STK.
  const active = methods.some((m) => m.id === method) ? method : 'stk';

  return (
    <div className="flex flex-col">
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
      {active === 'stk' ? <DepositForm key="stk" provider="mpesa" /> : null}
      {active === 'megapay' ? <DepositForm key="megapay" provider="megapay" /> : null}
      {active === 'paybill' ? <PayBillDeposit key="paybill" /> : null}
    </div>
  );
}
