/**
 * Which domain provisioner (Cloudflare + optional Namecheap registrar) a platform uses — docs/42 UI-9.
 *
 *   * a platform with its OWN complete registrar config -> that registrar;
 *   * the DEFAULT platform (also the system owner acting globally, `null`) without one -> the env
 *     registrar (the system owner's Namecheap). Before UI-9 the default platform ALWAYS used the env
 *     registrar, so a registrar the owner saved for the default platform in the console was silently
 *     ignored;
 *   * any OTHER platform without one -> NO registrar (manual nameservers). It never borrows the owner's.
 * No Cloudflare (env provisioner null) -> no provisioning at all.
 */
export const DEFAULT_PLATFORM_ID = "10000000-0000-0000-0000-000000000001";

export interface ProvisionerDeps<P, R> {
  envProvisioner: P | null;
  /** The platform's stored registrar client, or null when not (completely) configured. */
  buildRegistrar(platformId: string): Promise<R | null>;
  /** Cloudflare provisioner with an explicit registrar (null = none). */
  make(registrar: R | null): P | null;
}

export async function resolveProvisioner<P, R>(platformId: string | null, d: ProvisionerDeps<P, R>): Promise<P | null> {
  if (!d.envProvisioner) return null;
  const pid = platformId ?? DEFAULT_PLATFORM_ID;
  if (pid === DEFAULT_PLATFORM_ID) {
    // The owner's own platform: a stored registrar wins; an unreadable/incomplete one falls back to env.
    const reg = await d.buildRegistrar(pid).catch(() => null);
    return reg ? d.make(reg) : d.envProvisioner;
  }
  const reg = await d.buildRegistrar(pid);
  return d.make(reg ?? null);
}
