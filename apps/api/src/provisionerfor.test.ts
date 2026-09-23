import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProvisioner, DEFAULT_PLATFORM_ID } from "./provisionerfor.js";

/** docs/42 UI-9 — which registrar each platform's domain provisioning uses. */
type P = { via: string };
const OTHER = "20000000-0000-0000-0000-000000000002";
function deps(stored: Record<string, string | "throw">, env: P | null = { via: "env" }) {
  const built: string[] = [];
  return {
    built,
    d: {
      envProvisioner: env,
      buildRegistrar: async (pid: string) => {
        built.push(pid);
        const v = stored[pid];
        if (v === "throw") throw new Error("ENC_KEY_NOT_CONFIGURED");
        return v ?? null;
      },
      make: (reg: string | null): P => ({ via: reg ?? "none" }),
    },
  };
}

test("UI-9: the default platform uses the registrar the owner SAVED for it (was silently ignored)", async () => {
  const { d } = deps({ [DEFAULT_PLATFORM_ID]: "owner-db-namecheap" });
  assert.deepEqual(await resolveProvisioner(DEFAULT_PLATFORM_ID, d), { via: "owner-db-namecheap" });
  assert.deepEqual(await resolveProvisioner(null, d), { via: "owner-db-namecheap" }, "owner acting globally = default platform");
});

test("UI-9: the default platform falls back to the env registrar when none (or an unreadable one) is stored", async () => {
  assert.deepEqual(await resolveProvisioner(DEFAULT_PLATFORM_ID, deps({}).d), { via: "env" });
  assert.deepEqual(await resolveProvisioner(null, deps({ [DEFAULT_PLATFORM_ID]: "throw" }).d), { via: "env" });
});

test("Issue 1 #3 (kept): another platform uses ITS OWN registrar, else none — never the owner's", async () => {
  assert.deepEqual(await resolveProvisioner(OTHER, deps({ [OTHER]: "their-namecheap" }).d), { via: "their-namecheap" });
  assert.deepEqual(await resolveProvisioner(OTHER, deps({ [DEFAULT_PLATFORM_ID]: "owner" }).d), { via: "none" });
  await assert.rejects(resolveProvisioner(OTHER, deps({ [OTHER]: "throw" }).d), /ENC_KEY/, "a broken platform config surfaces, not the owner's creds");
});

test("no Cloudflare -> no provisioning at all", async () => {
  const x = deps({ [OTHER]: "their" }, null);
  assert.equal(await resolveProvisioner(OTHER, x.d), null);
  assert.deepEqual(x.built, [], "registrar never consulted");
});
