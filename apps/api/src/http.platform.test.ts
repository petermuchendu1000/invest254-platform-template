import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_RANK, adminScopeSite, adminScopePlatform, assertTargetPlatformInScope, ApiError, type Ctx } from "./http.js";

/**
 * Unit coverage for the PLATFORM-tier scope primitives added for Issue 1. These pure functions are
 * the runtime chokepoint the API uses to bound a platform_admin to its ONE platform (the DB RPCs +
 * RLS are the deeper guards, proven in packages/db/_testkit/e2e_platform_isolation.py). We drive
 * them with synthetic claim sets — no server needed.
 */
const P1 = "10000000-0000-0000-0000-000000000001";
const P2 = "20000000-0000-0000-0000-000000000002";
const SA = "00000000-0000-0000-0000-0000000000a1";
const ctx = (claims: Record<string, unknown> | undefined): Ctx => ({ claims } as unknown as Ctx);

test("ROLE_RANK: platform_admin sits ABOVE site admin and BELOW the system owner", () => {
  const rank = (r: string): number => ROLE_RANK[r] ?? 0;
  assert.ok(rank("marketer") < rank("admin"), "marketer < site admin");
  assert.ok(rank("admin") < rank("platform_admin"), "site admin < platform admin");
  assert.ok(rank("platform_admin") < rank("platform_superadmin"), "platform admin < system owner");
});

test("adminScopeSite: platform_admin is NOT bound to a single site (its bound is the platform)", () => {
  // Even with a `site` claim, a platform_admin must not be treated as a one-brand admin.
  assert.equal(adminScopeSite(ctx({ userId: "u", role: "platform_admin", site: SA, platform: P1 })), null);
  // A plain site admin stays bound to its site.
  assert.equal(adminScopeSite(ctx({ userId: "u", role: "admin", site: SA })), SA);
  // The system owner is unrestricted.
  assert.equal(adminScopeSite(ctx({ userId: "u", role: "platform_superadmin" })), null);
});

test("adminScopePlatform: returns the platform a caller is bounded to (or null when unrestricted)", () => {
  assert.equal(adminScopePlatform(ctx({ userId: "u", role: "platform_admin", platform: P1 })), P1);
  assert.equal(adminScopePlatform(ctx({ userId: "u", role: "platform_superadmin" })), null, "system owner: every platform");
  assert.equal(adminScopePlatform(ctx({ userId: "u", role: "admin", site: SA })), null, "site admin: bounded at site, not platform");
  assert.equal(adminScopePlatform(ctx({ userId: "u", role: "player" })), null);
});

test("assertTargetPlatformInScope: a platform_admin may act only inside its own platform", () => {
  const pa = ctx({ userId: "u", role: "platform_admin", platform: P1 });
  // in-scope target: no throw
  assert.doesNotThrow(() => assertTargetPlatformInScope(pa, P1));
  // cross-platform target: 403 PLATFORM_SCOPE_FORBIDDEN
  let caught: ApiError | undefined;
  try { assertTargetPlatformInScope(pa, P2); } catch (e) { caught = e as ApiError; }
  assert.ok(caught instanceof ApiError, "threw an ApiError");
  assert.equal(caught!.code, "PLATFORM_SCOPE_FORBIDDEN");
  assert.equal(caught!.status, 403);
  // FAIL CLOSED (Issue 1 / BUGLOG-0001): an UNRESOLVED target platform (null) is now REFUSED for a
  // bounded platform_admin — never deferred. Deferring is what let cross-platform targets through.
  let nullCaught: ApiError | undefined;
  try { assertTargetPlatformInScope(pa, null); } catch (e) { nullCaught = e as ApiError; }
  assert.ok(nullCaught instanceof ApiError, "unresolved target throws");
  assert.equal(nullCaught!.code, "PLATFORM_SCOPE_FORBIDDEN");
  assert.equal(nullCaught!.status, 403);
});

test("adminScopePlatform / assertTargetPlatformInScope: a platform_admin with NO platform claim is refused (fail closed)", () => {
  const claimless = ctx({ userId: "u", role: "platform_admin" }); // no `platform` claim
  let c1: ApiError | undefined;
  try { adminScopePlatform(claimless); } catch (e) { c1 = e as ApiError; }
  assert.ok(c1 instanceof ApiError, "claimless platform_admin scope throws");
  assert.equal(c1!.code, "PLATFORM_CLAIM_MISSING");
  assert.equal(c1!.status, 403);
  // the target guard also refuses (it calls adminScopePlatform first)
  assert.throws(() => assertTargetPlatformInScope(claimless, P1), ApiError);
});

test("assertTargetPlatformInScope: the system owner is never platform-restricted", () => {
  const sys = ctx({ userId: "u", role: "platform_superadmin" });
  assert.doesNotThrow(() => assertTargetPlatformInScope(sys, P1));
  assert.doesNotThrow(() => assertTargetPlatformInScope(sys, P2));
});

test("scope guards reject an unauthenticated context", () => {
  assert.throws(() => adminScopeSite(ctx(undefined)), ApiError);
  assert.throws(() => adminScopePlatform(ctx(undefined)), ApiError);
});
