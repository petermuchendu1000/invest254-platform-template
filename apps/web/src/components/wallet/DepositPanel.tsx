'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { DepositForm } from '@/components/wallet/DepositForm';
import { PayBillDeposit } from '@/components/wallet/PayBillDeposit';

type Method = 'stk' | 'paybill';
const METHODS: { id: Method; label: string }[] = [
  { id: 'stk', label: 'STK Push' },
  { id: 'paybill', label: 'Pay Bill' },
];

/**
 * Deposit surface with a method switch: "STK Push" (send an M-PESA prompt to the phone) and "Pay Bill"
 * auto-verified by confirmation code). Each body owns its own state; the key forces a clean remount
 * when switching so a half-typed amount/code never leaks across methods.
 */
export function DepositPanel() {
  const [method, setMethod] = useState<Method>('stk');
  return (
    <div className="flex flex-col">
      <div className="px-5 pt-3">
        <div className="flex rounded-xl border border-border bg-surface-2 p-1" role="tablist" aria-label="Deposit method">
          {METHODS.map((m) => {
            const active = method === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMethod(m.id)}
                className={cn(
                  'flex-1 rounded-lg py-2 text-sm font-semibold transition',
                  active ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:text-fg',
                )}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>
      {method === 'stk' ? <DepositForm key="stk" /> : <PayBillDeposit key="paybill" />}
    </div>
  );
}
