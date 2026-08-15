#!/usr/bin/env python3
"""
Autonomous per-client brand-asset generator (docs/24 — logo + favicon pipeline).

Generates a UNIQUE, professional brand MARK for each client with Cloudflare Workers AI
(@cf/black-forest-labs/flux-1-schnell — server-side, uses the platform's existing Cloudflare
creds, no third-party key), builds an optimised favicon + logo tile, and writes them to
`sites.favicon_url` / `sites.logo_url` as compact PNG data URIs. Served LIVE by GET /site/brand
(no redeploy). The mark is a self-contained rounded tile, so it reads on BOTH light and dark themes;
the app renders the wordmark text itself in the theme foreground colour (Logo component), so the
full lockup is theme-responsive without baking text into the image.

Design rationale (docs/24 §6.2): mark-only (no baked text) => light/dark responsive; data-URI
storage => zero infra / no R2 egress dependency / instant. For very large asset sets, swap the
`store_*` calls for an R2/S3 upload from the Fly API (which can reach R2) and store the URL instead.

Usage:
  CF_ACCOUNT_ID=... CF_WORKERS_AI_KEY=... DATABASE_URL=... \
    python3 scripts/generate_brand_assets.py --slug tamutraders          # one client
  ... python3 scripts/generate_brand_assets.py --all                     # every client missing assets
  ... python3 scripts/generate_brand_assets.py --all --force             # regenerate everyone

Env:
  CF_ACCOUNT_ID       Cloudflare account id (Workers AI)
  CF_WORKERS_AI_KEY   Cloudflare Workers AI API token
  DATABASE_URL        Postgres (Supabase) connection string
"""
import argparse, base64, io, json, os, sys, urllib.request

FLUX = "@cf/black-forest-labs/flux-1-schnell"


def _cf(account: str, key: str, prompt: str, steps: int = 8):
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{FLUX}",
        data=json.dumps({"prompt": prompt, "steps": steps}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["result"]["image"]


def _darken(hex_: str, f: float = 0.55) -> str:
    h = hex_.lstrip("#"); r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return "#%02X%02X%02X" % (int(r * f), int(g * f), int(b * f))


def _prompt(name: str, brand_hex: str) -> str:
    initial = (name.strip()[:1] or "X").upper()
    return (
        f"Professional flat vector app icon logo for a crypto trading brand named '{name}'. "
        f"A bold abstract geometric mark combining the letter '{initial}' with a rising chart "
        f"candlestick/arrow motif. Gradient from {brand_hex} to {_darken(brand_hex)}. Rounded-square "
        f"tile, crisp clean edges, centered, minimal, premium fintech aesthetic like Binance or "
        f"Coinbase app icon. No text, no words, no letters other than the stylised '{initial}'. "
        f"Solid background."
    )


def _rounded(im, rad: float = 0.22):
    from PIL import Image, ImageDraw
    S = im.size[0]; m = Image.new("L", (S, S), 0); d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * rad), fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0)); out.paste(im.convert("RGB"), (0, 0), m); return out


def _data_uri(im, size: int) -> str:
    from PIL import Image
    r = _rounded(im).resize((size, size), Image.LANCZOS)
    buf = io.BytesIO(); r.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def generate_for(name: str, brand_hex: str, account: str, key: str):
    """Return (favicon_data_uri, logo_data_uri) for a brand."""
    from PIL import Image
    b64 = _cf(account, key, _prompt(name, brand_hex))
    im = Image.open(io.BytesIO(base64.b64decode(b64)))
    return _data_uri(im, 64), _data_uri(im, 96)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug"); ap.add_argument("--all", action="store_true"); ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    acc, key, dburl = os.environ.get("CF_ACCOUNT_ID"), os.environ.get("CF_WORKERS_AI_KEY"), os.environ.get("DATABASE_URL")
    if not (acc and key and dburl):
        sys.exit("CF_ACCOUNT_ID, CF_WORKERS_AI_KEY and DATABASE_URL are required")
    import psycopg2
    conn = psycopg2.connect(dburl); conn.autocommit = False; cur = conn.cursor()

    if a.slug:
        cur.execute("select slug, name, color_primary, logo_url from sites where slug=%s", [a.slug])
    elif a.all:
        cur.execute("select slug, name, color_primary, logo_url from sites")
    else:
        sys.exit("pass --slug <slug> or --all")
    rows = cur.fetchall()
    for slug, name, brand_hex, logo in rows:
        if logo and not a.force:
            print(f"skip {slug} (already has assets; use --force)"); continue
        fav, lg = generate_for(name, brand_hex or "#3861FB", acc, key)
        cur.execute("update sites set favicon_url=%s, logo_url=%s, updated_at=now() where slug=%s", [fav, lg, slug])
        print(f"generated + stored assets for {slug} ({name})")
    conn.commit(); conn.close()
    print("done — live on next /site/brand fetch")


if __name__ == "__main__":
    main()
