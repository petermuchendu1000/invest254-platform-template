import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Verifier, AuthClaims } from "@invest254/engine";

/**
 * A tiny, dependency-free HTTP router for the Invest254 REST surface (docs/05). We use
 * Node's built-in http server plus a typed path-pattern router rather than adding a web
 * framework — the correctness lives in the engine services/RPCs, so the transport only
 * needs routing, JSON (de)serialization, a uniform error envelope, and auth/role gates.
 *
 *   - Routes match `METHOD /path/:param` and expose `:param` values via `ctx.params`.
 *   - Handlers return a plain value (=> 200 JSON) or a `{ status, body }` pair, or throw
 *     `ApiError` for a controlled `{ error: { code, message } }` response.
 *   - Middleware run before the handler and may populate `ctx` (e.g. `claims`) or throw.
 */

/** Controlled API failure → `{ error: { code, message } }` with an HTTP status. */
export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  /** Parsed JSON body for non-GET requests (null if absent/empty). */
  body: unknown;
  /** Set by `requireAuth` once a caller is authenticated. */
  claims?: AuthClaims;
  /** Set by `requireSite`: the brand the request is scoped to (JWT `site` claim, else default). */
  siteId?: string;
}

export interface HandlerResult { status?: number; body: unknown; }
export type Handler = (ctx: Ctx) => Promise<HandlerResult | unknown> | HandlerResult | unknown;
export type Middleware = (ctx: Ctx) => Promise<void> | void;

interface Route { method: string; regex: RegExp; keys: string[]; chain: Array<Middleware | Handler>; }

/**
 * Role hierarchy — higher rank satisfies any lower minimum (see docs/05 §7). Four tiers:
 * player < marketer (also a player) < admin (day-to-day ops) < superadmin (full control).
 */
export const ROLE_RANK: Readonly<Record<string, number>> = {
  player: 1,
  marketer: 2,
  admin: 3,
  superadmin: 4,
  // Cross-brand platform owner: outranks a per-brand superadmin and reaches the /platform console.
  platform_superadmin: 5,
};

const MAX_BODY_BYTES = 1_000_000; // 1 MB cap on request bodies

/**
 * CORS. The player web app is served from a different origin (e.g. the Cloudflare Pages / brand
 * domains) than this API, so every browser request is preceded by a CORS preflight. Without these
 * headers the browser blocks the response and EVERY call (register/login/wallet/...) fails
 * silently in the UI while curl and the test suite still pass. Allowed origins come from
 * `CORS_ALLOWED_ORIGINS` (comma-separated); default `*`. Auth is via a Bearer token (not
 * cookies), so `*` is safe; set explicit origins in production for defence-in-depth.
 *
 * Multi-tenant (GAP 3): the platform serves MANY brand domains from ONE API, and brands are added
 * continuously, so a static allowlist can never keep up. When `CORS_ALLOWED_ORIGINS` is restricted
 * (not `*`), the router is additionally given a `corsAllowOrigin` predicate (wired in server.ts to
 * a cache of ACTIVE brand domains from the `sites` table), so every onboarded client's origin —
 * apex and `www.` — is allowed automatically without a redeploy, while unknown origins stay blocked.
 */
const CORS_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CORS_ALLOW_ALL = CORS_ORIGINS.includes("*");

/**
 * Pure CORS origin decision (exported for testing). An origin is allowed when the allowlist is `*`,
 * when it is explicitly listed, or when the injected `brandAllows` predicate accepts it (an active
 * brand domain). The predicate is defensive: a throw is treated as "not allowed".
 */
export function isOriginAllowed(
  origin: string | undefined,
  opts: { allowAll: boolean; allowList: readonly string[]; brandAllows?: (origin: string) => boolean },
): boolean {
  if (!origin) return false;
  if (opts.allowAll) return true;
  if (opts.allowList.includes(origin)) return true;
  try { return opts.brandAllows?.(origin) === true; } catch { return false; }
}

