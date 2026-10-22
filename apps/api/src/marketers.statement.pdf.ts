import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { formatAmount } from "./mpesa.js";
import { eatTimestamp, type StatementDto } from "./marketers.statement.js";

/**
 * The statement as a PDF — the artifact the emailed export actually carries.
 *
 * GEOMETRY IS MEASURED, NOT GUESSED. Every coordinate below was read off a reference statement with
 * `pdftotext -bbox-layout`, which reports each line's glyph box in PDF points. The page is 595x848,
 * the ruled table box runs x=36..559 and text x=38..557, and the seven detail columns fall on
 * 36 / 105.73 / 175.47 / 280.07 / 349.80 / 419.54 / 489.27 / 559 with 2pt cell padding — a split
 * that reproduces all seven measured header centres to within 0.01pt, which is how we know the
 * padding is 2 and not 0. See docs/67.
 *
 * TEXT IS PLACED BY ITS CAP TOP. The measurements are glyph-box tops, so every call goes through
 * `cap()`, which converts a cap top to a baseline using Jost's cap height of exactly 0.700em and
 * passes `baseline: "alphabetic"` so pdfkit treats the y it is given as the baseline. Positioning by
 * pdfkit's default (line-box top) would bake the font's ascender into every coordinate and drift the
 * moment a size changed.
 *
 * WHAT THIS DOCUMENT CLAIMS. It is an invest254 marketer-wallet statement and says so: the title,
 * the issue seal and the verification block carry invest254's name and a verification route that
 * actually resolves against this API. The layout is the reference's; the attestation is ours. A
 * document that asserted it was issued or verifiable by a mobile-money operator would be false —
 * these balances are invest254's own and no operator can confirm them. See docs/67 §3.
 *
 * TWO PASSES OVER THE PAGES. "Page 1 of 255" cannot be written until the last page exists, so the
 * document is built with `bufferPages`, then every page is revisited for the furniture that repeats:
 * the page number, the watermark, the disclaimer, the verification panel and the footer.
 *
 * EVERY FIGURE IS THE SERVER'S. Nothing is summed here — the summary covers rows the detail does
 * not carry (docs/65 §2), so a total recomputed from what is printed would disagree with itself the
 * moment the cap bit.
 */

// ── Assets ────────────────────────────────────────────────────────────────────────────────────────

const ASSET = (rel: string): string => fileURLToPath(new URL(`../assets/${rel}`, import.meta.url));

const STAMP_FRAME = ASSET("stamp-frame.png");

/**
 * pdfkit font handles.
 *
 * TWO FAMILIES, BECAUSE THE REFERENCE USES TWO. `pdffonts` on the reference lists an embedded
 * DejaVuSans subset and an embedded FuturaBT-Medium subset, and measuring settles which is which:
 * DejaVu Sans at 6pt reproduces "2026-10-14 21:24:50" as 63.72pt against the reference's 63.68, and
 * the same 6pt/7pt pair lands every other body and label string within ~0.3%. So the body is DejaVu
 * — which we ship — and only the display type is Futura, which we do not: Futura BT is a licensed
 * Bitstream face and is replaced by Jost (SIL OFL), a geometric sans drawn to the same proportions.
 */
const BODY = "body";            // DejaVu Sans — values, table data, disclaimer, footer
const BODY_B = "bodyB";         // DejaVu Sans Bold — the TOTAL row
const DISPLAY = "display";      // Jost Medium — title, section headings, the verification code
const DISPLAY_B = "displayB";   // Jost Bold — the seal

const FONT_FILE: Record<string, string> = {
  [BODY]: ASSET("fonts/DejaVuSans.ttf"),
  [BODY_B]: ASSET("fonts/DejaVuSans-Bold.ttf"),
  [DISPLAY]: ASSET("fonts/Jost-Medium.ttf"),
  [DISPLAY_B]: ASSET("fonts/Jost-Bold.ttf"),
};

/**
 * Baseline offset from a measured glyph-box top, as a fraction of the font size.
 *
 * The measurements are `pdftotext -bbox` tops, and that tool reports a box derived from the font
 * descriptor rather than the actual glyph extents — so the offset differs per family and cannot be
 * assumed. These two numbers were calibrated by rendering probes at known baselines and measuring
 * the ink back off the raster at 200dpi; `__cal` in the repo history is the harness. Getting this
 * wrong shifts every row by a fraction of a point, which compounds down a 40-row table.
 */
