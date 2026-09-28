'use client';

import { useState } from 'react';
import { PageHeader, Section } from '@/components/admin/ui';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useFailToast } from '@/lib/toast/useFailToast';
import { useToast } from '@/lib/toast/ToastProvider';
import { useBonuses, useSetPlatformBonuses, useSetBrandBonuses } from '@/lib/platform/hooks';
import type { BonusBrandDto } from '@/lib/platform/endpoints';

/**
 * Bonuses on/off — per PLATFORM and per BRAND (migration 0173).
 *
 * The switch is a three-level AND: system (the owner's master switch) AND platform AND brand. This
 * screen shows all three, because the failure mode of a plain toggle is an operator flipping a brand
 * "on" while the level above it is off and believing bonuses resumed. Every row therefore reports its
 * OWN switch and its EFFECTIVE state, and names the level that is holding it off.
 *
 * Turning bonuses OFF is confirmed, turning them ON is immediate — the same asymmetry the withdrawals
 * kill switch uses: the disruptive direction asks, the safe direction does not get in the way.
 */

const Pill = ({ on, children }: { on: boolean; children: React.ReactNode }) => (
  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${on ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>{children}</span>
);

export default function BonusesPage() {
  const q = useBonuses();
  const setPlatform = useSetPlatformBonuses();
  const setBrand = useSetBrandBonuses();
  const failToast = useFailToast();
  const toast = useToast();
  const [confirmPlatformOff, setConfirmPlatformOff] = useState(false);
  const [confirmBrandOff, setConfirmBrandOff] = useState<BonusBrandDto | null>(null);

  if (q.isLoading) return <div className="flex flex-col gap-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (q.isError || !q.data) return <p className="text-sm text-down">Couldn&apos;t load the bonus settings.</p>;

  const d = q.data;
  const brands = d.brands;
  const liveCount = brands.filter((b) => b.effective).length;

  const flipPlatform = (next: boolean) => {
    if (!next) { setConfirmPlatformOff(true); return; }
    setPlatform.mutate(true, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Bonuses enabled for this platform' }),
      onError: (e) => failToast(e),
    });
  };
  const doPlatformOff = () => setPlatform.mutate(false, {
    onSuccess: () => { setConfirmPlatformOff(false); toast.push({ tone: 'error', title: 'Bonuses DISABLED for every brand on this platform' }); },
    onError: (e) => { setConfirmPlatformOff(false); failToast(e); },
  });

  const flipBrand = (b: BonusBrandDto, next: boolean) => {
    if (!next) { setConfirmBrandOff(b); return; }
    setBrand.mutate({ siteId: b.siteId, enabled: true }, {
      onSuccess: () => toast.push({ tone: 'success', title: `Bonuses enabled for ${b.name}` }),
      onError: (e) => failToast(e),
    });
  };
  const doBrandOff = (b: BonusBrandDto) => setBrand.mutate({ siteId: b.siteId, enabled: false }, {
    onSuccess: () => { setConfirmBrandOff(null); toast.push({ tone: 'error', title: `Bonuses DISABLED for ${b.name}` }); },
    onError: (e) => { setConfirmBrandOff(null); failToast(e); },
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Bonuses"
        subtitle={`${liveCount} of ${brands.length} brand${brands.length === 1 ? '' : 's'} currently granting the welcome bonus`}
      />

      {!d.systemEnabled && (
        <Card className="border-down/40 bg-down/5">
          <p className="text-sm font-medium text-down">Bonuses are switched off system-wide.</p>
          <p className="mt-1 text-xs text-muted">
            The system owner has stopped bonuses across every platform. Nothing you switch on here takes effect until that is lifted.
          </p>
        </Card>
      )}

      {/* ── Platform-level switch ── */}
      <Section title={`Platform — ${d.platformName ?? 'this platform'}`}>
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-fg">Sign-up bonus for every brand on this platform</span>
              <Pill on={d.platformEnabled}>{d.platformEnabled ? 'On' : 'Off'}</Pill>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Off here stops the bonus on every brand below, whatever each brand&apos;s own switch says.
            </p>
          </div>
          {confirmPlatformOff ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-xs text-muted">Stop bonuses on all {brands.length} brand{brands.length === 1 ? '' : 's'}?</span>
              <Button size="sm" variant="down" disabled={setPlatform.isPending} onClick={doPlatformOff}>Confirm off</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmPlatformOff(false)}>Cancel</Button>
            </span>
          ) : (
            <Button size="sm" variant={d.platformEnabled ? 'down' : 'up'} disabled={setPlatform.isPending}
              onClick={() => flipPlatform(!d.platformEnabled)}>
              {d.platformEnabled ? 'Turn off' : 'Turn on'}
            </Button>
          )}
        </Card>
      </Section>

      {/* ── Per-brand switches ── */}
      <Section title="Brands">
        {brands.length === 0 ? (
          <Card><p className="text-sm text-muted">No brands on this platform yet.</p></Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {brands.map((b) => {
              const heldOff = b.enabled && !b.effective;   // its own switch is on, a level above is not
              return (
                <Card key={b.siteId} className={`flex flex-wrap items-center justify-between gap-3 ${b.effective ? '' : 'border-down/40 bg-down/5'}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-fg">{b.name}</span>
                      <Pill on={b.effective}>{b.effective ? 'Granting' : 'Not granting'}</Pill>
                      {b.status !== 'active' ? <span className="text-[10px] uppercase text-muted">{b.status}</span> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {heldOff
                        ? `On for this brand, but held off by the ${d.systemEnabled ? 'platform' : 'system'} switch above.`
                        : b.effective
                          ? 'New players receive the welcome bonus.'
                          : 'Switched off for this brand.'}
                    </p>
                  </div>
                  {confirmBrandOff?.siteId === b.siteId ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="text-xs text-muted">Stop bonuses for {b.name}?</span>
                      <Button size="sm" variant="down" disabled={setBrand.isPending} onClick={() => doBrandOff(b)}>Confirm off</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmBrandOff(null)}>Cancel</Button>
                    </span>
                  ) : (
                    <Button size="sm" variant={b.enabled ? 'down' : 'up'} disabled={setBrand.isPending}
                      onClick={() => flipBrand(b, !b.enabled)}>
                      {b.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="What this switch does">
        <Card className="flex flex-col gap-2 text-xs text-muted">
          <p>
            <b className="text-fg">Future sign-ups only.</b> Switching bonuses off stops new grants. Players who already hold a
            bonus keep it — their wagering progress continues and it still converts when they clear it. Turning the tap off never
            takes money back.
          </p>
          <p>
            <b className="text-fg">Why it exists.</b> The welcome bonus is a deposit trigger: it is set just below the minimum
            stake on purpose, so a new player owns a balance they cannot quite use yet and tops it up. Switching it off removes
            that nudge, so expect fewer first-time deposits on the brands you turn off.
          </p>
          <p>
            <b className="text-fg">Three levels, all must be on.</b> System, platform, then brand. A brand cannot switch itself
            back on over a platform that is off.
          </p>
        </Card>
      </Section>
    </div>
  );
}
