'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatKes } from '@invest254/shared/money';
import { useToast } from '@/lib/toast/ToastProvider';
import { useReferral } from '@/lib/affiliate/hooks';

/**
 * Player-facing "invite & earn" card (item 3): every user has a referral code + link. A player earns
 * 5% of every deposit made by someone who signs up with their code, credited straight to their wallet.
 * The full link uses the current brand's origin, so it is always the right site.
 */
export function ReferralInviteCard() {
  const { data: r } = useReferral();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  if (!r || !r.referralCode) return null;

  const link =
    typeof window !== 'undefined' && r.referralPath ? `${window.location.origin}${r.referralPath}` : (r.referralPath ?? '');

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.push({ tone: 'success', title: 'Copied', description: `${what} copied to clipboard.` });
    } catch {
      toast.push({ tone: 'error', title: 'Copy failed', description: 'Long-press to copy manually.' });
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Invite &amp; earn 5%</h2>
        {r.earnedCents > 0 ? (
          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Earned {formatKes(r.earnedCents)}</span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Share your link — you earn 5% of every deposit your friends make, straight to your wallet.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-800">
          <span className="truncate text-sm text-gray-700 dark:text-gray-300">{link}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => copy(r.referralCode!, 'Code')} className="whitespace-nowrap">
            Code: {r.referralCode}
          </Button>
          <Button onClick={() => copy(link, 'Link')} className="whitespace-nowrap">
            {copied ? 'Copied!' : 'Copy link'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
