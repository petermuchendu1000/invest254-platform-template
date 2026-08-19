'use client';

import { useState } from 'react';
import { PageHeader, Section } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useOnboardClient, useDomainStatus } from '@/lib/platform/hooks';
import type { OnboardResult } from '@/lib/platform/endpoints';

/** Instant client onboarding: brand + economy + (optional) domain provisioning (Cloudflare zone +
 *  DNS + SSL, Namecheap nameservers) in one action. */
export default function OnboardPage() {
  const onboard = useOnboardClient();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('KES');
  const [primaryDomain, setDomain] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [colorPrimary, setColor] = useState('#3861FB');
  const [provision, setProvision] = useState(true);
  const [result, setResult] = useState<OnboardResult | null>(null);
  const provisionedDomain = result?.domain?.domain ?? null;
  const domainStatus = useDomainStatus(provisionedDomain);

  return (
    <>
      <PageHeader title="Onboard a client" subtitle="Create a brand, seed a feasible economy, and (optionally) provision its domain end-to-end." />

      <Section title="New brand">
        <form
          className="grid grid-cols-1 gap-3 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-2 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            const dom = primaryDomain.trim();
            const email = supportEmail.trim();
            onboard.mutate(
              {
                slug: slug.trim(), name: name.trim(), currency: currency.trim() || 'KES',
                ...(dom ? { primaryDomain: dom } : {}),
                ...(email ? { supportEmail: email } : {}),
                colors: { primary: colorPrimary },
                provisionDomain: provision && Boolean(dom),
              },
              { onSuccess: (r) => setResult(r) },
            );
          }}
        >
          <Input label="Brand name" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tamu Traders" required />
          <Input label="Slug" name="slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="tamutraders" required />
          <Input label="Primary domain" name="primaryDomain" value={primaryDomain} onChange={(e) => setDomain(e.target.value)} placeholder="tamutraders.com" optional />
          <Input label="Currency" name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
          <Input label="Support email" name="supportEmail" type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} placeholder="support@tamutraders.com" optional />
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg">Seed colour</span>
            <input type="color" value={colorPrimary} onChange={(e) => setColor(e.target.value)} className="h-12 w-full rounded-brand border border-border bg-surface-2" />
          </label>
          <label className="flex items-center gap-2 text-sm text-fg sm:col-span-2 md:col-span-3">
            <input type="checkbox" checked={provision} onChange={(e) => setProvision(e.target.checked)} />
            Provision the domain automatically (Cloudflare zone + DNS + SSL, Namecheap nameservers)
          </label>
          <div className="sm:col-span-2 md:col-span-3">
            <Button type="submit" disabled={onboard.isPending || !slug.trim() || !name.trim()}>
              {onboard.isPending ? 'Creating…' : 'Create client'}
            </Button>
            {onboard.isError ? <span className="ml-3 text-sm text-down">{(onboard.error as Error).message}</span> : null}
            {result ? <span className="ml-3 text-sm text-up">{result.brand.name} is live (site {result.brand.siteId.slice(0, 8)}).</span> : null}
          </div>
        </form>
      </Section>

      {result?.domain ? (
        <Section title="Domain provisioning">
          <div className="rounded-2xl border border-border bg-surface p-4 text-sm">
            <p className="font-medium text-fg">{result.domain.domain}</p>
            <p className="mt-1 text-xs text-muted">Nameservers: {result.domain.nameServers.join(', ') || '—'}</p>
            <p className="mt-1 text-xs text-muted">
              Zone: <span className="text-fg">{domainStatus.data?.zoneStatus ?? result.domain.zoneStatus}</span>
              {' · '}Pages: {(domainStatus.data?.pages ?? result.domain.pages).map((p) => `${p.name} (${p.status})`).join(', ')}
            </p>
            <p className="mt-2 text-xs text-muted">Zones activate once the nameserver change propagates (minutes–few hours), then SSL issues automatically.</p>
          </div>
        </Section>
      ) : null}
    </>
  );
}
