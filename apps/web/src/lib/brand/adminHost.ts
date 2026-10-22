/**
 * Which hosts serve the OPERATOR CONSOLE instead of a player brand.
 *
 * One definition, shared by `middleware.ts` (which redirects `/` to `/console` on these hosts) and
 * by `currentBrand()` (which must not ask the API for a brand that cannot exist). It lived only in
 * the middleware, so the brand path had no idea the admin domain was special and treated it as an
 * unresolvable player host on every single request.
 *
 * Edge-safe: plain string work, no Node APIs, because the middleware runs in the edge runtime.
 *
 * `ADMIN_HOST` is a comma-separated list. It is currently set in NO deployment config, so the
 * literal default below is what production actually runs on.
 */
export const ADMIN_HOSTS: readonly string[] = (process.env.ADMIN_HOST || 'triocodes.com')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

/**
 * Is this request's Host an operator host?
 *
 * Accepts a raw Host header: the port is stripped and `www.` is matched, which is what the
 * middleware already did and what the brand path now needs to agree with exactly. Two different
 * answers to this question would be worse than one wrong one.
 */
export function isAdminHost(host: string | null | undefined): boolean {
  const h = hostname(host);
  if (!h) return false;
  return ADMIN_HOSTS.some((a) => h === a || h === `www.${a}`);
}

/**
 * The bare hostname: port stripped, trimmed, lower-cased. Empty string when there is no Host.
 *
 * A bracketed IPv6 literal is kept whole (`[::1]:3100` → `[::1]`). Splitting such a Host on the
 * first colon yields `[`, which would make an IPv6 loopback look like a public host — the bracket
 * form is the only legal way to write an IPv6 address in a Host header (RFC 3986 §3.2.2), so it is
 * the one that has to work.
 */
function hostname(host: string | null | undefined): string {
  const raw = (host ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    return close > 0 ? raw.slice(0, close + 1) : raw;
  }
  return raw.split(':')[0]?.trim() ?? '';
}

/**
 * May the OPERATOR SURFACES (`/console`, `/admin/**`, `/platform/**`) render for this Host?
 *
 * They used to render for ANY host. Every brand domain we serve answered `/console` with the
 * operator sign-in form — verified against production before this gate: `cpfmarket.com/console`,
 * `/admin` and `/platform` all returned 200. Nothing was EXPOSED by that (each surface checks the
 * token's role and shows a 404 to anyone below `admin`), but a credential form for the back office
 * stood on every client's public domain, which is a login page to brute-force, a page to phish a
 * lookalike of, and a plain statement to any visitor that the brand they are playing on is one skin
 * of something larger. The console answers on the operator domain; a brand domain should behave as
 * though these paths do not exist.
 *
 * THE ALLOWANCE IS DELIBERATE, not a leftover. Two kinds of host that are not the operator domain
 * must still serve the console, or this gate would break the ways we have of checking it works:
 *
 *  - LOCAL AND TEST hosts (`localhost`, a loopback IP, `*.test`, `*.localhost`). `apps/web/e2e`
 *    drives the console at `http://127.0.0.1:3100/console` and `/admin/identity`; `digits.e2e`
 *    serves a brand at `tamu.test`. Without this, every operator e2e — the `web roles e2e` CI job —
 *    would 404 instead of testing anything.
 *  - `*.pages.dev`, the Cloudflare Pages deployment's own URL. A deploy is checked there before a
 *    domain points at it; locking the console out of it would mean the one surface we cannot verify
 *    before release is the operator's.
 *
 * Neither weakens the gate in production: on Cloudflare the Host is the domain the visitor typed,
 * so a client's brand domain can never present itself as `localhost` or a loopback address.
 */
export function operatorSurfaceAllowed(host: string | null | undefined): boolean {
  const h = hostname(host);
  if (!h) return false; // No Host at all: fail closed.
  if (isAdminHost(h)) return true;
  if (h === 'localhost' || h === '[::1]') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.test')) return true;
  return h.endsWith('.pages.dev');
}
