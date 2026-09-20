import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionDomain, getDomainStatus, splitDomain, makeNamecheapRegistrar, makeDomainProvisioner, type CdnClient, type RegistrarClient, type PagesDomainInfo } from "./domains.js";

function fakes() {
  const calls: string[] = [];
  const pagesByProject = new Map<string, PagesDomainInfo[]>();
  const cdn: CdnClient = {
    async ensureZone(domain) { calls.push(`ensureZone:${domain}`); return { zoneId: "z1", nameServers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"], status: "pending" }; },
    async addDnsRecord(zoneId, rec) { calls.push(`dns:${rec.name}->${rec.content}:${rec.proxied}`); },
    async addPagesDomain(project, name) { calls.push(`pages:${project}:${name}`); const arr = pagesByProject.get(project) ?? []; const info = { name, status: "initializing" }; arr.push(info); pagesByProject.set(project, arr); return info; },
    async zoneStatus() { return "active"; },
    async pagesDomains(project) { return pagesByProject.get(project) ?? []; },
  };
  const registrar: RegistrarClient = {
    async setNameservers(domain, ns) { calls.push(`ns:${domain}:${ns.join(",")}`); return true; },
    async listDomains() { return []; },
  };
  return { cdn, registrar, calls };
}

test("splitDomain: apex and multi-level TLDs", () => {
  assert.deepEqual(splitDomain("tamutraders.com"), { sld: "tamutraders", tld: "com" });
  assert.deepEqual(splitDomain("www.tamutraders.com"), { sld: "tamutraders", tld: "com" });
  assert.deepEqual(splitDomain("lucky7.co.ke"), { sld: "lucky7", tld: "co.ke" });
});

test("provisionDomain: runs zone -> nameservers -> apex+www DNS -> apex+www Pages, in order", async () => {
  const { cdn, registrar, calls } = fakes();
  const res = await provisionDomain(cdn, registrar, { domain: "tamutraders.com", pagesProject: "invest254" });

  assert.equal(res.zoneId, "z1");
  assert.deepEqual(res.nameServers, ["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
  assert.equal(res.nameserversUpdated, true);
  assert.equal(res.pages.length, 2);

  assert.deepEqual(calls, [
    "ensureZone:tamutraders.com",
    "ns:tamutraders.com:a.ns.cloudflare.com,b.ns.cloudflare.com",
    "dns:tamutraders.com->invest254.pages.dev:true",
    "dns:www.tamutraders.com->invest254.pages.dev:true",
    "pages:invest254:tamutraders.com",
    "pages:invest254:www.tamutraders.com",
  ]);
});

test("provisionDomain: normalizes a leading www and tolerates duplicate records", async () => {
  const { cdn, registrar, calls } = fakes();
  // Make addDnsRecord throw once to prove it is tolerated.
  let first = true;
  const cdn2 = { ...cdn, addDnsRecord: async (z: string, r: { name: string }) => { if (first) { first = false; throw new Error("exists"); } calls.push(`dns:${r.name}`); } };
  const res = await provisionDomain(cdn2 as CdnClient, registrar, { domain: "www.tamutraders.com", pagesProject: "invest254" });
  assert.equal(res.domain, "tamutraders.com"); // leading www stripped
  assert.ok(res.pages.length === 2);
});

test("provisionDomain: registrar=null (manual NS) still sets up Cloudflare + returns the nameservers to set", async () => {
  const { cdn } = fakes();
  const res = await provisionDomain(cdn, null, { domain: "shikafx.com", pagesProject: "invest254" });
  assert.equal(res.nameserversUpdated, false);               // no registrar -> not auto-updated
  assert.ok(res.nameServers.length > 0);                     // but the CF nameservers are returned
  assert.match(res.note, /Action needed/i);                  // clear manual instruction
  assert.match(res.note, new RegExp(res.nameServers[0]!.replace(/\./g, "\\.")));
  assert.equal(res.pages.length, 2);                          // apex + www Pages domains still attached
});

test("provisionDomain: a registrar failure degrades to manual NS, not a hard error", async () => {
  const { cdn } = fakes();
  const failing: RegistrarClient = { setNameservers: async () => { throw new Error("namecheap 401"); }, listDomains: async () => [] };
  const res = await provisionDomain(cdn, failing, { domain: "shikafx.com", pagesProject: "invest254" });
  assert.equal(res.nameserversUpdated, false);
  assert.match(res.note, /Action needed/i);
});

test("getDomainStatus: active only when zone active and all pages domains active", async () => {
  const { cdn } = fakes();
  await cdn.addPagesDomain("invest254", "tamutraders.com");
  const s1 = await getDomainStatus(cdn, { domain: "tamutraders.com", pagesProject: "invest254" });
  assert.equal(s1.zoneStatus, "active");
  assert.equal(s1.active, false); // pages domain is "initializing"

  const cdn2: CdnClient = { ...cdn, pagesDomains: async () => [{ name: "tamutraders.com", status: "active" }] };
  const s2 = await getDomainStatus(cdn2, { domain: "tamutraders.com", pagesProject: "invest254" });
  assert.equal(s2.active, true);
});

test("makeNamecheapRegistrar.listDomains: parses getList (lowercases, reads Expires + IsOurDNS)", async () => {
  const xml = `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse>
    <DomainGetListResult>
      <Domain ID="1" Name="Alpha.com" User="muchendu" Expires="01/01/2027" IsExpired="false" IsOurDNS="true"/>
      <Domain ID="2" Name="beta.co.ke" User="muchendu" Expires="02/02/2028" IsExpired="false" IsOurDNS="false"/>
    </DomainGetListResult>
    <Paging><TotalItems>2</TotalItems><CurrentPage>1</CurrentPage><PageSize>100</PageSize></Paging>
  </CommandResponse></ApiResponse>`;
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(xml, { status: 200 }); }) as unknown as typeof fetch;
  try {
    const reg = makeNamecheapRegistrar({ apiUser: "u", userName: "u", apiKey: "k", clientIp: "1.2.3.4" });
    const doms = await reg.listDomains();
    assert.deepEqual(doms, [
      { domain: "alpha.com", expires: "01/01/2027", usingRegistrarDns: true },
      { domain: "beta.co.ke", expires: "02/02/2028", usingRegistrarDns: false },
    ]);
    assert.equal(calls, 1); // out.length(2) >= TotalItems(2) -> single page
  } finally { globalThis.fetch = orig; }
});

test("makeNamecheapRegistrar.listDomains: surfaces a Namecheap API error (e.g. IP not whitelisted)", async () => {
  const xml = `<ApiResponse Status="ERROR"><Errors><Error Number="1011150">Invalid request IP: 1.2.3.4</Error></Errors></ApiResponse>`;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch;
  try {
    const reg = makeNamecheapRegistrar({ apiUser: "u", userName: "u", apiKey: "k", clientIp: "1.2.3.4" });
    await assert.rejects(() => reg.listDomains(), /NAMECHEAP_IP_NOT_WHITELISTED: 1\.2\.3\.4/);
  } finally { globalThis.fetch = orig; }
});

// A platform admin without its own registrar must NEVER borrow the system owner's env Namecheap
// (bug fix): makeDomainProvisioner(null) is Cloudflare-only, even when env NAMECHEAP_* is set; only an
// omitted (undefined) override uses the env registrar (the system owner's own default-platform path).
test("makeDomainProvisioner: explicit null override suppresses the env registrar (no owner fallback)", () => {
  const KEYS = ["CF_API_TOKEN", "CF_DNS_API_TOKEN", "CF_ACCOUNT_ID", "CF_PAGES_PROJECT",
    "NAMECHEAP_API_USER", "NAMECHEAP_USERNAME", "NAMECHEAP_API_KEY", "NAMECHEAP_CLIENT_IP"];
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try {
    process.env.CF_API_TOKEN = "cf-token"; process.env.CF_ACCOUNT_ID = "cf-acct"; delete process.env.CF_DNS_API_TOKEN;
    process.env.NAMECHEAP_API_USER = "owner"; process.env.NAMECHEAP_USERNAME = "owner";
    process.env.NAMECHEAP_API_KEY = "owner-key"; process.env.NAMECHEAP_CLIENT_IP = "1.2.3.4";
    // Omitted override => the system owner's env registrar IS configured.
    assert.equal(makeDomainProvisioner()?.registrarConfigured, true, "env path keeps the owner registrar");
    // Explicit null => NO registrar, despite the owner's env creds being present.
    assert.equal(makeDomainProvisioner(null)?.registrarConfigured, false, "null override never borrows the owner registrar");
    // A supplied per-platform registrar is used as-is.
    const own: RegistrarClient = { async setNameservers() { return true; }, async listDomains() { return []; } };
    assert.equal(makeDomainProvisioner(own)?.registrarConfigured, true, "own registrar is used");
  } finally {
    for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});
