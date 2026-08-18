'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useSession } from '@/lib/auth/session';
import { useHydrated } from '@/lib/useHydrated';
import { useToast } from '@/lib/toast/ToastProvider';
import { formatDateTime } from '@/lib/format';
import { formatKes } from '@invest254/shared/money';
import { useMeReferral, useMeReferralReferred, useMeReferralCommissions } from '@/lib/referral/hooks';
import type { CommissionEventDto } from '@/lib/api/types';

/** Mask a referred handle so the referrer never sees full PII. */
function mask(username: string): string {
  const u = (username ?? '').replace(/^@/, '');
  if (u.length <= 2) return `@${u[0] ?? ''}•••`;
  return `@${u.slice(0, 2)}•••${u.slice(-1)}`;
}

const LEVEL_LABEL: Record<number, string> = { 1: 'Direct', 2: 'Level 2', 3: 'Level 3' };

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className="text-xl font-semibold text-fg">{value}</span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </Card>
  );
}

export default function ReferralPage() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const toast = useToast();

  const info = useMeReferral();
  const referred = useMeReferralReferred();
  const commissions = useMeReferralCommissions();

  const events: CommissionEventDto[] = useMemo(
    () => (commissions.data?.pages ?? []).flatMap((p) => p.items),
    [commissions.data],
  );

  async function copyLink() {
    const link = info.data?.link ?? info.data?.referralPath;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.push({ tone: 'success', title: 'Referral link copied' });
    } catch {
      toast.push({ tone: 'error', title: 'Copy failed', description: 'Copy it manually.' });
    }
  }

  if (!hydrated) return <div className="mx-auto w-full max-w-3xl p-4"><Skeleton className="h-40 w-full" /></div>;

  if (!token) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <h1 className="text-lg font-semibold text-fg">Referrals &amp; Earnings</h1>
          <p className="text-sm text-muted">Sign in to get your referral link and track your commissions.</p>
          <Link href="/"><Button>Go to sign in</Button></Link>
        </Card>
      </div>
    );
  }

  const e = info.data?.earnings;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold text-fg">Referrals &amp; Earnings</h1>
        <p className="text-sm text-muted">
          Earn instantly when people you refer deposit. Direct 25% (marketers) or 5% (players),
          plus 20% / 17% up your marketer network.
        </p>
      </div>

      {/* Referral link */}
      <Card className="flex flex-col gap-3 bg-gradient-to-br from-accent/10 to-transparent">
        <span className="text-xs uppercase tracking-wide text-muted">Your referral link</span>
        {info.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="flex-1 truncate rounded-brand border border-border bg-surface px-3 py-2 text-sm text-fg">
              {info.data?.link ?? info.data?.referralPath ?? '—'}
            </code>
            <div className="flex items-center gap-2">
              <span className="rounded-brand border border-border px-3 py-2 font-mono text-sm text-accent">
                {info.data?.code ?? '—'}
              </span>
              <Button onClick={copyLink} disabled={!info.data?.code}>Copy</Button>
            </div>
          </div>
        )}
      </Card>

      {/* Headline earnings */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total earned" value={<Money cents={e?.totalCents ?? 0} />} />
        <Stat label="Last 30 days" value={<Money cents={e?.last30dCents ?? 0} />} />
        <Stat label="People referred" value={info.data?.referredCount ?? 0} hint={`${info.data?.downlineMarketers ?? 0} are marketers`} />
        <Stat label="Commission events" value={e?.count ?? 0} />
      </div>

      {/* By level */}
      <Card className="flex flex-col gap-3">
        <span className="text-xs uppercase tracking-wide text-muted">Earnings by level</span>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="flex flex-col"><span className="text-xs text-muted">Direct · 25%</span><Money className="text-fg" cents={e?.byLevel.l1 ?? 0} /></div>
          <div className="flex flex-col"><span className="text-xs text-muted">Level 2 · 20%</span><Money className="text-fg" cents={e?.byLevel.l2 ?? 0} /></div>
          <div className="flex flex-col"><span className="text-xs text-muted">Level 3 · 17%</span><Money className="text-fg" cents={e?.byLevel.l3 ?? 0} /></div>
          <div className="flex flex-col"><span className="text-xs text-muted">Player refs · 5%</span><Money className="text-fg" cents={e?.playerReferralCents ?? 0} /></div>
        </div>
      </Card>

      {/* Referred players — deposit vs played transparency */}
      <Card className="flex flex-col gap-3">
        <span className="text-xs uppercase tracking-wide text-muted">Your referred players</span>
        {referred.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (referred.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No referrals yet" description="Share your link to start earning." />
        ) : (
          <div className="table-wrapper overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3">Player</th>
                  <th className="py-2 pr-3 text-right">Deposited</th>
                  <th className="py-2 pr-3 text-right">Played</th>
                  <th className="py-2 pr-3 text-right">Unplayed</th>
                  <th className="py-2 pr-3 text-right">Your commission</th>
                </tr>
              </thead>
              <tbody>
                {referred.data!.items.map((r) => (
                  <tr key={r.userId} className="border-t border-border">
                    <td className="py-2 pr-3 text-fg">{mask(r.username)}</td>
                    <td className="py-2 pr-3 text-right"><Money cents={r.depositsCents} /></td>
                    <td className="py-2 pr-3 text-right text-muted"><Money cents={r.playedCents} /></td>
                    <td className="py-2 pr-3 text-right text-muted"><Money cents={r.unplayedCents} /></td>
                    <td className="py-2 pr-3 text-right font-medium text-accent"><Money cents={r.commissionCents} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Commission feed */}
      <Card className="flex flex-col gap-3">
        <span className="text-xs uppercase tracking-wide text-muted">Recent commissions</span>
        {commissions.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : events.length === 0 ? (
          <EmptyState title="No commissions yet" description="You earn the instant a referred player deposits." />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {events.map((ev) => (
              <li key={ev.id} className="flex items-center justify-between gap-3 py-2">
                <div className="flex flex-col">
                  <span className="text-sm text-fg">
                    {mask(ev.referredUsername)} deposited {formatKes(ev.depositCents)}
                  </span>
                  <span className="text-xs text-muted">
                    {LEVEL_LABEL[ev.level] ?? `L${ev.level}`} · {Math.round(ev.rate * 100)}% · {formatDateTime(ev.createdAtMs)}
                  </span>
                </div>
                <Money className="font-medium text-accent" cents={ev.commissionCents} />
              </li>
            ))}
          </ul>
        )}
        {commissions.hasNextPage ? (
          <Button variant="secondary" onClick={() => void commissions.fetchNextPage()} disabled={commissions.isFetchingNextPage}>
            {commissions.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </Card>
    </div>
  );
}
