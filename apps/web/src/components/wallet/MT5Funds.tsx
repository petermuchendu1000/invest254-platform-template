'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useWallet, useWalletFigures, useTransactions } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useDisplayMoney } from '@/lib/money';
import { useBrand } from '@/lib/brand/BrandProvider';
import { mt5ServerName } from '@/lib/brand/mt5Server';
import { MT5TitleBar, MT5Summary, MT5SummaryLine, MT5Section, MT5Entry, MT5Amount, MT5Empty } from '@/components/mt5/kit';
import { isCompleted, signedCents, stamp } from '@/lib/history/mt5history';
import type { TransactionDto } from '@/lib/api/types';
import { cn } from '@/lib/cn';

/**
 * The funding screen, in the terminal's chrome.
 *
 * MetaTrader has no deposit screen — funding is the broker's, not the terminal's — so this is the one
 * screen in the conversion with no original to copy. It is built from MetaTrader's own vocabulary and
 * parts instead: the title bar, the dotted-leader figures the Toolbox and the History screen use, its
 * confirmation green on the primary action, and its two-line entries for the balance operations
 * underneath. Inventing a MetaTrader screen name for it would be the dishonest option; it is called
 * what it is.
 *
 * The figures come from `walletFigures`, which is the single gate every surface asks before offering
 * any way out — a demo balance is play money and is never presented as cashable, not even as a
 * disabled control. That rule is unchanged here.
 */
export function MT5Funds() {
  const { data: wallet } = useWallet();
  const figures = useWalletFigures();
  const money = useDisplayMoney();
  const brand = useBrand();
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);

  const txQ = useTransactions();
  const recent: TransactionDto[] = useMemo(
    () => (txQ.data?.pages ?? []).flatMap((p) => p.items).slice(0, 8),
    [txQ.data],
  );

  const bonus = wallet?.bonus ?? 0;
  const balance = (wallet?.real ?? 0) + bonus;
  const server = mt5ServerName(brand, figures.demo ? 'demo' : 'real');

  return (
    <div className="flex flex-1 flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)]">
      <MT5TitleBar title="Funds" back subtitle={figures.demo ? 'Demo account' : 'Real account'} />

      <div className="mx-auto w-full lg:max-w-3xl">
        <MT5Summary>
          <MT5SummaryLine label="Balance" value={money.fmt(balance)} />
          {bonus > 0 ? <MT5SummaryLine label="Bonus" value={money.fmt(bonus)} /> : null}
          {/* Shown only where money can actually leave. On a demo account there is no withdrawable
              figure to show, because there is none. */}
          {figures.canWithdraw ? <MT5SummaryLine label="Withdrawable" value={money.fmt(figures.withdrawable)} /> : null}
          <MT5SummaryLine label="Server" value={server} />
        </MT5Summary>

        <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row">
          <button
            type="button"
            onClick={() => openDeposit()}
            className="flex-1 rounded bg-[var(--mt5-blue)] px-4 py-3 text-[14px] font-semibold text-white transition hover:bg-[#2567cc]"
          >
            Deposit
          </button>
          {/* DEMO-3: on a demo account Withdraw is ABSENT, not disabled — a greyed-out control still
              tells a player their play money is cashable in principle. */}
          {figures.canWithdraw ? (
            <button
              type="button"
              onClick={openWithdraw}
              className="flex-1 rounded border border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-4 py-3 text-[14px] font-semibold text-[var(--mt5-text)] transition hover:bg-[var(--mt5-border)]"
            >
              Withdraw
            </button>
          ) : null}
        </div>

        {figures.demo ? (
          <p className="px-3 pb-3 text-[12px] leading-snug text-[var(--mt5-muted)]">
            This is practice money: not real cash, and never withdrawable. Switch to your real account
            to deposit or withdraw.
          </p>
        ) : bonus > 0 ? (
          <p className="px-3 pb-3 text-[12px] leading-snug text-[var(--mt5-muted)]">
            {/* MetaTrader's own word for money a broker adds that is not a deposit is CREDIT, and
                it is a field of the account alongside Balance and Equity. "Stakeable" and
                "wagering" are this platform's older vocabulary and not a terminal's. */}
            Includes {money.fmt(bonus)} credit: tradable now, withdrawable once it has been traded.
          </p>
        ) : null}

        <MT5Section title="Balance operations">
          {txQ.isLoading ? (
            <MT5Empty>Loading…</MT5Empty>
          ) : recent.length === 0 ? (
            <MT5Empty>No deposits or withdrawals yet.</MT5Empty>
          ) : (
            recent.map((t) => (
              <MT5Entry
                key={t.id}
                title="Balance"
                time={stamp(t.ts)}
                detail={
                  <span className={cn(!isCompleted(t) && 'text-[#f0b90b]')}>
                    {t.kind === 'withdrawal' ? 'Withdrawal' : 'Deposit'}
                    {isCompleted(t) ? '' : ` · ${t.status}`}
                  </span>
                }
                // A pending deposit has not moved the balance yet, so it carries no amount — the same
                // rule the History screen's Deals tab applies.
                result={isCompleted(t) ? <MT5Amount cents={signedCents(t)} fmt={money.fmt} /> : <span className="text-[var(--mt5-muted)]">-</span>}
              />
            ))
          )}
          <Link
            href="/history"
            className="flex items-center justify-between border-b border-[var(--mt5-border)] px-3 py-3 text-[13px] text-[var(--mt5-blue-link)]"
          >
            See the full history
            <span aria-hidden>›</span>
          </Link>
        </MT5Section>

        <div className="h-6" />
      </div>
    </div>
  );
}
