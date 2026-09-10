'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { DepositForm } from '@/components/wallet/DepositForm';
import { PayBillDeposit } from '@/components/wallet/PayBillDeposit';
import { useDepositProviders } from '@/lib/wallet/hooks';

type Method = 'stk' | 'megapay' | 'paybill';
interface MethodDef { id: Method; label: string }

/**
 * Deposit surface with a method switch, driven ENTIRELY by the superadmin gateway switches
 * (migration 0116, GET /deposits/providers). The 'mpesa' provider governs the Daraja rails
 * ("STK Push" + "Pay Bill"); the 'megapay' provider governs the "Mega Pay" tab. A gateway the
 * superadmin switched off for this brand disappears here — so turning M-Pesa off hides both
 * STK Push and Pay Bill, and turning Mega Pay on adds its tab. Each body owns its own state; the
 * `key` forces a clean remount when switching so a half-typed amount/code never leaks across methods.
 */
export function DepositPanel() {
  const { data: providers, isLoading } = useDepositProviders();
  const mpesaOn = (providers ?? []).some((p) => p.code === 'mpesa');
  const megapayOn = (providers ?? []).some((p) => p.code === 'megapay');

  const methods: MethodDef[] = [
    ...(mpesaOn ? [{ id: 'stk' as Method, label: 'M-Pesa' }] : []),
    ...(megapayOn ? [{ id: 'megapay' as Method, label: mpesaOn ? 'M-Pesa (2)' : 'M-Pesa' }] : []),
    ...(mpesaOn ? [{ id: 'paybill' as Method, label: 'Pay Bill' }] : []),
  ];

  const [method, setMethod] = useState<Method | null>(null);
  // Default to the first available method; if the chosen one disappears (switched off mid-session),
  // fall back to the first still-available method.
  const active = method && methods.some((m) => m.id === method) ? method : methods[0]?.id ?? null;

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
      {active === 'stk' ? <DepositForm key="stk" provider="mpesa" /> : null}
      {active === 'megapay' ? <DepositForm key="megapay" provider="megapay" /> : null}
      {active === 'paybill' ? <PayBillDeposit key="paybill" /> : null}
    </div>
  );
}
