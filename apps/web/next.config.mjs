/** @type {import('next').NextConfig} */

// NOTE: admin-domain root routing (triocodes.com/ -> /console) is handled in src/middleware.ts via a
// REDIRECT (not a rewrite), so the URL becomes /console and the player chrome never renders there.

const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework. `X-Powered-By: Next.js` tells a scanner exactly which
  // framework+version-range to aim its known-CVE payloads at, for no benefit to anyone.
  // Security response headers live in public/_headers, not in a `headers()` entry here: the app
  // is Edge-runtime via next-on-pages, and Cloudflare Pages serves the static/edge output
  // directly, so `headers()` is not honoured for it.
  poweredByHeader: false,
  // @invest254/shared ships raw TypeScript (ESM with .js specifiers); let Next
  // transpile it and resolve the .js specifiers back to the .ts sources.
  transpilePackages: ['@invest254/shared'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
