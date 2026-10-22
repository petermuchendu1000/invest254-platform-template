 'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { TransactionsList } from '@/components/wallet/TransactionsList';
import { LedgerList } from '@/components/wallet/LedgerList';
import { PositionHistory } from '@/components/positions/PositionHistory';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { dealsTabLabel } from '@/lib/game/dealWording';

type Tab = 'transactions' | 'ledger' | 'positions';

export function HistoryTabs() {
  // A terminal brand heads this `Deals`, as MetaTrader's History tab does. The classic shell keeps
  // `Bets`, because it is not pretending to be MetaTrader. See lib/game/dealWording.
  const terminal = useTerminalSkin();
  const [tab, setTab] = useState<Tab>('transactions');
  return (
    <div className="flex flex-col gap-3">
      <div className="inline-flex w-full rounded-xl border border-border bg-surface p-1 sm:w-auto">
        <TabButton active={tab === 'transactions'} onClick={() => setTab('transactions')}>
          Transactions
        </TabButton>
        <TabButton active={tab === 'ledger'} onClick={() => setTab('ledger')}>
          Ledger
        </TabButton>
        <TabButton active={tab === 'positions'} onClick={() => setTab('positions')}>
          {dealsTabLabel(terminal)}
        </TabButton>
      </div>
      {tab === 'transactions' ? (
        <TransactionsList />
      ) : tab === 'ledger' ? (
        <LedgerList />
      ) : (
        <PositionHistory />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-9 flex-1 rounded-lg px-4 text-sm font-medium transition sm:flex-none',
        active ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
