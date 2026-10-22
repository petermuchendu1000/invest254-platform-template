import { normalizeHost } from "@invest254/shared";

/**
 * Multi-tenant CORS allowance (GAP 3).
 *
 * The platform serves MANY brand domains from ONE API and onboards new brands continuously, so a
 * static `CORS_ALLOWED_ORIGINS` list can never keep up — hardening CORS would silently lock new
 * clients out of the backend. This keeps a fast, in-memory Set of ACTIVE brand hosts (normalized
 * apex form) so the CORS preflight decision stays synchronous and cheap, refreshed periodically
 * from the `sites` table (and seedable/pushable so a just-onboarded brand is allowed immediately).
 *
 * `allows(origin)` folds the request Origin to its apex host (via the shared normalizeHost, which
 * strips scheme/port and `www.`), so both `https://tamutraders.com` and `https://www.tamutraders.com`
 * are accepted for a brand whose `primary_domain` is `tamutraders.com`. Unknown origins are rejected.
 */
export type BrandHostSource = () => Promise<string[]>;

export class BrandOriginAllowlist {
  private hosts = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly source: BrandHostSource, private readonly refreshMs = 60_000) {}

  /** Load the initial set and start the periodic refresh (unref'd so it never holds the process open). */
  async init(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh().catch(() => { /* keep last good set */ }); }, this.refreshMs);
    this.timer.unref?.();
  }

  /** Replace the host set from the source. On error the previous set is kept (fail-safe). */
  async refresh(): Promise<void> {
    const rows = await this.source();
    const next = new Set<string>();
    for (const d of rows) {
      const h = normalizeHost(d);
      if (h) next.add(h);
    }
    this.hosts = next;
  }

  /** Pre-warm a single brand host (e.g. right after onboarding) without waiting for the interval. */
  add(host: string): void {
    const h = normalizeHost(host);
    if (h) this.hosts.add(h);
  }

  /** True if the given request Origin belongs to a known active brand domain (apex or www). */
  allows(origin: string): boolean {
    const h = normalizeHost(origin);
    return h.length > 0 && this.hosts.has(h);
  }

  /** Current number of allowed brand hosts (for logging/diagnostics). */
  get size(): number { return this.hosts.size; }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }
}

/**
 * NON-BRAND extra origins (preview deployments), opt-in via configuration.
 *
 * The dynamic brand set above answers "is this a client of ours?" — it can only ever contain real
 * brand domains from `sites`, which is exactly what we want it to be. But a Cloudflare Pages PR
 * preview is served from `https://<hash>.invest254.pages.dev` / `https://<branch>.invest254.pages.dev`,
 * which is nobody's brand domain, so a preview bundle calling the API gets no
 * `Access-Control-Allow-Origin` header at all and the browser blocks every request — the previews
 * are unusable for review. The hash changes on every push, so the existing exact-match
 * `CORS_ALLOWED_ORIGINS` list in http.ts cannot name them.
 *
 * This adds a SECOND, independent allowance read from the SAME `CORS_ALLOWED_ORIGINS` env var
 * (comma-separated, same format), which additionally understands one wildcard shape:
 *
 *   CORS_ALLOWED_ORIGINS=https://cpfmarket.com,https://*.invest254.pages.dev
 *
 * Entries without a wildcard keep working as exact origins (http.ts already matches those
 * verbatim); a `*.<suffix>` entry matches any SUBDOMAIN of `<suffix>`. Default is empty: a
 * deployment that configures nothing allows nothing extra and behaves exactly as before.
 *
 * Deliberately narrow, because this is a real-money API and every line below is a line a future
 * reader could loosen by accident:
 *
 *  - A bare `*` is IGNORED here. It is not a host pattern, and `*` + credentials-by-Bearer is the
 *    one combination we never want to grow into this matcher. (http.ts's own `*` default is
 *    unchanged and untouched by this file.)
 *  - The suffix match is anchored at BOTH ends: the host must end with `"." + suffix` and have at
 *    least one character before that dot. The leading dot is the label boundary, so
 *    `evil-invest254.pages.dev` is REFUSED (it ends with the suffix text but the preceding
 *    character is `-`, not a label separator); `endsWith` is the end anchor, so
 *    `invest254.pages.dev.attacker.com` is REFUSED (an attacker-owned parent domain). Replacing
 *    either anchor with `includes()`/`indexOf()` hands the whole API to any domain that can put
 *    our name in its own.
 *  - The apex itself (`invest254.pages.dev`) is NOT matched by `*.invest254.pages.dev`; list it
 *    explicitly if it is ever wanted.
 *  - Only `https:` is ever allowed, regardless of the host. Previews are https; an `http://`
 *    origin is a downgraded/attacker-controllable channel and is refused even when the host would
 *    otherwise match.
 *  - A suffix match also requires the default https port, so a matching host on some other port
 *    (a tunnel/proxy on the same name) does not inherit the allowance.
 */