const TOP_TO_BASELINE: Record<string, number> = {
  [BODY]: 0.762,
  [BODY_B]: 0.762,
  [DISPLAY]: 0.751,
  [DISPLAY_B]: 0.751,
};

// ── Palette, sampled from the reference ───────────────────────────────────────────────────────────

const GREEN = "#43B02A";        // (67,176,42) — headings, header bands, rules, labels
const INK = "#000000";
const NAVY = "#2B2B70";         // (43,43,112) — the seal
const PANEL = "#F0F7EC";        // (240,247,236) — the verification panel's tint

// ── Page geometry ─────────────────────────────────────────────────────────────────────────────────

const PAGE_W = 595;
const PAGE_H = 848;
const RULE_L = 36;              // ruled table box
const RULE_R = 559;
const TEXT_L = 38;              // text margins (= rule box inset by the 2pt cell padding)
const TEXT_R = 557;
const RULE_W = RULE_R - RULE_L; // 523
const TEXT_W = TEXT_R - TEXT_L; // 519
const CENTRE = PAGE_W / 2;      // 297.5

const PAD = 2;                  // cell padding
const RULE_WEIGHT = 0.5;

/** Where the detail table must stop to clear the disclaimer. */
const TABLE_BOTTOM = 718;

/** Detail column boundaries. Widths: 69.73, 69.74, 104.60, 69.73, 69.74, 69.73, 69.73 (sum 523). */
const COL_X = [36, 105.73, 175.47, 280.07, 349.8, 419.54, 489.27, 559] as const;

const DETAIL_COLS: Array<{ key: string; label: string; align: "left" | "right" }> = [
  { key: "code", label: "Receipt No.", align: "left" },
  { key: "time", label: "Completion Time", align: "left" },
  { key: "details", label: "Details", align: "left" },
  { key: "status", label: "Transaction Status", align: "left" },
  { key: "in", label: "Paid In", align: "right" },
  { key: "out", label: "Withdrawn", align: "right" },
  { key: "bal", label: "Balance", align: "right" },
];

/** Summary column boundaries — the same grid: the two amount columns are 104.60 wide. */
const SUM_X = [36, 349.8, 454.4, 559] as const;

// ── Type sizes, derived from the measured cap heights ─────────────────────────────────────────────

const SZ_TITLE = 14;
const SZ_HEADING = 11;
const SZ_LABEL = 7;             // field labels, table headers, TOTAL, disclaimer, footer
const SZ_BODY = 6;              // field values, table data
const SZ_CODE = 20.9;           // the verification code (sized so its ink spans the reference's 100.8pt)

// ── Row metrics ───────────────────────────────────────────────────────────────────────────────────

const BAND_H = 11.1;            // green header band
const BAND_TEXT = 3.89;         // cap top, relative to the band's top
const ROW_H = 10;               // a single-line data row
const ROW_TEXT = 3.65;          // cap top, relative to the row's top
const LINE_H = 6;               // pitch between wrapped lines inside one cell

