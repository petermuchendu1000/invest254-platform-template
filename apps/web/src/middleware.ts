import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAdminHost, operatorSurfaceAllowed } from '@/lib/brand/adminHost';

/**
 * Host routing for the operator domain (Issue 1).
 *
 * TWO rules, both keyed on the Host:
 *
 *  1. On an admin host the ROOT is the console, not the player app. We REDIRECT `/` → `/console`
 *     (not a rewrite) so the browser URL really becomes `/console`; the app chrome keys off the
 *     pathname, so this is what stops the player top-bar (brand + Login/Sign Up) from ever
 *     rendering on the admin domain.
 *
 *  2. Everywhere else the operator surfaces DO NOT EXIST. `/console`, `/admin/**` and
 *     `/platform/**` are rewritten to the 404 route unless the host is allowed to serve them.
 *
 * WHY RULE 2 IS HERE AND NOT ONLY IN THE LAYOUTS. The layouts call `notFound()` too (see
 * `requireOperatorHost`) and that is kept as the backstop, but a layout runs AFTER the route has
 * matched — and a matched route leaves its fingerprints in the 404 it renders. Measured on the
 * local build before this: `cpfmarket.com/console` answered 404 with no sign-in form, but the HTML
 * still preloaded `static/chunks/app/console/page-*.js` and carried `Console · CPF Market` in the
 * flight payload. A 404 that names the page it is hiding is not hiding it. Rewriting in the
 * middleware means Next never matches the segment, so there is no chunk to preload and no segment
 * metadata to serialise.
 *
 * The rewrite target is `/_not-found`, Next's own 404 route (it is in the build output), so the
 * visitor gets the real, brand-themed Not-found page with a real 404 status — the same response
 * this host gives for any other path that does not exist, which is the whole point.
 */
const OPERATOR_PATHS = ['/console', '/admin', '/platform'];

const isOperatorPath = (pathname: string): boolean =>
  OPERATOR_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export function middleware(req: NextRequest) {
  // The host list lives in lib/brand/adminHost so the BRAND path can read the same answer — see
  // the note there for why it had to.
  const host = req.headers.get('host');

  if (isOperatorPath(req.nextUrl.pathname) && !operatorSurfaceAllowed(host)) {
    const url = req.nextUrl.clone();
    url.pathname = '/_not-found';
    return NextResponse.rewrite(url, { status: 404 });
  }

  if (isAdminHost(host) && req.nextUrl.pathname === '/') {
    const url = req.nextUrl.clone();
    url.pathname = '/console';
    return NextResponse.redirect(url, 307);
  }

  return NextResponse.next();
}

// The root (rule 1) plus the operator surfaces and everything under them (rule 2). Static assets and
// every player route are untouched, so this adds a string comparison to one request in a page load.
export const config = {
  matcher: ['/', '/console', '/console/:path*', '/admin', '/admin/:path*', '/platform', '/platform/:path*'],
};
