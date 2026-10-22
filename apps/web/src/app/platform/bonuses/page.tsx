'use client';

import { useState } from 'react';
import { PageHeader, Section } from '@/components/admin/ui';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatMoney, kesCentsToDisplay } from '@invest254/shared/money';
import { useFailToast } from '@/lib/toast/useFailToast';
import { useToast } from '@/lib/toast/ToastProvider';
import { useBonuses, useSetPlatformBonuses, useSetBrandBonuses, useSetBrandBonusAmount } from '@/lib/platform/hooks';
import type { BonusBrandDto } from '@/lib/platform/endpoints';

/**
 * Bonuses — per PLATFORM and per BRAND (migrations 0173 on/off, 0177 amount).
 *
 * The switch is a three-level AND: system (the owner's master switch) AND platform AND brand. This
 * screen shows all three, because the failure mode of a plain toggle is an operator flipping a brand
 * "on" while the level above it is off and believing bonuses resumed. Every row therefore reports its
 * OWN switch and its EFFECTIVE state, and names the level that is holding it off.
 *
 * The welcome-bonus AMOUNT and WAGERING are set per brand, in the brand's OWN display currency (0177):
 * nothing is hard-wired. A blank amount inherits the global default; a number overrides it. The API
 * resolves the brand-currency figure to authoritative KES cents at the live rate.
 *
 * Turning bonuses OFF is confirmed, turning them ON is immediate — the same asymmetry the withdrawals
 * kill switch uses: the disruptive direction asks, the safe direction does not get in the way.
 */