function applyCors(req: IncomingMessage, res: ServerResponse, brandAllows?: (origin: string) => boolean): void {
  const origin = req.headers["origin"];
  const o = typeof origin === "string" ? origin : undefined;
  if (o && isOriginAllowed(o, { allowAll: CORS_ALLOW_ALL, allowList: CORS_ORIGINS, ...(brandAllows ? { brandAllows } : {}) })) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
  } else if (CORS_ALLOW_ALL) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-User-Id,X-User-Role");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Baseline security response headers (defence-in-depth). This is a JSON API, so the CSP is
 * maximally strict (`default-src 'none'`). HSTS is safe because the API is HTTPS-only on Fly.
 */
function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
}

/** Best-effort client IP behind Fly's proxy: prefer Fly-Client-IP, then XFF, then the socket. */
export function clientIp(req: IncomingMessage): string {
  const fly = req.headers["fly-client-ip"];
  if (typeof fly === "string" && fly.trim()) return fly.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Fixed-window rate limiter (in-process; per API instance). Keyed by user id when a caller is
 * authenticated (place after requireAuth) else by client IP. Returns 429 with Retry-After when
 * the window is exceeded. Cross-instance limiting would need a shared store; this is a solid
 * first layer given the API runs a small, mostly-single warm machine.
 */
interface RlBucket { count: number; resetAt: number; }
export function rateLimit(opts: { name: string; limit: number; windowMs: number; by?: "ip" | "user" }): Middleware {
  const buckets = new Map<string, RlBucket>();
  return (ctx) => {
    const now = Date.now();
    if (buckets.size > 20_000) for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
    const key = opts.by === "user" && ctx.claims?.userId ? `u:${ctx.claims.userId}` : `ip:${clientIp(ctx.req)}`;
    const b = buckets.get(key);
    if (!b || now >= b.resetAt) { buckets.set(key, { count: 1, resetAt: now + opts.windowMs }); return; }
    if (b.count >= opts.limit) {
      ctx.res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      throw new ApiError("RATE_LIMITED", `too many ${opts.name} requests, slow down`, 429);
    }
    b.count += 1;
  };
}

// ── IPv4 CIDR allowlist (for Daraja callback source restriction) ───────────────────────────
function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) { const o = Number(p); if (!Number.isInteger(o) || o < 0 || o > 255) return null; n = ((n << 8) | o) >>> 0; }
  return n >>> 0;
}
function parseCidr(c: string): { base: number; mask: number } | null {
  const [ip, bitsRaw] = c.split("/");
  const ipInt = ipv4ToInt(ip ?? "");
  if (ipInt == null) return null;
  const bits = bitsRaw == null ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ipInt & mask) >>> 0, mask };
}
/**
 * Restrict a route to source IPs in the CIDRs named by `envVar` (comma-separated). When the env
 * var is unset the guard is DISABLED (fail-open) so it never breaks callbacks by accident; set
 * it to Safaricom's published ranges to lock the Daraja callback endpoints down (defence-in-depth
 * on top of STKPushQuery verification). IPv4 only; a non-IPv4 caller is rejected when enabled.
 */
