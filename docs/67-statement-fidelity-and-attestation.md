# 67 — Statement fidelity, and what the document is allowed to claim

**Status:** implemented · **Date:** 2026-10-15
**Supersedes nothing. Amends:** `65` §3 (layout), migration `0208` (ordering — see §4).

A reference M-PESA statement (10 pages of a real 255-page export) was supplied as the artifact to
reproduce, with the instruction that the result match it *"pixel by pixel"*. This records what was
measured off it, what was reproduced, and the one class of thing that was deliberately not.

---

## 1. The layout is measured, not estimated — VERIFIED

Every coordinate in `apps/api/src/marketers.statement.pdf.ts` comes from `pdftotext -bbox-layout`
run on the reference, which reports each text line's box in PDF points.

| Property | Value | How it was established |
|---|---|---|
| Page size | 595 × 848 pt | `pdfinfo`. Not A4 (595.28 × 841.89) — the export is 6pt taller. |
| Ruled table box | x 36 → 559 | The first green pixel of a table rule, at 200dpi. |
| Text margins | x 38 → 557 | Every measured line's left edge; = the box inset by 2pt padding. |
| Detail columns | 36 / 105.73 / 175.47 / 280.07 / 349.80 / 419.54 / 489.27 / 559 | See below. |
| Summary columns | 36 / 349.80 / 454.40 / 559 | Amount columns are 104.60 wide, same grid. |
| Header band | 11.1pt tall, text cap top +3.89 | Green fill extent at 200dpi. |
| Detail row | 10pt single-line; +6pt per wrapped line | Consecutive row tops: 345.45 → 367.45 for a 3-line row. |
| Brand green | `#43B02A` | Sampled (67,176,42). |
| Seal navy | `#2B2B70` | Sampled (43,43,112). |
| Verification panel | `#F0F7EC`, y 747, h 68 | Sampled (240,247,236). |

**The column split is confirmed, not assumed.** The seven header labels are centred in their cells.
Solving the boundaries from the measured header centres gives two candidate answers depending on the
assumed cell padding; **padding = 2pt** reproduces all seven measured centres to within 0.01pt
(70.87, 140.60, 227.77, 314.94, 384.67, 454.41, 524.14) and padding = 0 misses every one by exactly
2pt. The widths that fall out — 69.73, 69.74, 104.60, 69.73, 69.74, 69.73, 69.73 — sum to 523.0,
the ruled box exactly. That agreement across nine independent numbers is what makes this measured
rather than fitted.

## 2. Typography — VERIFIED, with one substitution

`pdffonts` reports two embedded faces on the reference: a **DejaVuSans** subset and a
**FuturaBT-Medium** subset. Measuring settles which does what:

- **Body, labels, table text: DejaVu Sans at 6pt and 7pt.** At 6pt it renders
  `2026-10-14 21:24:50` as 63.72pt against the reference's measured 63.68, and the same 6/7pt pair
  lands every other body and label string within ~0.3%. We ship DejaVu (`assets/fonts/`, Bitstream
  Vera / Arev licences, redistributable — `DEJAVU-LICENSE.txt`).
- **Display — title, section headings, verification code: Futura BT.** Futura BT is a licensed
  Bitstream face and is **not** vendored. It is replaced by **Jost** (SIL OFL, `OFL.txt`), a
  geometric sans drawn to Futura's proportions, including its 0.700em cap height. Jost runs wider
  than Futura, so the verification code is set at 20.9pt rather than the reference's 24pt, chosen so
  its ink spans the reference's measured 100.8pt.

**A trap worth recording.** `pdftotext -bbox` reports a box derived from the *font descriptor*, not
from the glyph extents, and the derivation differs per family — the reference's DejaVu subset
reports a box of 0.998 × size where our full DejaVu reports 1.164 × size. Comparing those numbers
across two documents is meaningless. The baseline offsets in `TOP_TO_BASELINE` were therefore
calibrated against **rendered ink at 200dpi**, and the result is exact: every DejaVu anchor on page 1
(labels, values, summary rows, TOTAL, column headers, first detail row, verification label, footer)
lands within **0.00pt** of the reference.

## 3. What the document does NOT claim — DECIDED

