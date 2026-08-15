/**
 * Assign a curated crypto-site brand theme to a client (docs/22 branding). Each client mirrors a
 * distinct real site so no two look alike. Writes sites.theme_tokens (full palette) + the theme
 * mode + color_primary/bg/accent; the change is served LIVE by GET /site/brand (no redeploy).
 *
 * Usage:
 *   DATABASE_URL=... node --import tsx scripts/apply_site_theme.ts <brand-slug> <theme-id>
 *   DATABASE_URL=... node --import tsx scripts/apply_site_theme.ts --list
 *
 * Theme ids are the source sites in apps/web/src/lib/brand/siteThemes.json (e.g. coinmarketcap,
 * binance, kraken, coinbase, uniswap, ...). Idempotent; re-running re-applies.
 */
import fs from 'node:fs';
import { Pool } from 'pg';

interface SiteTheme { id: string; label: string; mode: 'dark' | 'light'; tokens: Record<string, string> }

async function main(): Promise<void> {
  const themesUrl = new URL('../apps/web/src/lib/brand/siteThemes.json', import.meta.url);
  const themes = JSON.parse(fs.readFileSync(themesUrl, 'utf8')) as SiteTheme[];

  const [slug, themeId] = process.argv.slice(2);
  if (slug === '--list' || !slug || !themeId) {
    console.log('Available themes:\n' + themes.map((t) => `  ${t.id.padEnd(16)} ${t.label} (${t.mode})`).join('\n'));
    if (slug !== '--list') { console.error('\nUsage: apply_site_theme.ts <brand-slug> <theme-id>'); process.exit(1); }
    return;
  }

  const t = themes.find((x) => x.id === themeId.trim().toLowerCase());
  if (!t) { console.error(`Unknown theme "${themeId}". Run with --list to see options.`); process.exit(1); }
  const tk = t.tokens;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const r = await pool.query(
      `update sites set theme = $1, color_primary = $2, color_bg = $3, color_accent = $4,
              theme_tokens = $5::jsonb
        where slug = $6 returning id, slug, name`,
      [t.mode, tk.brand, tk.bg, tk.accent, JSON.stringify(tk), slug],
    );
    if (!r.rows.length) { console.error(`No brand with slug "${slug}".`); process.exit(1); }
    const row = r.rows[0] as { name: string };
    console.log(`Applied "${t.label}" (${t.mode}) to ${slug} — ${row.name}. Live on next /site/brand fetch.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('APPLY_SITE_THEME ERROR:', (e as Error).message); process.exit(1); });
