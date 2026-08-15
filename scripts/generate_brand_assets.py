#!/usr/bin/env python3
"""
Theme-AWARE per-client favicon generator (docs/24 §13).

Generates each client's favicon as an SVG derived FROM ITS THEME TOKENS (colours) + slug (shape),
so the tab icon always matches the brand's current theme — regenerate after any theme change and it
tracks. Pure vector => crisp at every size (16px -> 512px). Writes sites.favicon_url (SVG data URI)
and clears sites.logo_url so the app renders the live, theme-driven inline mark (which recolours
instantly with the theme + light/dark). Mirrors apps/web/src/lib/brand/mark.ts EXACTLY, so a
backfill here and an in-console "apply theme" produce the identical icon.

Usage:
  DATABASE_URL=... python3 scripts/generate_brand_assets.py --all         # backfill every client
  DATABASE_URL=... python3 scripts/generate_brand_assets.py --slug lucky7  # one client

Note: an optional AI raster logo (Cloudflare Workers AI / Ideogram / Recraft) can be uploaded per
client as a `logo_url` OVERRIDE for a bespoke mark; it is intentionally NOT the default because a
baked raster cannot be theme-aware. The default mark is the vector above.
"""
import argparse, base64, os, sys


def mark_variant(seed: str, variants: int = 4) -> int:
    x = 0
    for ch in seed:
        x = (x * 31 + ord(ch)) & 0xFFFFFFFF
    return x % variants


def _inner(variant: int, ink: str) -> str:
    fill = f'style="fill:{ink}"'
    stroke = f'style="fill:none;stroke:{ink}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"'
    if variant == 1:
        return f'<path {fill} d="M32 15 L48 33 L39 33 L39 49 L25 49 L25 33 L16 33 Z"/>'
    if variant == 2:
        return f'<g {stroke}><path d="M19 37 L32 24 L45 37"/><path d="M19 47 L32 34 L45 47"/></g>'
    if variant == 3:
        return (f'<g {stroke}><polyline points="16,44 27,33 35,39 46,22"/></g>'
                f'<path {fill} d="M39 20 L49 19 L48 29 Z"/>')
    return ('<g ' + fill + '>'
            '<rect x="16" y="35" width="8" height="12" rx="2.5"/>'
            '<rect x="28" y="28" width="8" height="19" rx="2.5"/>'
            '<rect x="40" y="19" width="8" height="28" rx="2.5"/></g>')


def build_mark_svg(c1: str, c2: str, ink: str, variant: int, size: int = 64) -> str:
    gid = f"ppm-{variant}"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{size}" height="{size}" role="img">'
        f'<defs><linearGradient id="{gid}" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" style="stop-color:{c1}"/><stop offset="1" style="stop-color:{c2}"/>'
        f'</linearGradient></defs>'
        f'<rect x="2" y="2" width="60" height="60" rx="15" fill="url(#{gid})"/>'
        + _inner(variant, ink) + '</svg>'
    )


def favicon_data_uri(tokens: dict, seed: str) -> str:
    c1 = tokens.get("brand") or "#3861FB"
    c2 = tokens.get("accent") or tokens.get("brandHover") or c1
    ink = tokens.get("accentFg") or "#FFFFFF"
    svg = build_mark_svg(c1, c2, ink, mark_variant(seed))
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug"); ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    dburl = os.environ.get("DATABASE_URL")
    if not dburl:
        sys.exit("DATABASE_URL is required")
    import psycopg2
    conn = psycopg2.connect(dburl); conn.autocommit = False; cur = conn.cursor()
    if a.slug:
        cur.execute("select slug, name, theme_tokens, color_primary from sites where slug=%s", [a.slug])
    elif a.all:
        cur.execute("select slug, name, theme_tokens, color_primary from sites")
    else:
        sys.exit("pass --slug <slug> or --all")
    for slug, name, tokens, color_primary in cur.fetchall():
        tk = tokens or {"brand": color_primary}
        fav = favicon_data_uri(tk, slug)
        cur.execute("update sites set favicon_url=%s, logo_url='', updated_at=now() where slug=%s", [fav, slug])
        print(f"themed favicon set for {slug} ({name}) - variant {mark_variant(slug)}")
    conn.commit(); conn.close()
    print("done - live on next /site/brand fetch; recolours on any theme change")


if __name__ == "__main__":
    main()
