/**
 * onboardscope.ts — platform-scope rules for brand onboarding and domain visibility (Issue 1 / F-47).
 *
 * Slugs and domains are GLOBAL (one system Cloudflare account, one `sites` table), while a platform
 * admin's authority is ONE platform. These helpers are the single place those two meet:
 *   - refuseForeignReonboard: re-onboarding an EXISTING slug that lives in another platform is refused
 *     (it used to overwrite that tenant's brand identity, domain and economy);
 *   - refuseDomainClash: a domain belongs to exactly one brand, compared case-insensitively (host
 *     resolution is case-insensitive; the column's UNIQUE constraint is not);
 *   - assertDomainInPlatform / platformDomainSet: a platform admin only sees/probes its own platform's
 *     brand domains (apex + www).
 * `callerScope` is the platform a BOUNDED caller is confined to; null means the system owner (unrestricted).
 */
export type Querier = { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

const apexOf = (d: string): string => d.trim().toLowerCase().replace(/^www\./, "");

/** Returns the existing site id for `slug` (or null); throws SLUG_TAKEN when it belongs to another platform. */
export async function refuseForeignReonboard(q: Querier, slug: string, callerScope: string | null | undefined): Promise<string | null> {
  const r = await q.query("select id, platform_id from sites where slug = $1", [slug]);
  if (!r.rows.length) return null;
  const row = r.rows[0]!;
  if (callerScope && String(row.platform_id) !== callerScope) throw new Error("SLUG_TAKEN: this slug is already in use");
  return String(row.id);
}

/** Throws DOMAIN_TAKEN when another brand (any case) already claims `domain`. */
export async function refuseDomainClash(q: Querier, domain: string, exceptSiteId: string | null): Promise<void> {
  const r = await q.query(
    "select 1 from sites where lower(primary_domain) = $1 and ($2::uuid is null or id <> $2::uuid)",
    [apexOf(domain), exceptSiteId]);
  if (r.rows.length) throw new Error("DOMAIN_TAKEN: this domain is already used by another brand");
}

/** Throws DOMAIN_NOT_FOUND unless `domain` (apex or www) is a brand of the caller's platform. */
export async function assertDomainInPlatform(q: Querier, domain: string, callerScope: string | null | undefined): Promise<void> {
  if (!callerScope) return;
  const r = await q.query("select 1 from sites where platform_id = $1 and lower(primary_domain) = $2", [callerScope, apexOf(domain)]);
  if (!r.rows.length) throw new Error("DOMAIN_NOT_FOUND: domain not found");
}

/** The host names (apex + www) of the caller's platform's brands; null = unrestricted (system owner). */
export async function platformDomainSet(q: Querier, callerScope: string | null | undefined): Promise<Set<string> | null> {
  if (!callerScope) return null;
  const r = await q.query("select lower(primary_domain) as d from sites where platform_id = $1 and primary_domain is not null", [callerScope]);
  return new Set(r.rows.flatMap((x) => [String(x.d), `www.${String(x.d)}`]));
}
