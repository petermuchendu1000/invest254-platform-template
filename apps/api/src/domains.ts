/**
 * Domain provisioning for brand onboarding (docs/21 Step 4). Turns "attach domain X to the
 * platform" into one server-side operation across two providers, behind small injectable ports
 * so the orchestration is unit-testable with fakes and the real adapters never run in tests:
 *
 *   CDN (Cloudflare)      create the zone, add the apex+www DNS records, attach the Pages custom
 *                         domains (SSL auto-issues once the zone is active).
 *   Registrar (Namecheap) point the domain's nameservers at Cloudflare.
 *
 * Credentials come from the environment (Fly secrets); nothing here is ever exposed to the browser.
 */

const UA = "invest254-onboarding/1.0";

/**
 * Detect this server's public egress IP (cached). Used as the Namecheap ClientIp when NAMECHEAP_CLIENT_IP
 * isn't pinned, so the ClientIp always matches the real source — the operator only manages the whitelist,
 * and if the egress drifts the error names the exact IP to add.
 */
let cachedEgressIp: string | null = null;
export async function detectEgressIp(): Promise<string | null> {
  if (cachedEgressIp) return cachedEgressIp;
  try {
    const r = await fetch("https://api.ipify.org", { headers: { "user-agent": UA } });
    const ip = (await r.text()).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) cachedEgressIp = ip;
  } catch { /* offline / blocked — caller falls back to the configured IP */ }
  return cachedEgressIp;
}

// ── Ports ────────────────────────────────────────────────────────────────────────────────
export interface ZoneInfo { zoneId: string; nameServers: string[]; status: string }
export interface DnsRecord { type: "CNAME" | "A"; name: string; content: string; proxied: boolean }
export interface PagesDomainInfo { name: string; status: string }

export interface CdnClient {
  /** Create a zone (or return the existing one) for `domain`; yields its Cloudflare nameservers. */
  ensureZone(domain: string): Promise<ZoneInfo>;
  addDnsRecord(zoneId: string, rec: DnsRecord): Promise<void>;
  addPagesDomain(project: string, name: string): Promise<PagesDomainInfo>;
  zoneStatus(domain: string): Promise<string | null>;
  pagesDomains(project: string): Promise<PagesDomainInfo[]>;
}

/** A domain as reported by the registrar (Namecheap) account. */
export interface RegistrarDomain { domain: string; expires: string | null; usingRegistrarDns: boolean }

export interface RegistrarClient {
  /** Set the domain's authoritative nameservers (moves DNS to the CDN). */
  setNameservers(domain: string, nameservers: string[]): Promise<boolean>;
  /** List every domain in the registrar account (paginated internally). */
  listDomains(): Promise<RegistrarDomain[]>;
}

// ── Domain <-> SLD/TLD ─────────────────────────────────────────────────────────────────────
const TWO_LEVEL_TLDS = new Set(["co.ke", "or.ke", "ne.ke", "go.ke", "ac.ke", "co.uk", "org.uk", "co.tz", "co.ug", "com.ng"]);
export function splitDomain(domain: string): { sld: string; tld: string } {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  const labels = d.split(".");
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LEVEL_TLDS.has(lastTwo)) {
    return { sld: labels[labels.length - 3]!, tld: lastTwo };
  }
  return { sld: labels[labels.length - 2]!, tld: labels[labels.length - 1]! };
}

// ── Orchestration ──────────────────────────────────────────────────────────────────────────
export interface ProvisionResult {
  domain: string;
  zoneId: string;
  nameServers: string[];
  zoneStatus: string;
  nameserversUpdated: boolean;
  pages: PagesDomainInfo[];
  note: string;
}

/**
 * Attach `domain` to the platform: create the Cloudflare zone, point Namecheap nameservers at it,
 * add the apex + www DNS records to the Pages project, and register the Pages custom domains.
 * Idempotent: safe to re-run (existing zone/records/domains are tolerated).
 */
