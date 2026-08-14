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

export interface RegistrarClient {
  /** Set the domain's authoritative nameservers (moves DNS to the CDN). */
  setNameservers(domain: string, nameservers: string[]): Promise<boolean>;
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
  registrar: RegistrarClient,
  opts: { domain: string; pagesProject: string; pagesTarget?: string },
): Promise<ProvisionResult> {
  const domain = opts.domain.trim().toLowerCase().replace(/^www\./, "");
  const target = opts.pagesTarget ?? `${opts.pagesProject}.pages.dev`;

  const zone = await cdn.ensureZone(domain);
  const nsUpdated = await registrar.setNameservers(domain, zone.nameServers);

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

  return {
    domain,
    zoneId: zone.zoneId,
    nameServers: zone.nameServers,
    zoneStatus: zone.status,
    nameserversUpdated: nsUpdated,
    pages,
    note: zone.status === "active"
      ? "Zone active; Pages will validate and SSL will issue shortly."
      : "Nameservers set; the zone activates once they propagate, then SSL auto-issues.",
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
  return {
    async setNameservers(domain, nameservers) {
      const { sld, tld } = splitDomain(domain);
      const url = new URL("https://api.namecheap.com/xml.response");
      url.search = new URLSearchParams({
        ApiUser: cfg.apiUser, ApiKey: cfg.apiKey, UserName: cfg.userName, ClientIp: cfg.clientIp,
        Command: "namecheap.domains.dns.setCustom", SLD: sld, TLD: tld, Nameservers: nameservers.join(","),
      }).toString();
      const res = await fetch(url, { headers: { "user-agent": UA } });
      const xml = await res.text();
      if (/ApiResponse\s+Status="ERROR"/.test(xml)) throw new Error(`Namecheap error: ${(xml.match(/<Error[^>]*>([^<]+)</)?.[1] ?? "unknown").slice(0, 160)}`);
      return /Updated="true"/i.test(xml);
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
}
export function makeDomainProvisioner(): DomainProvisioner | null {
  const token = process.env.CF_DNS_API_TOKEN ?? process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  const pagesProject = process.env.CF_PAGES_PROJECT ?? "invest254";
  const apiUser = process.env.NAMECHEAP_API_USER;
  const userName = process.env.NAMECHEAP_USERNAME ?? apiUser;
  const apiKey = process.env.NAMECHEAP_API_KEY;
  const clientIp = process.env.NAMECHEAP_CLIENT_IP;
  if (!token || !accountId || !apiUser || !userName || !apiKey || !clientIp) return null;
  const cdn = makeCloudflareCdn({ token, accountId });
  const registrar = makeNamecheapRegistrar({ apiUser, userName, apiKey, clientIp });
  return {
    pagesProject,
    provision: (domain) => provisionDomain(cdn, registrar, { domain, pagesProject }),
    status: (domain) => getDomainStatus(cdn, { domain, pagesProject }),
  };
}
