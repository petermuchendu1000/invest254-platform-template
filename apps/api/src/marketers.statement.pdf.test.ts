import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { buildStatementPdf, requestDate } from "./marketers.statement.pdf.js";
import { sealDate, sealPeriod, statementQr, type StatementDto, type StatementDetailRow } from "./marketers.statement.js";

/**
 * The emailed statement, as a PDF.
 *
 * Asserted against the REAL artifact rather than a build with compression turned off: pdfkit
 * deflates its content streams, so the text is recovered by inflating them here. A test seam that
 * produced an uncompressed document would be testing a file nobody receives.
 */

interface PdfObj { dict: string; stream?: Buffer }

/** Index every `N 0 obj`, skipping past stream bodies so binary data cannot be mistaken for one. */
function parseObjects(pdf: Buffer): Map<number, PdfObj> {
  const raw = pdf.toString("latin1");
  const out = new Map<number, PdfObj>();
  const re = /(\d+) 0 obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const sIdx = raw.indexOf("stream", start);
    const eIdx = raw.indexOf("endobj", start);
    if (sIdx !== -1 && (eIdx === -1 || sIdx < eIdx)) {
      const from = raw[sIdx + 6] === "\r" ? sIdx + 8 : sIdx + 7;
      const to = raw.indexOf("endstream", from);
      out.set(Number(m[1]), { dict: raw.slice(start, sIdx), stream: Buffer.from(raw.slice(from, to), "latin1") });
      re.lastIndex = to;
    } else {
      out.set(Number(m[1]), { dict: raw.slice(start, eIdx === -1 ? undefined : eIdx) });
    }
  }
  return out;
}

/**
 * `<0041>` -> "A". A destination may hold SEVERAL code units, and a CMap may space them out —
 * `<0066 0066>` is the "ff" ligature — so the whitespace is stripped before pairing off the digits.
 */
const utf16be = (hex: string): string => {
  const h = hex.replace(/\s+/g, "");
  let s = "";
  for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  return s;
};

/** A font's CID -> text mapping, read from the `/ToUnicode` CMap pdfkit embeds beside each subset. */
function toUnicode(stream: Buffer): Map<number, string> {
  const map = new Map<number, string>();
  let txt: string;
  try { txt = inflateSync(stream).toString("latin1"); } catch { txt = stream.toString("latin1"); }
  for (const block of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) {
      map.set(parseInt(p[1]!, 16), utf16be(p[2]!));
    }
  }
  // ONE pass, consuming each entry in order. Two independent regexes — array form, then contiguous
  // form — look equivalent and are not: the contiguous pattern `<a> <b> <c>` also matches any three
  // consecutive destinations INSIDE an array, so it overwrote real mappings with garbage derived
  // from its neighbours. The symptom was a document that decoded almost perfectly, with "*" coming
  // out as "v" and "verify" as "Kerify" — close enough to look like an encoding quirk rather than a
  // parser bug.
  for (const block of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const entry = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:\[([\s\S]*?)\]|<([0-9a-fA-F]+)>)/g;
    let p: RegExpExecArray | null;
    while ((p = entry.exec(block[1]!)) !== null) {
      const lo = parseInt(p[1]!, 16);
      if (p[3] !== undefined) {
        // `<lo> <hi> [<u0> <u1> ...]` — one destination per CID. This is what pdfkit writes for a
        // subset, whose glyph order has nothing to do with codepoint order.
        let c = lo;
        // NOTE the \s in the class: a ligature destination is written `<0066 0066>`, and a class
        // without it skips that entry entirely — which does not lose one glyph, it shifts every
        // mapping after it by one and quietly rewrites the rest of the document.
        for (const d of p[3].matchAll(/<([0-9a-fA-F\s]*)>/g)) map.set(c++, utf16be(d[1]!));
      } else {
        const hi = parseInt(p[2]!, 16), dst = parseInt(p[4]!, 16);
        for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(dst + (c - lo)));
      }
    }
  }
  return map;
}