export async function provisionDomain(
  cdn: CdnClient,
  registrar: RegistrarClient | null,
  opts: { domain: string; pagesProject: string; pagesTarget?: string },
): Promise<ProvisionResult> {
  const domain = opts.domain.trim().toLowerCase().replace(/^www\./, "");
  const target = opts.pagesTarget ?? `${opts.pagesProject}.pages.dev`;

  const zone = await cdn.ensureZone(domain);
  // Registrar (nameserver) step is OPTIONAL. With a registrar we auto-point the domain's nameservers at
  // Cloudflare; without one (or on failure) we degrade gracefully — Cloudflare zone + DNS + Pages are
  // still set up, and the result returns exactly which nameservers the operator must set at the registrar.
  let nsUpdated = false;
  if (registrar) { try { nsUpdated = await registrar.setNameservers(domain, zone.nameServers); } catch { nsUpdated = false; } }

  // apex + www -> the Pages project (proxied so Cloudflare terminates TLS and routes to Pages).
  for (const name of [domain, `www.${domain}`]) {
    try { await cdn.addDnsRecord(zone.zoneId, { type: "CNAME", name, content: target, proxied: true }); }
    catch { /* record may already exist; ignore */ }
  }
  const pages: PagesDomainInfo[] = [];
  for (const name of [domain, `www.${domain}`]) {
    try { pages.push(await cdn.addPagesDomain(opts.pagesProject, name)); }
    catch { pages.push({ name, status: "exists_or_pending" }); }
  }

  const nsList = zone.nameServers.join(" and ");
  const note = zone.status === "active"
    ? "Zone active; Pages custom domains validate and SSL issues shortly."
    : nsUpdated
      ? "Nameservers pointed at Cloudflare automatically; the zone activates once they propagate (minutes–few hours), then SSL auto-issues."
      : `Action needed: at the domain's registrar, set its nameservers to ${nsList || "the Cloudflare nameservers shown"}. The zone activates once they propagate, then SSL auto-issues.`;

  return {
    domain,
    zoneId: zone.zoneId,
    nameServers: zone.nameServers,
    zoneStatus: zone.status,
    nameserversUpdated: nsUpdated,
    pages,
    note,
  };
}

export interface DomainStatus {
  domain: string;
  zoneStatus: string | null;
  pages: PagesDomainInfo[];
  active: boolean;
}
export async function getDomainStatus(cdn: CdnClient, opts: { domain: string; pagesProject: string }): Promise<DomainStatus> {
  const domain = opts.domain.trim().toLowerCase().replace(/^www\./, "");
  const zoneStatus = await cdn.zoneStatus(domain);
  const pages = (await cdn.pagesDomains(opts.pagesProject)).filter((p) => p.name === domain || p.name === `www.${domain}`);
  const active = zoneStatus === "active" && pages.length > 0 && pages.every((p) => p.status === "active");
  return { domain, zoneStatus, pages, active };
}

// ── Real adapters (env-configured; never exercised in tests) ─────────────────────────────────
async function cf<T>(token: string, path: string, init?: RequestInit): Promise<{ success: boolean; result: T; errors: unknown }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": UA, ...(init?.headers ?? {}) },
  });
  return (await res.json()) as { success: boolean; result: T; errors: unknown };
}