The reference carries two attestation devices: a rubber-stamp seal reading
*"Approved — SAFARICOM CUSTOMER CARE"*, and a panel instructing the reader to
*"dial \*334# to verify the validity of this M-PESA statement"*. It is titled *M-PESA STATEMENT*.

**Decision: reproduce the form, re-author the attestation.** Our document is titled
*MARKETER WALLET STATEMENT*; the seal reads *"Issued — &lt;date&gt; / INVEST254 MARKETER WALLET"*
and carries *SIMULATED MARKETER FUNDS* and *"Not a mobile-money statement"*; the panel points at
`invest254.com/verify`, which resolves the statement reference printed beside it.

**Why.** These balances are invest254's own simulated marketer wallet. No operator issued this
document and none can confirm it. A verification instruction that does not resolve is worse than no
verification instruction, because it borrows an assurance the document has not got — and a statement
of mobile-money throughput is a standard instrument in loan, rental and investment-pitch fraud,
which is a sharper risk on an investment platform than elsewhere. The forgery risk is not in the
grid or the colour; it is in the sentence that tells a reader a third party will vouch for this.

**Rejected: reproducing the seal and verification block verbatim.** It is what was asked for, and it
is the one part that converts an internal accountability report into a document that passes as an
operator's. Everything that makes the report *useful* — the layout, the buckets, the running
balance, the per-row detail — is unaffected by this decision.

**Rejected: dropping the seal entirely.** The seal is also a legitimate issuance mark: it says when
the document was produced and for what period, which is exactly what an accountability artifact
should carry. Only the issuer's name was wrong.

**Trade-off accepted.** The document is no longer a pixel match in three places — the title, the
seal's text, the verification sentence — and a reader expecting a visual clone will see the
difference immediately. That is the intent. `marketers.statement.pdf.test.ts` has a test that fails
if any operator-attribution string reappears.

The *geometry* of the seal is reproduced exactly: 130 × 78.54pt upright at (290, 91.46) on page 1,
and a 134.7pt-wide copy turned **45°** and centred on every later page. 45 is not an approximation —
the reference's watermark is a square raster, and a rotated rectangle has a square bounding box only
at 45°; measuring the extreme points of its alpha mask returns 45.00 / 44.85 / 44.82 on the three
edges. The distressed border is generated, not traced: `assets/make-stamp-frame.py` draws a band at
the reference's measured proportions (1.625% of width thick, 2.95% corner radius) and erodes it with
seeded noise. It is deterministic, so the committed PNG is reproducible.

## 4. Ordering reversed — AMENDS migration 0208

`0208` (BUGLOG #149) fixed the ordering *column* — `created_at`, which the statement prints, not
`id`, which it does not — and chose **ascending**, reasoning that a reader follows the Balance
column downward as a running total.

**That is reversed by `0209`.** The reference runs **descending**: its first page opens on
`2026-10-14 21:24:50` and walks backwards. The 0208 reasoning was sound and still wrong, because it
was reasoning where an artifact was available. A statement is read to answer *"what happened
lately?"*, and on a 255-page export the ascending order puts today's transactions on the last page.

The column fix from 0208 stands and is the load-bearing part; only the direction changed. The cap
still selects the **newest** `p_cap` rows — reversing those two steps would silently return the
*oldest*, which is why the migration and the in-memory mirror both do it in two explicit steps.

## 5. Also corrected

- Summary label `LIPA NA M-PESA (PAY BILL)` → **`(PAYBILL)`**, one word, as the reference prints it.
  Changed in `marketers.statement.ts`, both test suites, the `0206` comment and the Kotlin viewer.
- The **disclaimer**, **verification panel** and **footer** repeat on *every* page in the reference,
  not only the last; they now do here. The detail table stops at y 718 to clear them.
- The column header band repeats at the top of every continuation page (band top 53.8 vs 330.8 on
  page 1), which the reference also does.

## 6. Still unreproduced — ASSUMED

- `invest254.com/verify` is written on the document but **the route is not built yet**. The QR
  already encodes the statement's identity. Until that endpoint exists the instruction is accurate
  about *where* to verify and premature about *when* — this is the one claim on the page that is
  currently ahead of the code, and it should be closed next.
- The reference's footer is a raster strip (2018×177 px at 523 × 45.87pt); ours is live text.
