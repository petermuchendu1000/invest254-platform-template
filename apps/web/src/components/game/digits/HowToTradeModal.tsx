'use client';

import { useEffect } from 'react';
import { useDigitSession } from '@/lib/game/digitSession';
import { DIcon } from '@/components/game/digits/icons';

const SECTIONS: { title: string; body: string }[] = [
  { title: 'How a contract works', body: 'Choose a contract type and a side, then tap it. When the contract settles it shows a result digit (0-9), and it wins if that digit meets the condition of the side you chose. The chart shows the index price; the row of circles under it shows how often each last digit appeared over the recent ticks.' },
  { title: 'Even / Odd', body: 'Even wins when the result digit is 0, 2, 4, 6 or 8. Odd wins when it is 1, 3, 5, 7 or 9.' },
  { title: 'Match / Differ', body: 'Pick a digit. Match wins only if the result digit is exactly that digit. Differ wins if it is any other digit, so it wins more often but pays less.' },
  { title: 'Over / Under', body: 'Pick a digit. Over wins when the result digit is higher than it; Under wins when it is lower. If it is equal, both lose.' },
  { title: 'Stake and payout', body: 'Your stake is taken when the contract opens. Each button shows the total you receive if that side wins and the profit as a percentage of your stake. If it does not win, the stake is lost. Switch Stake to Payout to enter the amount you want back instead.' },
  { title: 'Manual and Auto', body: 'Manual places one contract per tap. Auto keeps placing contracts on the side you choose until it reaches your Target profit or your Stop loss, or you press Stop. After each loss Auto multiplies the next stake by Mult, so losses can grow quickly: set a stop loss you can afford.' },
  { title: 'Digit statistics', body: 'The percentages describe past ticks only. They do not predict the next digit.' },
];

/** How to Trade (digits broker mock): plain rules for each contract, stake/payout and Auto. */
export function HowToTradeModal() {
  const open = useDigitSession((s) => s.howToOpen);
  const setOpen = useDigitSession((s) => s.setHowToOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="How to trade">
      <button aria-label="Close" className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={() => setOpen(false)} />
      <div className="relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border bg-gradient-to-r from-accent/10 to-transparent px-5 py-4">
          <span className="grid h-9 w-9 place-items-center rounded-xl border border-accent/40 bg-accent/10 text-accent"><DIcon name="book" className="h-5 w-5" /></span>
          <div className="flex-1">
            <h2 className="text-[14px] font-semibold text-fg">How to Trade</h2>
            <p className="text-[11px] text-muted">Digit contracts in one minute</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg"><DIcon name="close" className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3 className="text-[13px] font-semibold text-fg">{s.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{s.body}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
