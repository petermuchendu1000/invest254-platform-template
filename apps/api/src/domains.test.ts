import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionDomain, getDomainStatus, splitDomain, type CdnClient, type RegistrarClient, type PagesDomainInfo } from "./domains.js";

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
