import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from '@/components/Providers';
import { BrandProvider } from '@/lib/brand/BrandProvider';
import { resolveBrand, brandRootStyle, brandWordmark, type Brand } from '@/lib/brand/brand';
import { env } from '@/lib/env';

/** The incoming host (proxy-aware) — drives which brand this request renders. */
function requestHost(): string {
  const h = headers();
  return (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0]!.trim();
}

/** Resolve the brand for the current request (host → API `sites` row, cached briefly upstream). */
async function currentBrand(): Promise<Brand> {
  return resolveBrand(env.apiBaseUrl, requestHost());
}

// Per-brand document metadata: title/description/icons/theme-colour all come from the resolved
// brand, so one deployment serves each domain its own identity (no rebuild per brand).
export async function generateMetadata(): Promise<Metadata> {
  const b = await currentBrand();
  const name = brandWordmark(b);
  return {
    title: { default: b.name, template: `%s · ${b.name}` },
    description: `${b.name} — real-money trade-prediction game. Predict BUY/SELL on the live curve.`,
    applicationName: b.name,
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: b.name },
    icons: b.faviconUrl
      ? { icon: [{ url: b.faviconUrl }], apple: [{ url: b.faviconUrl }] }
      : {
          icon: [{ url: '/favicon.png', type: 'image/png' }],
          apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
        },
    other: { 'brand-wordmark': name },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const b = await currentBrand();
  return {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    themeColor: b.colorBg,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const brand = await currentBrand();
  // Brand default theme seeds the class; a stored user preference (pp-theme) still wins, applied
  // before paint to avoid a flash. 'auto'/'dark' → dark-first; 'light' → light.
  const brandDefaultTheme = brand.theme === 'light' ? 'light' : 'dark';
  const initialClass = brandDefaultTheme === 'light' ? 'light' : 'dark';
  const themeInit = `(function(){try{var d=${JSON.stringify(brandDefaultTheme)};var s=localStorage.getItem('pp-theme');var t=s||d;var e=document.documentElement;e.classList.remove('light','dark');e.classList.add(t==='light'?'light':'dark');}catch(e){}})();`;

  return (
    <html lang="en" className={initialClass} data-brand={brand.slug} style={brandRootStyle(brand) as React.CSSProperties}>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <BrandProvider brand={brand}>
          <Providers>
            <AppShell>{children}</AppShell>
          </Providers>
        </BrandProvider>
      </body>
    </html>
  );
}