/**
 * The visible text of the document.
 *
 * Asserted against the REAL artifact rather than a build with compression turned off: pdfkit
 * deflates its content streams, so the text is recovered by inflating them here. A test seam that
 * produced an uncompressed document would be testing a file nobody receives.
 *
 * THE BYTES ARE GLYPH IDS, NOT CHARACTERS. The document embeds subsets of DejaVu Sans and Jost with
 * Identity-H encoding, so `<0024 0048>` is a pair of 16-bit glyph indices into one font's subset,
 * and the same index means a different letter in the other font. An earlier version of this helper
 * decoded the hex as latin1 — which was right while the document used the standard-14 fonts and
 * silently returned mojibake the moment it did not. So: track `/Fn <size> Tf` to know which font is
 * live, and map each CID through that font's own `/ToUnicode` CMap.
 */
function pdfText(pdf: Buffer): string {
  const objs = parseObjects(pdf);

  const cmaps = new Map<number, Map<number, string>>();
  for (const [num, o] of objs) {
    const tu = /\/ToUnicode (\d+) 0 R/.exec(o.dict);
    const s = tu && objs.get(Number(tu[1]))?.stream;
    if (s) cmaps.set(num, toUnicode(s));
  }

  let out = "";
  for (const o of objs.values()) {
    if (!/\/Type\s*\/Page[^s]/.test(o.dict)) continue;

    // `/Resources` is an indirect reference, not an inline dict — pdfkit shares one resource object
    // across the pages that use the same fonts, so the font names must be read from THERE.
    const rr = /\/Resources (\d+) 0 R/.exec(o.dict);
    const res = rr ? objs.get(Number(rr[1]))?.dict ?? o.dict : o.dict;

    const fonts = new Map<string, Map<number, string>>();
    const fd = /\/Font\s*<<([^>]*)>>/.exec(res);
    if (fd) {
      for (const p of fd[1]!.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
        const cm = cmaps.get(Number(p[2]));
        if (cm) fonts.set(p[1]!, cm);
      }
    }

    const nums: number[] = [];
    const cm = /\/Contents\s+(?:\[([^\]]*)\]|(\d+)\s+0\s+R)/.exec(o.dict);
    if (cm?.[1]) for (const r of cm[1].matchAll(/(\d+)\s+0\s+R/g)) nums.push(Number(r[1]));
    else if (cm?.[2]) nums.push(Number(cm[2]));

    let live: Map<number, string> | undefined;
    for (const n of nums) {
      const st = objs.get(n)?.stream;
      if (!st) continue;
      let content: string;
      try { content = inflateSync(st).toString("latin1"); } catch { continue; }
      const tok = /\/(\w+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g;
      let t: RegExpExecArray | null;
      while ((t = tok.exec(content)) !== null) {
        if (t[1] !== undefined) { live = fonts.get(t[1]); continue; }
        const runs = t[2] !== undefined
          ? [...t[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]!)
          : [t[3]!];
        let word = "";
        for (const hex of runs) {
          for (let i = 0; i + 4 <= hex.length; i += 4) {
            word += live?.get(parseInt(hex.slice(i, i + 4), 16)) ?? "";
          }
        }
        out += `${word}\n`;
      }
    }
  }
  return out;
}

/**
 * The document's text with line breaks flattened, for strings the layout may WRAP.
 *
 * A cell that wraps is drawn as one text run per line, so "Customer Transfer to - PETER MUCHENDU"
 * legitimately arrives as three runs. Matching the wrapped form would make the assertion a test of
 * the column width rather than of the content.
 */
const flat = (t: string): string => t.replace(/\s+/g, " ");

