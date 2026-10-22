#!/usr/bin/env python3
"""Generate `stamp-frame.png` — the distressed rounded-rect border the statement seal sits in.

WHY A RASTER AND NOT A VECTOR PATH. The border is a rubber-stamp impression: a solid band with ink
missing in thousands of small, irregular places. That is a texture, not an outline, and pdfkit draws
outlines. Expressing it as vector would mean emitting those thousands of subpaths into every page of
every statement; a 1354x818 alpha PNG drawn once per page is smaller and faster.

WHY GENERATED AND NOT TRACED. The reference artwork is Safaricom's. This draws our own band from
measurements of the reference's GEOMETRY only — 1.625% band thickness, 2.95% outer corner radius —
and roughens it with seeded noise. Nothing is copied.

DETERMINISTIC. The seed is fixed, so re-running reproduces the committed PNG byte for byte. Regenerate
with:  python3 apps/api/assets/make-stamp-frame.py

The output carries alpha only in the navy channel; `marketers.statement.pdf.ts` draws it at whatever
size the page calls for and never recolours it.
"""

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Reference proportions, measured off the sample statement's seal (677 x 409 px artwork):
#   band thickness 11px  -> 1.625% of width
#   outer corner radius  -> 2.95% of width
# Everything below is expressed as a fraction of WIDTH so the shape is resolution-independent.
W, H = 1354, 818                 # 2x the reference artwork; ample for a 130pt-wide placement at 300dpi
SS = 4                           # supersample factor for the band itself
BAND = 0.01625 * W
RADIUS = 0.0295 * W
NAVY = (43, 43, 112)             # #2B2B70, sampled from the reference
SEED = 20261015


def band_mask() -> np.ndarray:
    """A clean antialiased rounded-rect band, 0..255."""
    im = Image.new("L", (W * SS, H * SS), 0)
    d = ImageDraw.Draw(im)
    half = BAND * SS / 2
    d.rounded_rectangle(
        [half, half, W * SS - half, H * SS - half],
        radius=RADIUS * SS,
        outline=255,
        width=int(round(BAND * SS)),
    )
    return np.asarray(im.resize((W, H), Image.LANCZOS)).astype(np.float32)


def ink_mask(rng: np.random.Generator) -> np.ndarray:
    """Where the ink actually landed: 0..1, mostly 1 with irregular bald patches.

    Three scales stacked, because real stamp wear is not one grain size:
      - coarse  : whole corners and stretches of edge printing lighter
      - medium  : the characteristic flecks
      - fine    : per-pixel grain that keeps edges from looking vector-clean
    """
    def octave(scale: float, blur: float) -> np.ndarray:
        h, w = max(int(H / scale), 2), max(int(W / scale), 2)
        n = rng.random((h, w)).astype(np.float32)
        im = Image.fromarray((n * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC)
        if blur:
            im = im.filter(ImageFilter.GaussianBlur(blur))
        return np.asarray(im).astype(np.float32) / 255.0

    coarse = octave(110, 7)
    medium = octave(9, 0.9)
    fine = octave(2.5, 0.3)

    # Weighted toward the fine grain: the reference band reads as SOLID with specks lifted out of
    # it, not as a band broken into islands. An earlier mix led with the medium octave and ate
    # roughly half the ink, which looks like a photocopy rather than a stamp.
    field = 0.16 * coarse + 0.34 * medium + 0.50 * fine

    # Bias: a stamp rocks on its outer rim, so that is where ink is missing. Confined to the outer
    # ~45% of the band, because the reference's INNER edge is a clean line — erosion there would
    # blur the shape instead of ageing it.
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    edge = np.minimum.reduce([xx, yy, (W - 1) - xx, (H - 1) - yy]) / BAND   # 0 at the outer rim
    wear = np.clip(1.0 - edge / 0.45, 0.0, 1.0)                             # 1 at the rim, 0 inside

    keep = field - 0.10 * wear
    # Soft threshold rather than hard, so flecks have feathered rims instead of jaggies.
    # Offset sits well below the field's ~0.5 mean, leaving most of the band inked.
    return np.clip((keep - 0.235) / 0.085, 0.0, 1.0)


def main() -> None:
    rng = np.random.default_rng(SEED)
    alpha = band_mask() * ink_mask(rng)

    out = np.zeros((H, W, 4), dtype=np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = NAVY
    out[..., 3] = np.clip(alpha, 0, 255).astype(np.uint8)

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stamp-frame.png")
    Image.fromarray(out, "RGBA").save(path, optimize=True)
    print(f"wrote {path}  {W}x{H}  coverage={(out[..., 3] > 8).mean() * 100:.2f}%")


if __name__ == "__main__":
    main()