export type ExtraOriginRule =
  | { readonly kind: "exact"; readonly origin: string }
  | { readonly kind: "suffix"; readonly suffix: string };

/**
 * Parse a `CORS_ALLOWED_ORIGINS`-style spec into rules. Tolerant by design — stray whitespace,
 * empty entries and a trailing comma are configuration typos, and throwing (or worse, falling back
 * to "allow everything") on a typo in a deploy-time env var is not an option for a live API. Every
 * entry that is not understood is simply DROPPED, so a malformed spec can only ever allow LESS.
 */
export function parseExtraOrigins(spec: string | null | undefined): ExtraOriginRule[] {
  const rules: ExtraOriginRule[] = [];
  for (const raw of (spec ?? "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry || entry === "*") continue;            // empty entry / trailing comma / bare wildcard
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(entry) && !entry.startsWith("https://")) continue; // http:// & co.
    const body = entry.replace(/^https:\/\//, "");
    if (!body || body.includes("/") || body.includes("@")) continue; // paths/userinfo are not origins
    if (body.startsWith("*.")) {
      const suffix = body.slice(2).replace(/^\.+/, "").replace(/\.+$/, "");
      // A wildcard must cover a real multi-label domain: `*.dev` / `*.com` is a wildcard in all but
      // name, and a suffix containing another `*` or a port is a typo we refuse to guess at.
      if (!suffix.includes(".") || suffix.includes("*") || suffix.includes(":")) continue;
      rules.push({ kind: "suffix", suffix });
      continue;
    }
    if (body.includes("*")) continue;                 // `*` anywhere else is not a shape we support
    rules.push({ kind: "exact", origin: `https://${body.replace(/\.$/, "")}` });
  }
  return rules;
}

/** Fold a request Origin to the comparable `https://host[:port]` form, or "" if it is not usable. */
function httpsOriginKey(origin: string): string {
  let url: URL;
  try { url = new URL(origin.trim()); } catch { return ""; }
  if (url.protocol !== "https:") return "";           // scheme matters: https only, always
  const hostname = url.hostname.toLowerCase().replace(/\.$/, ""); // drop the trailing FQDN dot
  if (!hostname) return "";
  return url.port ? `https://${hostname}:${url.port}` : `https://${hostname}`;
}

/**
 * The configured extra-origin allowance. Pure and synchronous (the CORS decision is on the request
 * path), parsed once at construction, and empty unless configured.
 */
export class ExtraOriginAllowlist {
  private readonly rules: readonly ExtraOriginRule[];

  constructor(spec?: string | null) { this.rules = parseExtraOrigins(spec); }

  /** Read the spec from the environment — the SAME `CORS_ALLOWED_ORIGINS` var http.ts already uses. */
  static fromEnv(env: Record<string, string | undefined> = process.env): ExtraOriginAllowlist {
    return new ExtraOriginAllowlist(env["CORS_ALLOWED_ORIGINS"]);
  }

  /** True if the request Origin is one of the configured extra (non-brand) origins. */
  allows(origin: string): boolean {
    if (this.rules.length === 0) return false;        // nothing configured -> nothing extra allowed
    const key = httpsOriginKey(origin);
    if (!key) return false;
    const hostname = key.slice("https://".length);
    const hasPort = hostname.includes(":");
    for (const r of this.rules) {
      if (r.kind === "exact") { if (key === r.origin) return true; continue; }
      if (hasPort) continue;                          // suffix rules cover the default https port only
      const dotted = `.${r.suffix}`;
      // Both anchors, on purpose — see the note above before touching this line.
      if (hostname.length > dotted.length && hostname.endsWith(dotted)) return true;
    }
    return false;
  }

  /** Number of configured rules (for logging/diagnostics); 0 means "behaves exactly as before". */
  get size(): number { return this.rules.length; }

  /** The parsed rules, for logging at boot so a misconfigured spec is visible. */
  describe(): string[] {
    return this.rules.map((r) => (r.kind === "exact" ? r.origin : `https://*.${r.suffix}`));
  }
}