export function makeCloudflareCdn(cfg: { token: string; accountId: string }): CdnClient {
  const { token, accountId } = cfg;
  return {
    async ensureZone(domain) {
      const created = await cf<{ id: string; name_servers: string[]; status: string }>(token, "/zones", {
        method: "POST", body: JSON.stringify({ name: domain, account: { id: accountId }, type: "full" }),
      });
      if (created.success) return { zoneId: created.result.id, nameServers: created.result.name_servers, status: created.result.status };
      // Already exists (or similar) -> look it up.
      const found = await cf<Array<{ id: string; name_servers: string[]; status: string }>>(token, `/zones?name=${encodeURIComponent(domain)}`);
      const z = found.result?.[0];
      if (!z) throw new Error(`CF ensureZone failed: ${JSON.stringify(created.errors).slice(0, 200)}`);
      return { zoneId: z.id, nameServers: z.name_servers, status: z.status };
    },
    async addDnsRecord(zoneId, rec) {
      const r = await cf(token, `/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(rec) });
      if (!r.success) throw new Error(`CF addDnsRecord failed: ${JSON.stringify(r.errors).slice(0, 160)}`);
    },
    async addPagesDomain(project, name) {
      const r = await cf<{ name: string; status: string }>(token, `/accounts/${accountId}/pages/projects/${project}/domains`, {
        method: "POST", body: JSON.stringify({ name }),
      });
      if (!r.success) throw new Error(`CF addPagesDomain failed: ${JSON.stringify(r.errors).slice(0, 160)}`);
      return { name: r.result.name, status: r.result.status };
    },
    async zoneStatus(domain) {
      const found = await cf<Array<{ status: string }>>(token, `/zones?name=${encodeURIComponent(domain)}`);
      return found.result?.[0]?.status ?? null;
    },
    async pagesDomains(project) {
      const r = await cf<Array<{ name: string; status: string }>>(token, `/accounts/${accountId}/pages/projects/${project}/domains`);
      return (r.result ?? []).map((d) => ({ name: d.name, status: d.status }));
    },
  };
}

export function makeNamecheapRegistrar(cfg: { apiUser: string; userName: string; apiKey: string; clientIp: string }): RegistrarClient {
  // ClientIp: prefer the pinned value, else auto-detect the egress IP so it always matches the source.
  const resolveClientIp = async () => cfg.clientIp || (await detectEgressIp()) || cfg.clientIp || "";
  const call = async (params: Record<string, string>): Promise<string> => {
    const clientIp = await resolveClientIp();
    const url = new URL("https://api.namecheap.com/xml.response");
    url.search = new URLSearchParams({ ApiUser: cfg.apiUser, ApiKey: cfg.apiKey, UserName: cfg.userName, ClientIp: clientIp, ...params }).toString();
    const res = await fetch(url, { headers: { "user-agent": UA } });
    const xml = await res.text();
    if (/ApiResponse\s+Status="ERROR"/.test(xml)) {
      const ipErr = xml.match(/Invalid request IP:\s*([0-9.]+)/i);
      if (ipErr) throw new Error(`NAMECHEAP_IP_NOT_WHITELISTED: ${ipErr[1]} — add this IP in Namecheap → Profile → Tools → API Access → Whitelisted IPs, then update NAMECHEAP_CLIENT_IP.`);
      throw new Error(`Namecheap error: ${(xml.match(/<Error[^>]*>([^<]+)</)?.[1] ?? "unknown").slice(0, 160)}`);
    }
    return xml;
  };
  return {
    async setNameservers(domain, nameservers) {
      const { sld, tld } = splitDomain(domain);
      const xml = await call({ Command: "namecheap.domains.dns.setCustom", SLD: sld, TLD: tld, Nameservers: nameservers.join(",") });
      return /Updated="true"/i.test(xml);
    },
    async listDomains() {
      const out: RegistrarDomain[] = [];
      for (let page = 1; page <= 50; page++) { // safety cap: 5000 domains
        const xml = await call({ Command: "namecheap.domains.getList", PageSize: "100", Page: String(page), SortBy: "NAME" });
        const tags = xml.match(/<Domain\b[^>]*>/g) ?? [];
        for (const tag of tags) {
          const name = tag.match(/\bName="([^"]+)"/)?.[1];
          if (!name) continue;
          out.push({
            domain: name.trim().toLowerCase(),
            expires: tag.match(/\bExpires="([^"]+)"/)?.[1] ?? null,
            usingRegistrarDns: /\bIsOurDNS="true"/i.test(tag),
          });
        }
        const total = Number(xml.match(/TotalItems>(\d+)</)?.[1] ?? out.length);
        if (tags.length === 0 || out.length >= total) break;
      }
      return out;
    },
  };
}

/**
 * Build a DomainProvisioner from env, or return null when not configured (so the onboarding UI
 * gracefully offers "manual DNS" instead). Requires the Cloudflare + Namecheap secrets.
 */
export interface DomainProvisioner {
  provision(domain: string): Promise<ProvisionResult>;
  status(domain: string): Promise<DomainStatus>;
  readonly pagesProject: string;
  /** True when a registrar API (Namecheap) is configured to auto-set nameservers; false => manual NS. */
  readonly registrarConfigured: boolean;
  /** List all domains in the registrar account (empty when no registrar is configured). */
  listRegistrarDomains(): Promise<RegistrarDomain[]>;
  /** The Pages custom-domain list (real domain health: active vs pending), one CF call. */
  pagesDomains(): Promise<PagesDomainInfo[]>;
}
export function makeDomainProvisioner(): DomainProvisioner | null {
  const token = process.env.CF_DNS_API_TOKEN ?? process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  const pagesProject = process.env.CF_PAGES_PROJECT ?? "invest254";
  // Cloudflare is the ESSENTIAL requirement (zone + DNS + Pages custom domain). Without it there's no
  // provisioning at all; with it, provisioning works standalone and returns the nameservers to set.
  if (!token || !accountId) return null;
  const cdn = makeCloudflareCdn({ token, accountId });
  // Namecheap is OPTIONAL — used to auto-point nameservers AND to import the account's domain list.
  const apiUser = process.env.NAMECHEAP_API_USER;
  const userName = process.env.NAMECHEAP_USERNAME ?? apiUser;
  const apiKey = process.env.NAMECHEAP_API_KEY;
  const clientIp = process.env.NAMECHEAP_CLIENT_IP;
  const registrar = (apiUser && userName && apiKey && clientIp)
    ? makeNamecheapRegistrar({ apiUser, userName, apiKey, clientIp }) : null;
  return {
    pagesProject,
    registrarConfigured: registrar != null,
    provision: (domain) => provisionDomain(cdn, registrar, { domain, pagesProject }),
    status: (domain) => getDomainStatus(cdn, { domain, pagesProject }),
    listRegistrarDomains: () => (registrar ? registrar.listDomains() : Promise.resolve([])),
    pagesDomains: () => cdn.pagesDomains(pagesProject),
  };
}