const money = (cents: number): string => formatAmount(cents);

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "15 Oct 2026" — the header block's date form, in EAT. */
export function requestDate(ms: number): string {
  const d = new Date(ms + 3 * 60 * 60 * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface StatementPdfOptions {
  /**
   * The marketer's own number, UNMASKED, as the reference prints it.
   *
   * Deliberately passed in rather than taken from the DTO, whose `mobileNumber` is masked for the
   * app (docs/58). This document is generated on the server and sent to the marketer's own inbox or
   * one they nominated; it is their number, and the in-app page already shows it whole. No
   * counterparty number appears anywhere, because none is stored.
   */
  mobileNumber: string;
}

type Doc = PDFKit.PDFDocument;

export function buildStatementPdf(s: StatementDto, opts: StatementPdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE_W, PAGE_H],
      margin: 0,
      bufferPages: true,
      info: {
        Title: `Marketer Wallet Statement ${s.periodLabel}`,
        Author: "invest254",
        Subject: `Statement ${s.ref}`,
        CreationDate: new Date(s.generatedAtMs),
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      for (const [name, file] of Object.entries(FONT_FILE)) doc.registerFont(name, file);

      drawTitle(doc);
      drawHeaderBand(doc, s, opts);
      drawSummary(doc, s);
      drawDetail(doc, s);
      drawPageFurniture(doc, s);
      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ── Text helper ───────────────────────────────────────────────────────────────────────────────────

interface CapOpts {
  size?: number;
  font?: string;
  color?: string;
  width?: number;
  align?: "left" | "center" | "right";
  /** Allow wrapping. Off by default: almost every string here is placed, not flowed. */
  wrap?: boolean;
  lineGap?: number;
}

/**
 * Draw `text` with its CAP TOP at `capTop`.
 *
 * Every y in this file is a cap top, because that is what `pdftotext -bbox` reports and therefore
 * what the reference was measured in. Converting here, once, keeps the call sites in the same units
 * as the measurements.
 */
function cap(doc: Doc, text: string, x: number, capTop: number, o: CapOpts = {}): void {
  const size = o.size ?? SZ_BODY;
  const font = o.font ?? BODY;
  doc.font(font).fontSize(size).fillColor(o.color ?? INK);
  // `lineGap` here is a PITCH: callers ask for the distance between wrapped lines, and pdfkit wants
  // the gap to add on top of its own line height, so the difference is taken once, here.
  const gap = o.lineGap === undefined ? undefined : o.lineGap - doc.currentLineHeight(false);
  doc.text(text, x, capTop + (TOP_TO_BASELINE[font] ?? 0.762) * size, {
    baseline: "alphabetic",
    lineBreak: o.wrap ?? false,
    ...(o.width !== undefined ? { width: o.width } : {}),
    ...(o.align !== undefined ? { align: o.align } : {}),
    ...(gap !== undefined ? { lineGap: gap } : {}),
  });
}

/** A horizontal rule in the table green. */
function rule(doc: Doc, x0: number, y: number, x1: number): void {
  doc.moveTo(x0, y).lineTo(x1, y).lineWidth(RULE_WEIGHT).strokeColor(GREEN).stroke();
}

function vrule(doc: Doc, x: number, y0: number, y1: number): void {
  doc.moveTo(x, y0).lineTo(x, y1).lineWidth(RULE_WEIGHT).strokeColor(GREEN).stroke();
}

// ── Page 1 ────────────────────────────────────────────────────────────────────────────────────────

function drawTitle(doc: Doc): void {
  // The reference titles this "M-PESA STATEMENT". This document is not one and does not say it is:
  // the balances are invest254's own simulated marketer wallet, not an operator's record.
  cap(doc, "MARKETER WALLET STATEMENT", TEXT_L, 59.37, {
    size: SZ_TITLE, font: DISPLAY, color: GREEN, width: TEXT_W, align: "center",
  });
}

function drawHeaderBand(doc: Doc, s: StatementDto, opts: StatementPdfOptions): void {
  const rows: Array<[string, string]> = [
    ["Customer Name:", s.customerName],
    ["Mobile Number:", opts.mobileNumber],
    ["Email Address:", s.emailAddress ?? "Not set"],
    ["Statement Period:", s.periodLabel],
    // When the statement was ASKED for, which is not the end of the period it covers — a statement
    // pulled in December for the year to October has an October end and a December request date.
    ["Request Date:", requestDate(s.generatedAtMs)],
  ];
  rows.forEach(([label, value], i) => {
    cap(doc, label, TEXT_L, 95.19 + 17 * i, { size: SZ_LABEL, color: GREEN });
    cap(doc, value, 194.9, 94.95 + 17 * i, { size: SZ_BODY, color: INK });
  });

  drawSeal(doc, s, 290, 91.46, 130);
  drawQr(doc, s, 457, 84, 100);
}

/**
 * The issue seal: a distressed rounded band with the issue date, the issuer and the period.
 *
 * `w` is the artwork width; the height follows the reference's 677:409 proportion. Drawn from
 * assets/stamp-frame.png (see assets/make-stamp-frame.py) plus live text, because the two date
 * lines change per statement and a flat image would freeze them.
 */
function drawSeal(doc: Doc, s: StatementDto, x: number, y: number, w: number): void {
  const h = (w * 409) / 677;
  const k = w / 677;                       // scale from reference-artwork px to points

  doc.save();
  doc.image(STAMP_FRAME, x, y, { width: w, height: h });

  const line = (text: string, top: number, size: number, color: string, font: string): void => {
    cap(doc, text, x, y + top * k, { size: size * k, font, color, width: w, align: "center" });
  };
  // Tops and sizes in reference-artwork px, scaled by k, so the seal can be drawn at any size
  // without re-deriving the stack. Each top is the ink top of the corresponding band in the
  // reference artwork, and each size is that band's measured ink height over the glyph class's
  // em fraction (0.70 for a caps/figures line, ~0.97 where the line has both an ascender and a
  // descender). Measured, not eyeballed: the first attempt used roughly half these sizes and the
  // seal read as a crowded label rather than a stamp.
  line(`Issued - ${s.approvalDate}`, 59, 35, NAVY, DISPLAY_B);
  line("INVEST254 MARKETER WALLET", 112, 20, NAVY, DISPLAY_B);
  line("Statement Period:", 150, 26, NAVY, DISPLAY);
  line(s.periodOrdinal, 196, 33, NAVY, DISPLAY);
  line("invest254.com", 240, 21, GREEN, DISPLAY);
  line("SIMULATED MARKETER FUNDS", 266, 24, NAVY, DISPLAY);
  line("Not a mobile-money statement", 303, 17.5, GREEN, DISPLAY);

  // The foot: a rule running out from the left, with the wordmark sitting on its right-hand end.
  doc.moveTo(x + 40 * k, y + 362 * k).lineTo(x + 455 * k, y + 362 * k)
    .lineWidth(Math.max(0.25, 2.5 * k)).strokeColor(GREEN).stroke();
  cap(doc, "invest254", x, y + 337 * k, {
    size: 42 * k, font: DISPLAY_B, color: GREEN, width: w - 28 * k, align: "right",
  });
  doc.restore();
}

/** The QR, drawn from the module matrix the statement already carries. */
function drawQr(doc: Doc, s: StatementDto, x: number, y: number, side: number): void {
  const n = s.qr.size;
  if (n <= 0 || s.qr.bits.length !== n * n) return;
  const quiet = 2;
  const step = side / (n + quiet * 2);
  doc.save();
  doc.rect(x, y, side, side).fillColor("#FFFFFF").fill();
  doc.fillColor("#111111");
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (s.qr.bits[row * n + col] !== "1") continue;
      // A hair over one module, so adjacent modules leave no seam at a fractional step.
      doc.rect(x + (col + quiet) * step, y + (row + quiet) * step, step + 0.25, step + 0.25).fill();
    }
  }
  doc.restore();
}

function drawSummary(doc: Doc, s: StatementDto): void {
  cap(doc, "SUMMARY", TEXT_L, 199.15, {
    size: SZ_HEADING, font: DISPLAY, color: GREEN, width: TEXT_W, align: "center",
  });

  const bandTop = 212.2;
  doc.rect(RULE_L, bandTop, RULE_W, BAND_H).fillColor(GREEN).fill();
  const headers = ["TRANSACTION TYPE", "PAID IN", "PAID OUT"];
  headers.forEach((label, i) => {
    const x0 = SUM_X[i]!;
    const x1 = SUM_X[i + 1]!;
    if (i === 0) cap(doc, label, x0 + PAD, bandTop + BAND_TEXT, { size: SZ_LABEL, color: "#FFFFFF" });
    else {
      cap(doc, label, x0, bandTop + BAND_TEXT, {
        size: SZ_LABEL, color: "#FFFFFF", width: x1 - x0, align: "center",
      });
    }
  });

  const top = bandTop + BAND_H;                       // 223.3
  const body: Array<[string, string, string, boolean]> = s.summary.map((r) => [
    `${r.type}:`, money(r.paidInCents), money(r.paidOutCents), false,
  ]);
  body.push(["TOTAL:", money(s.totalPaidInCents), money(s.totalPaidOutCents), true]);

  let y = top;
  for (const [label, paidIn, paidOut, isTotal] of body) {
    const h = isTotal ? BAND_H : ROW_H;
    const size = isTotal ? SZ_LABEL : SZ_BODY;
    const font = isTotal ? BODY_B : BODY;
    const capTop = y + (isTotal ? BAND_TEXT : ROW_TEXT);
    cap(doc, label, SUM_X[0]! + PAD, capTop, { size, font });
    [paidIn, paidOut].forEach((v, i) => {
      const x0 = SUM_X[i + 1]!;
      cap(doc, v, x0, capTop, { size, font, width: SUM_X[i + 2]! - x0, align: "center" });
    });
    y += h;
    rule(doc, RULE_L, y, RULE_R);
  }
  rule(doc, RULE_L, bandTop, RULE_R);
  for (const x of SUM_X) vrule(doc, x, bandTop, y);
}

// ── The detail table ──────────────────────────────────────────────────────────────────────────────

/** Where the detail table starts on each page: under the summary on page 1, near the top after. */
const DETAIL_TOP_FIRST = 330.8;
const DETAIL_TOP_REST = 53.8;

function drawDetail(doc: Doc, s: StatementDto): void {
  cap(doc, "DETAILED STATEMENT", TEXT_L, 317.65, {
    size: SZ_HEADING, font: DISPLAY, color: GREEN, width: TEXT_W, align: "center",
  });

  if (s.detail.length === 0) {
    cap(doc, "No transactions in this period.", TEXT_L, 345, { width: TEXT_W, align: "center" });
    return;
  }

  let bandTop = DETAIL_TOP_FIRST;
  let y = header(doc, bandTop);
  let tableTop = bandTop;

  const closePage = (): void => {
    rule(doc, RULE_L, tableTop, RULE_R);
    for (const x of COL_X) vrule(doc, x, tableTop, y);
  };

  for (const r of s.detail) {
    const values: Record<string, string> = {
      code: r.code,
      time: eatTimestamp(r.atMs),
      details: r.details,
      status: r.status,
      in: r.paidInCents > 0 ? money(r.paidInCents) : "",
      out: r.withdrawnCents > 0 ? money(r.withdrawnCents) : "",
      bal: money(r.balanceCents),
    };
    // Measured BEFORE anything is drawn: the Details column wraps, and a row half on one page and
    // half on the next is the classic table-in-a-PDF bug.
    const lines = wrapCount(doc, values.details ?? "", COL_X[3]! - COL_X[2]! - PAD * 2);
    const h = Math.max(ROW_H, 4 + LINE_H * lines);

    if (y + h > TABLE_BOTTOM) {
      closePage();
      doc.addPage();
      bandTop = DETAIL_TOP_REST;
      tableTop = bandTop;
      y = header(doc, bandTop);
    }

    DETAIL_COLS.forEach((c, i) => {
      const x0 = COL_X[i]!;
      const w = COL_X[i + 1]! - x0 - PAD * 2;
      const v = values[c.key] ?? "";
      if (c.key === "details") {
        cap(doc, v, x0 + PAD, y + ROW_TEXT, {
          width: w, wrap: true, lineGap: LINE_H,
        });
      } else if (c.align === "right") {
        cap(doc, v, x0 + PAD, y + ROW_TEXT, { width: w, align: "right" });
      } else {
        cap(doc, v, x0 + PAD, y + ROW_TEXT, { width: w });
      }
    });

    y += h;
    rule(doc, RULE_L, y, RULE_R);
  }
  closePage();

  if (s.truncated) {
    cap(
      doc,
      `Showing the most recent ${s.detail.length} of ${s.txnCount} transactions. ` +
        `The summary above covers all ${s.txnCount}.`,
      TEXT_L, Math.min(y + 4, TABLE_BOTTOM), { width: TEXT_W, align: "center" },
    );
  }
}

/** Draw the green column-header band at `bandTop`; returns the y the first row starts at. */
function header(doc: Doc, bandTop: number): number {
  doc.rect(RULE_L, bandTop, RULE_W, BAND_H).fillColor(GREEN).fill();
  DETAIL_COLS.forEach((c, i) => {
    const x0 = COL_X[i]!;
    cap(doc, c.label, x0, bandTop + BAND_TEXT, {
      size: SZ_LABEL, color: "#FFFFFF", width: COL_X[i + 1]! - x0, align: "center",
    });
  });
  const y = bandTop + BAND_H;
  rule(doc, RULE_L, y, RULE_R);
  return y;
}

/**
 * How many lines `text` wraps to in `width` at the body size.
 *
 * Asks pdfkit rather than re-implementing its line breaker. A hand-rolled word-wrap was the first
 * version and it under-counted — pdfkit breaks on more than spaces — so rows were given too little
 * height and the table drew each row over the one above it.
 */
function wrapCount(doc: Doc, text: string, width: number): number {
  if (!text) return 1;
  doc.font(BODY).fontSize(SZ_BODY);
  const gap = LINE_H - doc.currentLineHeight(false);
  return Math.max(1, Math.round(doc.heightOfString(text, { width, lineGap: gap }) / LINE_H));
}

// ── Furniture repeated on every page ──────────────────────────────────────────────────────────────

const DISCLAIMER =
  "Disclaimer: Any personal information shared with you should be handled in accordance with the " +
  "Data Protection Act and only used for the purpose for which it was provided.";

const FOOTER =
  "invest254 marketer wallet | Web: invest254.com | These are simulated marketer funds, not a " +
  "mobile-money account";

function drawPageFurniture(doc: Doc, s: StatementDto): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    cap(doc, `Page ${i + 1} of ${range.count}`, TEXT_L, 39.45, {
      size: SZ_BODY, width: TEXT_W, align: "right",
    });

    // The watermark, on every page but the first — which carries the upright seal instead.
    if (i > 0) drawWatermark(doc, s);

    cap(doc, DISCLAIMER, TEXT_L, 725.19, { size: SZ_LABEL, width: TEXT_W, wrap: true, lineGap: 10.5 });

    drawVerifyPanel(doc, s);

    cap(doc, FOOTER, TEXT_L, 820.56, {
      size: SZ_LABEL, width: TEXT_W, align: "center", wrap: true, lineGap: 7,
    });
  }
}

