'use client';
import { useCan } from '@/lib/auth/can';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader, Section } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useOnboardClient, useDomainStatus, useOnboardCapabilities, usePlatforms } from '@/lib/platform/hooks';
import { DomainImport } from '@/components/platform/DomainImport';
import type { OnboardResult } from '@/lib/platform/endpoints';

/**
 * Instant client onboarding: create the brand + economy, and (optionally) provision its domain on
 * Cloudflare (zone + DNS + Pages custom domain + SSL). Nameservers are auto-pointed when a registrar
 * API is configured; otherwise the exact nameservers to set are shown after creation.
 */
export default function OnboardPage() {
  const caps = useOnboardCapabilities();
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

  // System owner may onboard directly into a chosen platform; a platform admin auto-scopes to its own.
  const isSystem = useCan('console.system');
  const platformsQ = usePlatforms(isSystem);   // docs/42 UI-6: owner-only endpoint — never called for a platform admin
  const platforms = useMemo(() => (platformsQ.data?.platforms ?? []) as Array<{ platformId: string; slug: string; name: string }>, [platformsQ.data]);
  const [platformId, setPlatformId] = useState('');

  const domainConfigured = caps.data?.domainConfigured ?? true;
  const registrarConfigured = caps.data?.registrarConfigured ?? false;
  const canProvision = domainConfigured && provision && Boolean(primaryDomain.trim());

  return (
    <>
      <PageHeader title="Onboard a client" subtitle="Create a brand, seed a feasible economy, and (optionally) provision its domain on Cloudflare." />

      {/* Honest, up-front statement of what will happen with the domain */}
      {caps.data ? (
        <div className={[
          'rounded-xl border px-4 py-3 text-sm',
          domainConfigured ? 'border-accent/30 bg-accent/5 text-fg' : 'border-amber-500/30 bg-amber-500/5 text-fg',
        ].join(' ')}>
          {!domainConfigured ? (
            <>Automatic domain provisioning is <b>off</b> (Cloudflare isn’t configured on this deployment). The brand is still created — point the domain’s DNS to the Pages project manually.</>
          ) : registrarConfigured ? (
            <>Domain provisioning is <b>fully automatic</b>: Cloudflare zone + DNS + Pages + SSL, and the registrar’s nameservers are pointed at Cloudflare for you.</>
          ) : (
            <>Cloudflare provisioning is <b>on</b> (zone + DNS + Pages + SSL). Your registrar API isn’t configured, so after creating you’ll set the domain’s <b>nameservers</b> at its registrar — the exact values are shown below once it’s created.</>
          )}
        </div>
      ) : null}

      {caps.data && !registrarConfigured ? (
        <p className="text-xs text-muted">To auto-point domains, <Link href="/platform/registrar" className="font-medium text-accent hover:underline">configure your Namecheap registrar</Link>. Until then, set nameservers manually after creating (or ask the system owner to register &amp; assign the domain).</p>
      ) : null}

      {registrarConfigured ? <DomainImport /> : null}

      <Section title="Add one brand manually">
        <form
          className="grid grid-cols-1 gap-3 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-2 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            const dom = primaryDomain.trim();
            const email = supportEmail.trim();
            setResult(null);
            onboard.mutate(
              {
                slug: slug.trim(), name: name.trim(), currency: currency.trim() || 'KES',
                ...(dom ? { primaryDomain: dom } : {}),
                ...(email ? { supportEmail: email } : {}),
                colors: { primary: colorPrimary },
                provisionDomain: domainConfigured && provision && Boolean(dom),
                ...(isSystem && platformId ? { platformId } : {}),
              },
              { onSuccess: (r) => setResult(r) },
            );
          }}
        >
          <Input label="Brand name" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shika FX" required />
          <Input label="Slug" name="slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="shikafx" required />
          <Input label="Primary domain" name="primaryDomain" value={primaryDomain} onChange={(e) => setDomain(e.target.value)} placeholder="shikafx.com" optional />
          <Input label="Currency" name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
          {isSystem ? (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-fg">Platform</span>
              <select value={platformId} onChange={(e) => setPlatformId(e.target.value)} className="h-11 w-full rounded-brand border border-border bg-surface-2 px-3 text-fg">
                <option value="">Default platform</option>
                {platforms.map((p) => <option key={p.platformId} value={p.platformId}>{p.name} ({p.slug})</option>)}
              </select>
            </label>
          ) : null}
          <Input label="Support email" name="supportEmail" type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} placeholder="support@shikafx.com" optional />
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg">Seed colour</span>
            <input type="color" value={colorPrimary} onChange={(e) => setColor(e.target.value)} className="h-12 w-full rounded-brand border border-border bg-surface-2" />
          </label>
          <label className={['flex items-center gap-2 text-sm sm:col-span-2 md:col-span-3', domainConfigured ? 'text-fg' : 'text-muted'].join(' ')}>
            <input type="checkbox" checked={provision} disabled={!domainConfigured} onChange={(e) => setProvision(e.target.checked)} />
            {registrarConfigured
              ? 'Provision the domain automatically (Cloudflare zone + DNS + SSL + registrar nameservers)'
              : 'Provision on Cloudflare (zone + DNS + SSL). You’ll set the nameservers at your registrar — shown after creating.'}
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

      {/* Domain outcome — always shown once created with a domain, with the exact next step. */}
      {result && result.brand.primaryDomain ? (
        <Section title="Domain">
          {result.domain ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">{result.domain.domain}</span>
                <span className={['rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  (domainStatus.data?.active) ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : 'border-amber-500/30 bg-amber-500/10 text-amber-500'].join(' ')}>
                  {domainStatus.data?.active ? 'Active' : `Zone: ${domainStatus.data?.zoneStatus ?? result.domain.zoneStatus}`}
                </span>
              </div>

              {!result.domain.nameserversUpdated ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="text-sm font-semibold text-amber-500">Action needed — set nameservers at the registrar</div>
                  <p className="mt-1 text-xs text-muted">At {result.domain.domain}’s registrar, replace its nameservers with:</p>
                  <ul className="mt-1 font-mono text-xs text-fg">
                    {result.domain.nameServers.length ? result.domain.nameServers.map((ns) => <li key={ns}>{ns}</li>) : <li>— (check Cloudflare)</li>}
                  </ul>
                  <p className="mt-1 text-xs text-muted">The zone activates once they propagate (minutes–few hours), then SSL issues automatically.</p>
                </div>
              ) : (
                <p className="text-xs text-muted">Nameservers pointed at Cloudflare automatically: {result.domain.nameServers.join(', ')}</p>
              )}

              <p className="text-xs text-muted">
                Pages: {(domainStatus.data?.pages ?? result.domain.pages).map((p) => `${p.name} (${p.status})`).join(', ') || '—'}
              </p>
              <p className="text-xs text-muted">{result.domain.note}</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
              <p className="text-fg">Brand created, but the domain was <b>not</b> provisioned{domainConfigured ? '' : ' (Cloudflare not configured)'}.</p>
              <p className="mt-1 text-xs text-muted">
                Point <span className="font-mono text-fg">{result.brand.primaryDomain}</span> (apex + www) at the Cloudflare Pages project as a proxied CNAME, or enable provisioning and recreate.
              </p>
            </div>
          )}
        </Section>
      ) : null}
      {result ? (
        <Section title="Next steps">
          <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 text-sm text-fg">
            <p>Brand created. It ships with the <b>Line chart</b>, <b>Classic</b> interface and <b>M-Pesa</b> deposits.</p>
            <ul className="list-disc pl-5 text-muted">
              <li>Create the brand&rsquo;s admin: have them register on the domain, then promote them under the client&rsquo;s Users.</li>
              <li>Other charts, interfaces and gateways are paid add-ons &mdash; request them from the client&rsquo;s <b>Systems &amp; gateways</b>.</li>
              <li>To auto-point domains, <Link href="/platform/registrar" className="text-accent hover:underline">configure your Namecheap</Link> (else set the nameservers manually above).</li>
            </ul>
          </div>
        </Section>
      ) : null}
    </>
  );
}