export function restrictToCidrs(envVar: string): Middleware {
  const nets = (process.env[envVar] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    .map(parseCidr).filter((x): x is { base: number; mask: number } => x !== null);
  return (ctx) => {
    if (nets.length === 0) return; // disabled unless configured
    const ipInt = ipv4ToInt(clientIp(ctx.req));
    if (ipInt == null || !nets.some((n) => ((ipInt & n.mask) >>> 0) === n.base)) {
      throw new ApiError("FORBIDDEN", "source IP not allowlisted", 403);
    }
  };
}

function compile(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) { keys.push(seg.slice(1)); return "([^/]+)"; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}/?$`), keys };
}

export interface RouterOptions {
  /** Extra CORS allowance beyond CORS_ALLOWED_ORIGINS — e.g. an active-brand-domain predicate. */
  corsAllowOrigin?: (origin: string) => boolean;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly corsAllowOrigin?: (origin: string) => boolean;

  constructor(opts: RouterOptions = {}) {
    if (opts.corsAllowOrigin) this.corsAllowOrigin = opts.corsAllowOrigin;
  }

  private add(method: string, path: string, chain: Array<Middleware | Handler>): this {
    const { regex, keys } = compile(path);
    this.routes.push({ method, regex, keys, chain });
    return this;
  }
  // Last argument is the handler; any preceding arguments are middleware.
  get(path: string, ...chain: Array<Middleware | Handler>): this { return this.add("GET", path, chain); }
  post(path: string, ...chain: Array<Middleware | Handler>): this { return this.add("POST", path, chain); }
  patch(path: string, ...chain: Array<Middleware | Handler>): this { return this.add("PATCH", path, chain); }
  put(path: string, ...chain: Array<Middleware | Handler>): this { return this.add("PUT", path, chain); }
  del(path: string, ...chain: Array<Middleware | Handler>): this { return this.add("DELETE", path, chain); }

  /** Build a Node request listener that dispatches to the registered routes. */
  listener(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => { void this.handle(req, res); };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    applyCors(req, res, this.corsAllowOrigin);
    applySecurityHeaders(res);
    // Answer the CORS preflight before any routing/auth so browser write calls succeed.
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      let matchedPath = false;
      for (const route of this.routes) {
        const m = route.regex.exec(path);
        if (!m) continue;
        matchedPath = true;
        if (route.method !== method) continue;

        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });
        const ctx: Ctx = {
          req, res, method, path, params, query: url.searchParams,
          body: method === "GET" || method === "HEAD" ? null : await readJson(req),
        };

        let result: unknown;
        for (const step of route.chain) {
          const out = await step(ctx);
          // Only the final handler produces a response value; middleware return void.
          if (step === route.chain[route.chain.length - 1]) result = out;
        }
        return writeResult(res, result);
      }
      // Path exists but method does not → 405; otherwise 404.
      if (matchedPath) throw new ApiError("METHOD_NOT_ALLOWED", `${method} not allowed on ${path}`, 405);
      throw new ApiError("NOT_FOUND", `no route for ${method} ${path}`, 404);
    } catch (err) {
      writeError(res, err);
    }
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", "request body too large", 413);
    chunks.push(buf);
  }
  if (size === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new ApiError("BAD_JSON", "request body is not valid JSON", 400); }
}

function writeResult(res: ServerResponse, result: unknown): void {
  if (result && typeof result === "object" && "body" in (result as HandlerResult)) {
    const r = result as HandlerResult;
    return sendJson(res, r.status ?? 200, r.body);
  }
  sendJson(res, 200, result ?? {});
}

function writeError(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: "INTERNAL", message } });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

// ─────────────────────────── middleware ───────────────────────────

/**
 * Authenticate the caller from `Authorization: Bearer <jwt>`. When a `verifier` is
 * configured the token is cryptographically verified (Supabase JWT). When it is null the
 * service runs in DEV mode and trusts `X-User-Id`/`X-User-Role` headers — never for prod.
 */
export function requireAuth(verifier: Verifier | null): Middleware {
  return async (ctx) => {
    const header = ctx.req.headers["authorization"];
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (verifier) {
      if (!token) throw new ApiError("AUTH_REQUIRED", "missing bearer token", 401);
      try { ctx.claims = await verifier(token); }
      catch { throw new ApiError("AUTH_INVALID", "invalid or expired token", 401); }
    } else {
      const uid = ctx.req.headers["x-user-id"];
      if (typeof uid !== "string" || !uid) throw new ApiError("AUTH_REQUIRED", "missing X-User-Id (dev auth)", 401);
      const role = ctx.req.headers["x-user-role"];
      ctx.claims = { userId: uid, role: typeof role === "string" ? role : "player", raw: {} };
    }
  };
}

/** Gate a route to callers whose role meets `minRole` in the hierarchy. Run after requireAuth. */
export function requireRole(minRole: keyof typeof ROLE_RANK): Middleware {
  return (ctx) => {
    if (!ctx.claims) throw new ApiError("AUTH_REQUIRED", "authentication required", 401);
    const have = ROLE_RANK[ctx.claims.role ?? "player"] ?? 0;
    const need = ROLE_RANK[minRole] ?? Number.POSITIVE_INFINITY;
    if (have < need) throw new ApiError("FORBIDDEN", `requires role ${minRole}`, 403);
  };
}

/** The default (single-tenant) brand, seeded by migration 0044. */
export const DEFAULT_SITE_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Site scoping (docs/22 Task E). Runs AFTER `requireAuth`: derives `ctx.siteId` from the token's
 * `site` claim so every downstream read/mutation can implicitly filter to the caller's brand.
 * Legacy tokens minted before per-brand auth carry no claim → the default site. A request that
 * explicitly names a different brand (`?site=`) than its token is rejected (AUTH_SITE_MISMATCH),
 * closing the cross-brand access hole the JWT claim exists to prevent.
 */
export function requireSite(defaultSiteId: string = DEFAULT_SITE_ID): Middleware {
  return (ctx) => {
    if (!ctx.claims) throw new ApiError("AUTH_REQUIRED", "authentication required", 401);
    const siteId = ctx.claims.site ?? defaultSiteId;
    const named = ctx.query.get("site");
    if (named && named !== siteId) {
      throw new ApiError("AUTH_SITE_MISMATCH", "token is not scoped to the requested site", 403);
    }
    ctx.siteId = siteId;
  };
}

/**
 * Admin write-path per-brand enforcement (docs/22 Task H). The read side (Task E) already scopes
 * every admin LIST to the token's optional `site` claim; this is the matching guard for MUTATIONS.
 *
 * `adminScopeSite` returns the brand a caller is restricted to when acting, or null for unrestricted:
 *   - a platform_superadmin (rank 5) is cross-brand -> null (never restricted);
 *   - a platform admin token carries NO `site` claim -> null (unchanged single-tenant behaviour);
 *   - a site-scoped admin token carries a `site` claim -> that brand id.
 */
export function adminScopeSite(ctx: Ctx): string | null {
  if (!ctx.claims) throw new ApiError("AUTH_REQUIRED", "authentication required", 401);
  const platformRank = ROLE_RANK.platform_superadmin ?? Number.POSITIVE_INFINITY;
  if ((ROLE_RANK[ctx.claims.role ?? "player"] ?? 0) >= platformRank) return null;
  return ctx.claims.site ?? null;
}

/**
 * Reject a site-scoped admin mutating a target in another brand. TOLERANT by design: an unrestricted
 * caller (null scope) and an unresolved target (null site) both pass — the site-aware DB RPCs remain
 * the ultimate guard, and some in-memory mirrors can't resolve a target's brand. Only a KNOWN
 * cross-brand target is refused (SITE_SCOPE_FORBIDDEN, 403).
 */
export function assertTargetSiteInScope(ctx: Ctx, targetSite: string | null | undefined): void {
  const scope = adminScopeSite(ctx);
  if (scope === null) return;            // platform admin / platform_superadmin -> unrestricted
  if (targetSite == null) return;        // unknown target -> defer to the RPC's own site guard
  if (targetSite !== scope) {
    throw new ApiError("SITE_SCOPE_FORBIDDEN", "SITE_SCOPE_FORBIDDEN: target belongs to another brand", 403);
  }
}

/** Convenience: construct the Node server from a configured router. */
export function serverFrom(router: Router): Server {
  return createServer(router.listener());
}