/**
 * The seal again, rotated 45 degrees across the middle of the page.
 *
 * 45 is not an approximation: the reference's watermark is a square raster, and a rotated rectangle
 * has a square bounding box only at 45 degrees. Measuring the extreme points of its alpha mask gives
 * 45.00 / 44.85 / 44.82 on the three edges, which is that same answer back through the rounding.
 */
function drawWatermark(doc: Doc, s: StatementDto): void {
  // 134.7 x 81.4 turned 45 degrees has a 152.75pt square bounding box — the reference's exactly.
  const w = 134.7;
  const h = (w * 409) / 677;
  doc.save();
  // Negative: pdfkit's y axis points down, so a positive angle turns clockwise and the reference
  // reads bottom-left to top-right.
  doc.rotate(-45, { origin: [CENTRE, PAGE_H / 2] });
  drawSeal(doc, s, CENTRE - w / 2, PAGE_H / 2 - h / 2, w);
  doc.restore();
}

/**
 * The verification panel.
 *
 * The reference tells the reader to dial an operator short code to confirm the statement is genuine.
 * Ours cannot be confirmed that way and does not claim to be: it points at this API's own lookup,
 * which resolves the reference printed beside it. A verification instruction that does not resolve
 * is worse than none — it borrows an assurance the document has not got.
 */
function drawVerifyPanel(doc: Doc, s: StatementDto): void {
  const top = 747;
  doc.rect(RULE_L, top, RULE_W, 68).fillColor(PANEL).fill();

  cap(doc, "Statement Verification Code", 44, 754.69, { size: SZ_LABEL });
  cap(doc, s.ref, 45, 768.07, { size: SZ_CODE, font: DISPLAY, color: GREEN });

  cap(doc,
    "To verify this statement, open invest254.com/verify and enter the code, or scan the QR on page 1.",
    230.76, 754.69,
    { size: SZ_LABEL, width: 553 - 230.76, align: "right", wrap: true, lineGap: 7 });

  doc.moveTo(45, 793.5).lineTo(418, 793.5).lineWidth(0.8).strokeColor(GREEN).stroke();
  cap(doc, "invest254", RULE_L, 782, { size: 16, font: DISPLAY_B, color: GREEN, width: 551 - RULE_L, align: "right" });
}