const pageCount = (pdf: Buffer): number => (pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;

function row(i: number, over: Partial<StatementDetailRow> = {}): StatementDetailRow {
  return {
    code: `UJEJ0AN${String(i).padStart(3, "0")}`,
    atMs: Date.parse("2026-10-14T18:24:50Z") - i * 3_600_000,
    entryType: "transfer_out",
    details: "Customer Transfer to - PETER MUCHENDU",
    status: "Completed",
    paidInCents: 0,
    withdrawnCents: 500,
    balanceCents: 100_000 - i * 100,
    ...over,
  };
}

const PERIOD = "01 Jan 2024 - 15 Oct 2026";
function dto(over: Partial<StatementDto> = {}): StatementDto {
  const base: StatementDto = {
    ref: "UJEJ0ANPDS",
    customerName: "Faith Mwende Mutiso",
    mobileNumber: "0748****157",
    emailAddress: "faithmwende40130@gmail.com",
    periodFrom: "2024-01-01",
    periodTo: "2026-10-15",
    periodLabel: PERIOD,
    approvalDate: sealDate(Date.parse("2026-10-15T06:00:00Z")),
    periodOrdinal: sealPeriod(PERIOD),
    generatedAtMs: Date.parse("2026-10-15T06:00:00Z"),
    summary: [
      { type: "SEND MONEY", paidInCents: 0, paidOutCents: 224_042_700 },
      { type: "RECEIVED MONEY", paidInCents: 93_124_595, paidOutCents: 0 },
      { type: "AGENT DEPOSIT", paidInCents: 668_000, paidOutCents: 0 },
      { type: "AGENT WITHDRAWAL", paidInCents: 0, paidOutCents: 8_557_100 },
      { type: "LIPA NA M-PESA (PAYBILL)", paidInCents: 2_562_500, paidOutCents: 16_237_813 },
      { type: "LIPA NA M-PESA (BUY GOODS)", paidInCents: 4_585_539, paidOutCents: 13_341_800 },
      { type: "OTHERS", paidInCents: 197_401_675, paidOutCents: 36_974_200 },
    ],
    totalPaidInCents: 299_174_471,
    totalPaidOutCents: 299_153_613,
    txnCount: 3,
    detail: [row(0), row(1), row(2)],
    truncated: false,
    qr: statementQr({
      ref: "UJEJ0ANPDS", mobileNumber: "0748****157", periodLabel: PERIOD,
      totalPaidInCents: 299_174_471, totalPaidOutCents: 299_153_613, txnCount: 3,
    }),
    ...over,
  };
  return base;
}
const OPTS = { mobileNumber: "0748057157" };

test("it is a PDF, and a well-formed one", async () => {
  const pdf = await buildStatementPdf(dto(), OPTS);
  assert.ok(pdf.length > 3_000, `suspiciously small: ${pdf.length} bytes`);
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.toString("latin1").trimEnd().endsWith("%%EOF"));
  // The page tree's own count must agree with the pages actually written.
  const declared = Number(/\/Count (\d+)/.exec(pdf.toString("latin1"))?.[1] ?? -1);
  assert.equal(declared, pageCount(pdf));
});

test("the header band prints every field the reference prints", async () => {
  const text = pdfText(await buildStatementPdf(dto(), OPTS));
  assert.match(text, /MARKETER WALLET STATEMENT/);
  assert.match(text, /Customer Name:/);
  assert.match(text, /Faith Mwende Mutiso/);
  assert.match(text, /Mobile Number:/);
  assert.match(text, /Email Address:/);
  assert.match(text, /faithmwende40130@gmail\.com/);
  assert.match(text, /Statement Period:/);
  assert.match(text, /01 Jan 2024 - 15 Oct 2026/);
  // In the period's own form, not ISO: it sits directly under "01 Jan 2024 - 15 Oct 2026", and two
  // date formats in one four-row block is a mistake a reader has to stop and resolve.
  assert.match(text, /Request Date:/);
  assert.match(text, /15 Oct 2026/);
});

test("the request date is the day the statement was asked for, in EAT", () => {
  assert.equal(requestDate(Date.parse("2026-10-15T06:00:00Z")), "15 Oct 2026");
  assert.equal(requestDate(Date.parse("2026-01-02T00:00:00Z")), "02 Jan 2026");
  // 22:30 UTC is already tomorrow in Nairobi, like every other date on the page.
  assert.equal(requestDate(Date.parse("2026-10-15T22:30:00Z")), "16 Oct 2026");
});

test("the mobile number is the one PASSED IN, not the masked one on the DTO", async () => {
  // The DTO's copy is masked for the app (docs/58). This document is generated on the server and
  // addressed to the marketer, so it prints their own number whole — as the reference does.
  const text = pdfText(await buildStatementPdf(dto(), OPTS));
  assert.match(text, /0748057157/);
  assert.ok(!text.includes("0748****157"), "the masked copy was printed instead of the real one");
});

test("an unset email says so rather than printing an empty row", async () => {
  const text = pdfText(await buildStatementPdf(dto({ emailAddress: null }), OPTS));
  assert.match(text, /Email Address:/);
  assert.match(text, /Not set/);
});

