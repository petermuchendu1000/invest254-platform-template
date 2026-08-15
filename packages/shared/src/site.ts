import { createHmac, createHash } from "node:crypto";

/**
 * Multi-tenant site (brand) primitives — pure, dependency-light, browser-safe types plus
 * per-site provably-fair seed derivation.
 *
 * Each brand has its OWN daily seed lineage so its curve and outcomes are independent of
 * every other brand's, and each brand can publish/verify fairness on its own. The seed is
 * derived by mixing the site id into the label of the same HMAC construction the
 * single-tenant engine already uses (see seed.ts), so:
 *   * no secret is stored at rest (recomputable from master seed + public site id + date),
 *   * crash recovery stays deterministic per site,
 *   * two brands sharing a master seed still get uncorrelated curves.
 *
 * A brand MAY carry its own master seed (sites.master_seed_ref); when it does, pass that as
 * `masterSeed`. When brands share one platform master seed, the site id in the label is what
 * decorrelates them.
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The brand/tenant a request, socket, position or row belongs to. */
export interface SiteRef {
  id: string;      // uuid (sites.id)
  slug: string;    // stable machine id (sites.slug)
}

/** Brand presentation values the web app renders (served as data, never hard-coded). */
export interface SiteBrand {
  name: string;
  wordmarkText?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  colorPrimary: string;
  colorBg: string;
  colorAccent: string;
  theme: "dark" | "light" | "auto";
  currency: string;
  locale: string;
  licenceLine?: string | null;
  supportEmail?: string | null;
}

/**
 * Deterministic per-(site, day) server seed (hex).
 *
 *   daySeed = HMAC-SHA256(masterSeed, "site:" + siteId + ":day:" + dateKey [+ "#" + version])
 *
 * `version` supports superadmin-forced rotation for a single brand+day without disturbing any
 * other brand (mirrors seed.ts deriveDaySeed's versioning). Version 0 uses the base label.
 */
export function deriveSiteDaySeed(masterSeed: string, siteId: string, dateKey: string, version = 0): string {
  if (!masterSeed) throw new Error("masterSeed is required");
  if (!siteId) throw new Error("siteId is required");
  if (!DATE_KEY_RE.test(dateKey)) throw new RangeError(`invalid date key: ${dateKey}`);
  if (!Number.isInteger(version) || version < 0) throw new RangeError(`invalid seed version: ${version}`);
  const base = `site:${siteId}:day:${dateKey}`;
  const label = version === 0 ? base : `${base}#${version}`;
  return createHmac("sha256", masterSeed).update(label).digest("hex");
}

/** Public commitment to a per-site day seed: SHA-256(seed) as lowercase hex. */
export function siteCommitment(seed: string): string {
  if (!seed) throw new Error("seed is required");
  return createHash("sha256").update(seed).digest("hex");
}

/**
 * Normalize a host / brand reference for site resolution — the single source of truth used by the
 * API brand resolver (`brandByHost`), the engine's connection resolver (`siteresolver.ts`) and the
 * test fakes, so every layer treats a domain identically.
 *
 * Rules (idempotent): lower-case, trim, tolerate a full origin/URL being passed (strip
 * `scheme://`, any userinfo, path and `:port`), drop a trailing FQDN dot, and treat `www.<apex>`
 * as `<apex>`. WHY the `www.` fold (GAP 4): brands are onboarded with their apex as
 * `sites.primary_domain`, but visitors (and CORS `Origin`s) arrive on both the apex and `www.`; an
 * exact match left `www.tamutraders.com` unresolved, silently falling back to the default brand.
 *
 * Slugs and UUIDs pass through unchanged (they contain no dots, ports or `www.` prefix), so this is
 * safe to apply to any `?site=` / host reference, not only domains.
 */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return "";
  let h = host.trim().toLowerCase();
  if (!h) return "";
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme:// if a full origin was passed
  h = h.split("/")[0] ?? "";                     // drop any path
  h = h.split("@").pop() ?? "";                  // drop userinfo
  h = h.split(":")[0] ?? "";                     // drop :port
  h = h.replace(/\.$/, "");                       // drop trailing FQDN dot
  h = h.replace(/^www\./, "");                    // fold www.<apex> -> <apex>
  return h;
}
