'use client';

import { Card } from '@/components/ui/Card';
import { DisplayMoney as Money } from '@/lib/money';
import { Skeleton } from '@/components/ui/Skeleton';
import { useWallet } from '@/lib/wallet/hooks';

function WageringBar({ wagered, required }: { wagered: number; required: number }) {
  const pct = required > 0 ? Math.min(100, Math.round((wagered / required) * 100)) : 100;
  return (
    <div className="flex flex-col gap-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-up transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          Wagering progress: <Money cents={wagered} /> / <Money cents={required} />
        </span>
        <span>{pct}%</span>
      </div>
    </div>
  );
}

export function WalletWidget() {
  const { data, isLoading, isError } = useWallet();

  if (isLoading) return <Skeleton className="h-28 w-full rounded-2xl" />;
  if (isError || !data)
    return (
      <Card>
        <p className="text-sm text-down">Couldn&apos;t load your balance. Pull to refresh.</p>
      </Card>
    );

  const activeBonuses = (data.bonuses ?? []).filter((b) => b.status === 'active');

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <p className="text-sm text-muted">Balance</p>
        <Money cents={data.real + data.bonus} className="text-3xl font-semibold" />
        {data.bonus > 0 ? (
          <p className="mt-1 text-xs text-muted">
            Includes <Money cents={data.bonus} className="font-medium text-fg" /> bonus — stakeable now,
            withdrawable after wagering.
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
        <span className="text-muted">Withdrawable (real cash)</span>
        <Money cents={data.real} className="font-medium" />
      </div>
      {activeBonuses.map((b) => (
        <div key={b.bonusId} className="flex flex-col gap-1 border-t border-border pt-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">
              Bonus <Money cents={b.amount} /> ({b.wageringX}× wagering)
            </span>
          </div>
          <WageringBar wagered={b.wagered} required={b.required} />
          <p className="text-xs text-muted">
            Wager <Money cents={b.remaining} /> more to convert this bonus to withdrawable cash.
          </p>
        </div>
      ))}
    </Card>
  );
}