test("the issue seal carries its own ordinal dates", async () => {
  const text = pdfText(await buildStatementPdf(dto(), OPTS));
  assert.match(text, /Issued - 15th October 2026/);
  assert.match(text, /INVEST254 MARKETER WALLET/);
  assert.match(text, /1st Jan 2024 - 15th Oct 2026/);
  assert.match(text, /invest254\.com/);
  assert.match(text, /SIMULATED MARKETER FUNDS/);
});

test("the document does not present itself as an operator's statement", async () => {
  // The layout is copied from an M-PESA statement; the ATTESTATION is not, and must not drift back.
  // These balances are invest254's own simulated marketer wallet, and no operator can confirm them,
  // so a seal, a verification route or a footer carrying an operator's name would be a false claim
  // about who issued the document and who stands behind it. See docs/67 §3.
  const text = pdfText(await buildStatementPdf(dto(), OPTS));
  for (const claim of [/SAFARICOM/i, /M-PESA STATEMENT/, /\*334#/, /safaricom\.co\.ke/i, /Approved -/]) {
    assert.ok(!claim.test(text), `the document claims ${claim} — see docs/67 §3`);
  }
  assert.match(text, /invest254\.com\/verify/);
  assert.match(text, /simulated marketer funds/i);
});

test("the summary prints all eight rows with a colon, and the totals", async () => {
  const text = pdfText(await buildStatementPdf(dto(), OPTS));
  assert.match(text, /SUMMARY/);
  for (const t of ["SEND MONEY:", "RECEIVED MONEY:", "AGENT DEPOSIT:", "AGENT WITHDRAWAL:",
                   "LIPA NA M-PESA \\(PAYBILL\\):", "LIPA NA M-PESA \\(BUY GOODS\\):", "OTHERS:", "TOTAL:"]) {
    assert.match(text, new RegExp(t), `missing summary row ${t}`);
  }
  // The figures themselves, grouped as the reference groups them.
  assert.match(text, /2,240,427\.00/);
  assert.match(text, /2,991,744\.71/);
  assert.match(text, /2,991,536\.13/);
});

test("the detail table has the reference's seven columns, Transaction Status included", async () => {
  const text = pdfText(await buildStatementPdf(dto(), OPTS));
  assert.match(text, /DETAILED STATEMENT/);
  for (const h of ["Receipt No.", "Completion Time", "Details", "Transaction Status", "Paid In", "Withdrawn", "Balance"]) {
    assert.match(text, new RegExp(h.replace(/\./g, "\\.")), `missing column ${h}`);
  }
  assert.match(text, /UJEJ0AN000/);
  assert.match(flat(text), /Customer Transfer to - PETER MUCHENDU/);
  assert.match(text, /Completed/);
  // Sortable 24-hour timestamps, not the receipt's friendlier "9:24 PM" form.
  assert.match(text, /2026-10-14 21:24:50/);
});

test("a long period paginates, and every page says which of how many it is", async () => {
  const many = Array.from({ length: 300 }, (_, i) => row(i));
  const pdf = await buildStatementPdf(dto({ detail: many, txnCount: 300 }), OPTS);
  const pages = pageCount(pdf);
  assert.ok(pages > 5, `expected several pages, got ${pages}`);

  const text = pdfText(pdf);
  // "Page N of M" on every page, with the SAME M — the whole reason for the second pass.
  for (let i = 1; i <= pages; i++) {
    assert.match(text, new RegExp(`Page ${i} of ${pages}`), `page ${i} is not stamped`);
  }
  assert.ok(!text.includes(`of ${pages + 1}`), "a page claims a total that does not exist");
  // The column headers repeat on every page, or the later ones are unreadable.
  assert.equal((text.match(/Receipt No\./g) ?? []).length, pages);
});

test("a wrapping row is given the height it needs, so it cannot be drawn over the next one", async () => {
  // The first version of this test only checked that every receipt number appeared once, which a
  // FIXED row height also satisfies — the text simply overdraws the row below it. What a fixed
  // height cannot do is change the page count, so that is what this asserts.
  const short = Array.from({ length: 120 }, (_, i) => row(i, { details: "Airtime Purchase" }));
  const long = Array.from({ length: 120 }, (_, i) => row(i, {
    details: "Funds received from - ROSELINE KIBURI AND A DELIBERATELY LONG COUNTERPARTY NAME THAT WRAPS ONTO SEVERAL LINES",
  }));
  const shortPages = pageCount(await buildStatementPdf(dto({ detail: short, txnCount: 120 }), OPTS));
  const longPdf = await buildStatementPdf(dto({ detail: long, txnCount: 120 }), OPTS);
  const longPages = pageCount(longPdf);
  assert.ok(
    longPages > shortPages,
    `wrapping rows took ${longPages} pages and single-line rows took ${shortPages} — the row height is not being measured`,
  );

  const text = pdfText(longPdf);
  // THE PRECISE SIGNATURE. If a row is not measured before it is drawn, pdfkit reaches the bottom
  // mid-row and adds a page BY ITSELF — a page this code never knew about and so never gave column
  // headers to. One header per page means every break was this code's own, taken between rows.
  assert.equal(
    (text.match(/Receipt No\./g) ?? []).length, longPages,
    "a page of the detail table has no column headers, so the table broke mid-row",
  );

  // …and still exactly once each, so nothing is drawn twice at the break.
  for (let i = 0; i < 120; i++) {
    const code = `UJEJ0AN${String(i).padStart(3, "0")}`;
    assert.equal((text.match(new RegExp(code, "g")) ?? []).length, 1, `${code} is not printed exactly once`);
  }
});

test("an empty period produces a statement that says so, not a blank table", async () => {
  const text = pdfText(await buildStatementPdf(dto({ detail: [], txnCount: 0, truncated: false }), OPTS));
  assert.match(text, /No transactions in this period\./);
  assert.match(text, /SUMMARY/);          // the summary is still printed, all zeros
  assert.match(text, /TOTAL:/);
});

test("a truncated statement says what the detail is short of", async () => {
  const text = pdfText(await buildStatementPdf(dto({ txnCount: 4_000, truncated: true }), OPTS));
  assert.match(text, /Showing the most recent 3 of 4000 transactions/);
  assert.match(text, /summary above covers all 4000/);
});

test("the document's own metadata names the statement", async () => {
  const raw = (await buildStatementPdf(dto(), OPTS)).toString("latin1");
  assert.match(raw, /Marketer Wallet Statement 01 Jan 2024 - 15 Oct 2026/);
  assert.match(raw, /Statement UJEJ0ANPDS/);
});

test("ordinal dates: the teens are the trap", () => {
  const at = (iso: string): number => Date.parse(iso);
  assert.equal(sealDate(at("2026-10-15T06:00:00Z")), "15th October 2026");
  assert.equal(sealDate(at("2026-10-01T06:00:00Z")), "1st October 2026");
  assert.equal(sealDate(at("2026-10-02T06:00:00Z")), "2nd October 2026");
  assert.equal(sealDate(at("2026-10-03T06:00:00Z")), "3rd October 2026");
  assert.equal(sealDate(at("2026-10-11T06:00:00Z")), "11th October 2026");
  assert.equal(sealDate(at("2026-10-12T06:00:00Z")), "12th October 2026");
  assert.equal(sealDate(at("2026-10-13T06:00:00Z")), "13th October 2026");
  assert.equal(sealDate(at("2026-10-21T06:00:00Z")), "21st October 2026");
  // EAT, like everything else on the page: 22:30 UTC is already tomorrow in Nairobi.
  assert.equal(sealDate(at("2026-10-15T22:30:00Z")), "16th October 2026");
});

test("the seal restates the period in ordinals, and leaves everything else alone", () => {
  assert.equal(sealPeriod("01 Jan 2024 - 15 Oct 2026"), "1st Jan 2024 - 15th Oct 2026");
  assert.equal(sealPeriod("02 Feb 2026 - 03 Mar 2026"), "2nd Feb 2026 - 3rd Mar 2026");
  assert.equal(sealPeriod("11 Jun 2026 - 12 Jun 2026"), "11th Jun 2026 - 12th Jun 2026");
  assert.equal(sealPeriod("21 Dec 2025 - 22 Dec 2025"), "21st Dec 2025 - 22nd Dec 2025");
});
