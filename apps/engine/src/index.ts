/**
 * @invest254/engine — public, side-effect-free barrel.
 *
 * Re-exports the reusable repositories, services and types so other apps (notably
 * apps/api, the HTTP transport) can compose them WITHOUT importing `server.ts`, which
 * boots the WebSocket server (top-level await, listeners, timers) as an import side
 * effect. The package `main`/`exports` point here; the WS process is still started via
 * the `start` script (`tsx src/server.ts`).
 *
 * Note: `Querier` is owned by `wallet.ts` and re-exported once; `engagement.ts` and
 * `payments.ts` only `import type` it, so there is no duplicate-export collision.
 */
export * from "./auth.js";
export * from "./identity.js";
export * from "./authservice.js";
export * from "./affiliateservice.js";
export * from "./paging.js";
export * from "./wallet.js";
export * from "./gameconfig.js";
export * from "./engagement.js";
export * from "./game.js";
export * from "./daycontext.js";
export * from "./recovery.js";
export * from "./sitecontext.js";
export * from "./siteregistry.js";
export * from "./multiengine.js";
export * from "./payments.js";
export * from "./paymentservice.js";
export * from "./admin.js";
export * from "./adminservice.js";
export * from "./platform.js";
export * from "./notifications.js";
export * from "./overrides.js";
export * from "./daraja.js";