const Pill = ({ on, children }: { on: boolean; children: React.ReactNode }) => (
  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${on ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>{children}</span>
);

/** Format a per-brand KES-cents amount in THAT brand's display currency (each brand may differ). */
function brandMoney(cents: number, currency: string, fxRateFromKes: number): string {
  return formatMoney(cents, { currency, fxRateFromKes: fxRateFromKes > 0 ? fxRateFromKes : 1 });
}

function BrandCard({
  b, systemEnabled, confirmOff, onConfirmOff, onCancelOff, onFlip, onDoOff, flipPending,
}: {
  b: BonusBrandDto; systemEnabled: boolean; confirmOff: boolean;
  onConfirmOff: (b: BonusBrandDto) => void; onCancelOff: () => void;
  onFlip: (b: BonusBrandDto, next: boolean) => void; onDoOff: (b: BonusBrandDto) => void; flipPending: boolean;
}) {
  const setAmount = useSetBrandBonusAmount();
  const failToast = useFailToast();
  const toast = useToast();
  // Empty string = inherit the global default. A number = a per-brand override in the brand currency.
  const [amount, setAmount$] = useState<string>(b.amountNative == null ? '' : String(b.amountNative));
  const [wager, setWager] = useState<string>(b.wageringXOverride == null ? '' : String(b.wageringXOverride));

  const heldOff = b.enabled && !b.effective;   // its own switch is on, a level above is not
  const usingDefault = b.amountNative == null;
  // The default in THIS brand's currency, so the placeholder shows what "blank" will grant.
  const defaultNative = kesCentsToDisplay(b.defaultAmountCents, b.fxRateFromKes > 0 ? b.fxRateFromKes : 1);
  const dirty = (amount.trim() === '' ? '' : String(Number(amount))) !== (b.amountNative == null ? '' : String(b.amountNative))
    || (wager.trim() === '' ? '' : String(Number(wager))) !== (b.wageringXOverride == null ? '' : String(b.wageringXOverride));

  const save = (clear = false) => {
    const amountNative = clear || amount.trim() === '' ? null : Number(amount);
    const wageringX = clear || wager.trim() === '' ? null : Number(wager);
    if (amountNative != null && (!Number.isFinite(amountNative) || amountNative < 0)) { toast.push({ tone: 'error', title: 'Enter a valid amount' }); return; }
    if (wageringX != null && (!Number.isFinite(wageringX) || wageringX < 0)) { toast.push({ tone: 'error', title: 'Enter a valid wagering multiple' }); return; }
    setAmount.mutate({ siteId: b.siteId, amountNative, wageringX }, {
      onSuccess: () => { if (clear) { setAmount$(''); setWager(''); } toast.push({ tone: 'success', title: `Welcome bonus saved for ${b.name}` }); },
      onError: (e) => failToast(e),
    });
  };

  return (
    <Card className={`flex flex-col gap-3 ${b.effective ? '' : 'border-down/40 bg-down/5'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{b.name}</span>
            <Pill on={b.effective}>{b.effective ? 'Granting' : 'Not granting'}</Pill>
            <span className="text-[10px] uppercase text-muted">{b.currency}</span>
            {b.status !== 'active' ? <span className="text-[10px] uppercase text-muted">{b.status}</span> : null}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {heldOff
              ? `On for this brand, but held off by the ${systemEnabled ? 'platform' : 'system'} switch above.`
              : b.effective
                ? <>New players receive {brandMoney(b.amountCents, b.currency, b.fxRateFromKes)}, wagered {b.wageringX}× before it converts{usingDefault ? ' (using the default)' : ''}.</>
                : 'Switched off for this brand.'}
          </p>
        </div>
        {confirmOff ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-xs text-muted">Stop bonuses for {b.name}?</span>
            <Button size="sm" variant="down" disabled={flipPending} onClick={() => onDoOff(b)}>Confirm off</Button>
            <Button size="sm" variant="ghost" onClick={onCancelOff}>Cancel</Button>
          </span>
        ) : (
          <Button size="sm" variant={b.enabled ? 'down' : 'up'} disabled={flipPending}
            onClick={() => (b.enabled ? onConfirmOff(b) : onFlip(b, true))}>
            {b.enabled ? 'Turn off' : 'Turn on'}
          </Button>
        )}
      </div>

      {/* ── Welcome-bonus amount + wagering, in the brand's own currency (0177) ── */}
      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <div className="w-36">
          <Input
            label="Amount"
            inputMode="decimal"
            leading={<span className="text-xs">{b.currency}</span>}
            value={amount}
            placeholder={String(Number(defaultNative.toFixed(2)))}
            onChange={(e) => setAmount$(e.target.value)}
            hint={usingDefault ? 'Blank = default' : 'Overriding default'}
          />
        </div>
        <div className="w-28">
          <Input
            label="Wagering"
            inputMode="decimal"
            trailing={<span className="text-xs">×</span>}
            value={wager}
            placeholder={String(b.defaultWageringX)}
            onChange={(e) => setWager(e.target.value)}
            hint={b.wageringXOverride == null ? 'Blank = default' : 'Overriding default'}
          />
        </div>
        <div className="flex items-center gap-2 pb-[2px]">
          <Button size="sm" variant="up" disabled={setAmount.isPending || !dirty} onClick={() => save(false)}>Save</Button>
          {!usingDefault || b.wageringXOverride != null ? (
            <Button size="sm" variant="ghost" disabled={setAmount.isPending} onClick={() => save(true)}>Reset to default</Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export default function BonusesPage() {
  const q = useBonuses();
  const setPlatform = useSetPlatformBonuses();
  const setBrand = useSetBrandBonuses();
  const failToast = useFailToast();
  const toast = useToast();
  const [confirmPlatformOff, setConfirmPlatformOff] = useState(false);
  const [confirmBrandOff, setConfirmBrandOff] = useState<string | null>(null);

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
    setBrand.mutate({ siteId: b.siteId, enabled: next }, {
      onSuccess: () => toast.push({ tone: next ? 'success' : 'error', title: `Bonuses ${next ? 'enabled' : 'DISABLED'} for ${b.name}` }),
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
      <Section title={`Platform: ${d.platformName ?? 'this platform'}`}>
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

      {/* ── Per-brand switches + amount ── */}
      <Section title="Brands">
        {brands.length === 0 ? (
          <Card><p className="text-sm text-muted">No brands on this platform yet.</p></Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {brands.map((b) => (
              <BrandCard
                key={b.siteId}
                b={b}
                systemEnabled={d.systemEnabled}
                confirmOff={confirmBrandOff === b.siteId}
                onConfirmOff={(x) => setConfirmBrandOff(x.siteId)}
                onCancelOff={() => setConfirmBrandOff(null)}
                onFlip={flipBrand}
                onDoOff={doBrandOff}
                flipPending={setBrand.isPending}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="What these settings do">
        <Card className="flex flex-col gap-2 text-xs text-muted">
          <p>
            <b className="text-fg">Amount, in each brand&apos;s currency.</b> Enter the welcome bonus in the brand&apos;s own
            currency. Leave it blank to inherit the platform default. It is stored as real money (KES) at the live exchange
            rate, so a USD brand can offer a clean &quot;$5&quot; while a KES brand offers &quot;KES 200&quot;.
          </p>
          <p>
            <b className="text-fg">Future sign-ups only.</b> Changing the amount or switching bonuses off affects new grants.
            Players who already hold a bonus keep it. Their wagering progress continues and it still converts when they clear
            it. Nothing is taken back.
          </p>
          <p>
            <b className="text-fg">Why it exists.</b> The welcome bonus is a deposit trigger: set just below the minimum stake,
            a new player owns a balance they cannot quite use yet and tops it up. The wagering multiple is how many times it
            must be staked before it converts to withdrawable cash.
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
