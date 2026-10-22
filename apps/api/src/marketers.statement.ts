import qrcode from "qrcode-generator";
import { mpesaCode, formatAmount } from "./mpesa.js";
import type { MarketerLedgerRow } from "./app.marketers.js";

/**
 * The marketer wallet STATEMENT (docs/65).
 *
 * A statement is not the transaction feed with a bigger limit. The feed answers "what happened
 * lately" and is rendered as M-PESA confirmation messages; this answers "what happened between
 * these two dates, and what does it add up to", and is rendered as a document somebody is expected
 * to read for accountability.
 *
 * EVERYTHING HERE IS EAST AFRICA TIME. M-PESA stamps in EAT, mpesa.ts formats in EAT, and the app's
 * Receipts.kt formats in EAT. A statement whose period boundaries were the server's UTC midnight
 * would silently include or exclude three hours of a marketer's day at each end — and would
 * disagree with the timestamps printed in its own detail rows. EAT is UTC+3 with no daylight
 * saving, so the offset is a constant and no zone database is consulted.
 */

/** East Africa Time offset (UTC+3, no daylight saving) — the same constant mpesa.ts uses. */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** How far back one statement may reach. Bounds the aggregate scan; the app's own limit is tighter. */
export const STATEMENT_MAX_DAYS = 760;          // ~25 months, so a "2 years" request is never a near miss
/** How many detail rows one statement carries. The SUMMARY is computed over the whole range regardless. */
export const STATEMENT_DETAIL_CAP = 2000;

/** The buckets the reference statement prints, in the order it prints them. */
export const SUMMARY_ROWS = [
  "SEND MONEY",
  "RECEIVED MONEY",
  "AGENT DEPOSIT",
  "AGENT WITHDRAWAL",
  "LIPA NA M-PESA (PAYBILL)",
  "LIPA NA M-PESA (BUY GOODS)",
  "OTHERS",
] as const;

/**
 * The two rows nothing in this system can currently fill.
 *
 * The marketer app's airtime, bundle, pay-bill and buy-goods screens are LOCAL ONLY — they mutate
 * the handset's own state and never call the server (docs/65 §4), so no ledger row is ever written
 * for them and these two totals are structurally zero. They are printed because the reference
 * prints them and a statement missing two of its eight rows reads as broken. A zero here means
 * "nothing recorded", NOT "nothing spent"; wiring those flows to an RPC is what makes it mean the
 * latter.
 */
export const UNRECORDED_ROWS: ReadonlySet<string> = new Set([
  "LIPA NA M-PESA (PAYBILL)",
  "LIPA NA M-PESA (BUY GOODS)",
]);

export interface StatementSummaryRow { type: string; paidInCents: number; paidOutCents: number }

export interface StatementDetailRow {
  /** The M-PESA confirmation code — the same one the transaction feed and the receipt show. */
  code: string;
  atMs: number;
  entryType: string;
  /** The human line: who was paid, who paid, or what was adjusted. */
  details: string;
  /**
   * Always "Completed", and that is a statement about this system rather than a placeholder: the
   * ledger records settled movements only — a row exists because money moved. There is no pending,
   * reversed-in-flight or failed state to report. It is carried per-row so the printed page and
   * the in-app table cannot each hardcode a different answer if one ever appears.
   */
  status: string;
  paidInCents: number;
  withdrawnCents: number;
  balanceCents: number;
}

export interface StatementQr { size: number; bits: string }

export interface StatementDto {
  ref: string;
  customerName: string;
  /** MASKED (docs/58). The app prints its own real number from the one it signed in with. */
  mobileNumber: string;
  /** The address on file (0207), printed in the header. null when the marketer has not set one. */
  emailAddress: string | null;
  periodFrom: string;          // YYYY-MM-DD, inclusive
  periodTo: string;            // YYYY-MM-DD, inclusive
  periodLabel: string;         // "01 Jun 2026 - 15 Oct 2026"
  /** "15th October 2026" — the approval stamp's date. Server-formatted, so the printed page and
   *  the in-app page cannot each derive their own and drift (BUGLOG #147's lesson). */
  approvalDate: string;
  /** "1st Jan 2024 - 15th Oct 2026" — the stamp's restatement of the period, in ordinals. */
  periodOrdinal: string;
  generatedAtMs: number;
  summary: StatementSummaryRow[];
  totalPaidInCents: number;
  totalPaidOutCents: number;
  txnCount: number;
  detail: StatementDetailRow[];
  /** True when txnCount exceeded the detail cap: the summary is complete, the detail is not. */
  truncated: boolean;
  qr: StatementQr;
}

/** What fn_marketer_statement_summary (0206) returns. */
export interface RawStatementSummary {
  buckets: Record<string, { in: number; out: number }>;
  txn_count: number;
  paid_in_cents: number;
  paid_out_cents: number;
}

// ── Dates ─────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a YYYY-MM-DD the app sent and return the EAT day it names.
 *
 * Rejects anything that is not a real date — "2026-02-31" parses as a number triple and would
 * otherwise roll into March, quietly giving a statement a period it was never asked for.
 */
export function parseDay(s: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Round-trip through UTC to reject 31 April and 29 February in a common year.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** The instant EAT-midnight begins on that day. */
export function eatDayStartMs(day: { y: number; m: number; d: number }): number {
  return Date.UTC(day.y, day.m - 1, day.d) - EAT_OFFSET_MS;
}

/** The instant EAT-midnight begins on the day AFTER that one — the exclusive end of an inclusive range. */
export function eatDayEndExclusiveMs(day: { y: number; m: number; d: number }): number {
  return Date.UTC(day.y, day.m - 1, day.d + 1) - EAT_OFFSET_MS;
}

/** "01 Jun 2026" — the period label's form, in EAT. */
export function eatDayLabel(day: { y: number; m: number; d: number }): string {
  return `${String(day.d).padStart(2, "0")} ${MONTHS[day.m - 1]} ${day.y}`;
}

/**
 * "2026-10-14 21:24:50" — a detail row's completion time, in EAT.
 *
 * Sortable, 24-hour, seconds included: this is a column of timestamps in a table that can run to
 * hundreds of pages, where "9:03 PM" beside "10:14 AM" is unreadable and two rows a second apart
 * are indistinguishable. The receipt, which is addressed to a person, keeps its friendlier form.
 */
export function eatTimestamp(ms: number): string {
  const d = new Date(ms + EAT_OFFSET_MS);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** "15 Oct 2026, 9:03 PM" — the friendlier form, used where a date is read rather than scanned. */
export function eatStamp(ms: number): string {
  const d = new Date(ms + EAT_OFFSET_MS);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 >= 12 ? "PM" : "AM";
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` +
    `, ${h12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ampm}`;
}

/** "15th October 2026" — the seal's own date form, which is not the table's. */
export function sealDate(ms: number): string {
  const d = new Date(ms + 3 * 60 * 60 * 1000);
  const day = d.getUTCDate();
  const suffix = day >= 11 && day <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${day}${suffix} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "1st Jan 2024 - 15th Oct 2026" — the seal restates the period in the ordinal form. */
export function sealPeriod(label: string): string {
  // label is "01 Jun 2026 - 15 Oct 2026"; the seal prints the day as an ordinal without the pad.
  return label.replace(/\b(\d{2}) ([A-Z][a-z]{2})\b/g, (_m, dd: string, mon: string) => {
    const n = Number(dd);
    const suffix = n >= 11 && n <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
    return `${n}${suffix} ${mon}`;
  });
}

// ── Detail rows ───────────────────────────────────────────────────────────────────────────────────

/**
 * The "Details" line for one ledger row — the column that answers "sent to who".
 *
 * NO PHONE NUMBER APPEARS HERE, which is where this departs from a real M-PESA statement ("Customer
 * Transfer to 0798661061 - PETER MUCHENDU"). The ledger deliberately does not store a counterparty
 * number (docs/58, migration 0203), so the name is all there is — and inventing the number from the
 * request would print a number the database never recorded.
 */
export function detailsFor(r: MarketerLedgerRow, brandName: string | null): string {
  const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
  const source = typeof meta.source === "string" ? meta.source : "";
  const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim().toUpperCase() : "";
  const brand = (brandName && brandName.trim() ? brandName.trim() : "Invest254").toUpperCase();

  switch (r.entry_type) {
    case "transfer_out": return name ? `Customer Transfer to - ${name}` : "Customer Transfer";
    case "transfer_in":  return name ? `Funds received from - ${name}` : "Funds received";
    case "withdrawal": {
      const fuliza = Number(meta.fuliza_used_cents ?? 0);
      return fuliza > 0
        ? `Customer Withdrawal (Fuliza ${formatAmount(fuliza)})`
        : "Customer Withdrawal";
    }
    case "credit":
      if (source === "game_withdrawal" || source === "game_withdrawal_approved") {
        return `Funds received from - ${brand}`;
      }
      if (source === "self_service_demo") return "Demo top-up";
      return "Deposit of Funds";
    case "airtime": {
      // What was bought, and — when it was not for their own line — the masked number it went to.
      // 0207 stores only the mask, so this prints only the mask.
      const target = typeof meta.target_masked === "string" ? meta.target_masked.trim() : "";
      const self = meta.for_self !== false;
      return self || !target ? "Airtime Purchase" : `Airtime Purchase for - ${target}`;
    }
    case "adjustment": return "Balance Adjustment";
    case "reversal":   return "Reversal";
    default:           return r.entry_type.replace(/_/g, " ").toUpperCase();
  }
}

/** One ledger row as a statement line. Mirrors ledgerToTxDto's code so both name the same thing. */
export function toDetailRow(r: MarketerLedgerRow, brandName: string | null): StatementDetailRow {
  const atMs = Number.isFinite(Date.parse(r.created_at)) ? Date.parse(r.created_at) : Date.now();
  const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
  // Same pairing rule as the feed (0205): the two halves of a transfer share one code.
  const pairId = typeof meta.pair_ledger_id === "number" && Number.isSafeInteger(meta.pair_ledger_id)
    ? meta.pair_ledger_id
    : r.id;
  return {
    code: mpesaCode(atMs, pairId),
    atMs,
    entryType: r.entry_type,
    details: detailsFor(r, brandName),
    status: "Completed",
    paidInCents: Math.max(r.amount_cents, 0),
    withdrawnCents: Math.max(-r.amount_cents, 0),
    balanceCents: r.balance_after_cents,
  };
}

// ── Assembly ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The reference's eight rows, in its order, from the five the database can fill.
 *
 * Every row is emitted even at zero — including the two nothing records yet. See UNRECORDED_ROWS.
 */
export function summaryRows(raw: RawStatementSummary): StatementSummaryRow[] {
  return SUMMARY_ROWS.map((type) => {
    const b = raw.buckets?.[type];
    return { type, paidInCents: b?.in ?? 0, paidOutCents: b?.out ?? 0 };
  });
}

/** A statement's own reference code. Date-encoded like every other code this system issues. */
export function statementRef(marketerId: string, periodFrom: string, periodTo: string, generatedAtMs: number): string {
  let h = 2166136261 >>> 0;                       // FNV-1a over the identity of this request
  for (const c of `${marketerId}|${periodFrom}|${periodTo}|${generatedAtMs}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return mpesaCode(generatedAtMs, h % 2147483647);
}

/**
 * The QR the statement prints.
 *
 * It encodes the facts ON the page — reference, masked number, period, totals, transaction count —
 * so somebody scanning it reads back what they are looking at rather than a link they have to
 * trust. The marketer's number is the masked form, because the statement is a document that gets
 * forwarded and a QR is not read by the person holding it.
 *
 * Shipped as a module matrix (size + a row-major bitstring of '0'/'1'), not a PNG: the Android app
 * draws squares from it and needs no image decoding, no QR dependency of its own, and no second
 * implementation that could disagree with this one.
 */
export function statementQr(d: {
  ref: string; mobileNumber: string; periodLabel: string;
  totalPaidInCents: number; totalPaidOutCents: number; txnCount: number;
}): StatementQr {
  const payload =
    `M-PESA STATEMENT\nREF: ${d.ref}\nTEL: ${d.mobileNumber}\nPERIOD: ${d.periodLabel}\n` +
    `IN: KES ${formatAmount(d.totalPaidInCents)}\nOUT: KES ${formatAmount(d.totalPaidOutCents)}\n` +
    `TXNS: ${d.txnCount}`;
  // typeNumber 0 = size it to the payload; 'M' = ~15% recovery, the level a printed page wants.
  const q = qrcode(0, "M");
  q.addData(payload);
  q.make();
  const size = q.getModuleCount();
  let bits = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) bits += q.isDark(row, col) ? "1" : "0";
  }
  return { size, bits };
}

// ── Email delivery ────────────────────────────────────────────────────────────────────────────────

/** Deliberately conservative: a deliverable address, not every address RFC 5321 permits. */
const EMAIL_RE = /^[^\s@,;]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
export const isDeliverableEmail = (s: string): boolean => s.length <= 254 && EMAIL_RE.test(s);

/**
 * Detail rows the emailed copy carries.
 *
 * Raised to the full statement cap once the email gained a PDF attachment: the 400-row limit was
 * there because an HTML table of thousands of rows is a mail nobody opens, and a paginated document
 * has no such problem. The HTML body still shows the last 400 as a preview — see buildStatementEmail.
 */
export const STATEMENT_EMAIL_DETAIL_CAP = 400;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (cents: number): string => (cents === 0 ? "0.00" : formatAmount(cents));

/**
 * The statement as an email.
 *
 * HTML AND PLAIN TEXT, not a PDF attachment, and that is a limitation worth stating rather than
 * hiding: this system has no PDF renderer, and the EmailSender port (email.ts) carries no
 * attachments. What the marketer receives is the same figures in the same order as the in-app page,
 * readable in any client, and that is genuinely useful — it is simply not the password-protected
 * PDF the real product sends.
 *
 * EVERY VALUE IS ESCAPED. The only field here that is not the server's own arithmetic is the
 * counterparty name inside a details line, and that name reached the database from a marketer
 * registration form. An unescaped name containing markup would otherwise be rendered by the
 * recipient's mail client.
 */
export function buildStatementEmail(s: StatementDto): { subject: string; html: string; text: string } {
  const shown = s.detail.slice(-STATEMENT_EMAIL_DETAIL_CAP);
  const omitted = s.txnCount - shown.length;

  const summaryRowsHtml = s.summary.map((r) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed">${esc(r.type)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;text-align:right">${money(r.paidInCents)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;text-align:right">${money(r.paidOutCents)}</td>
      </tr>`).join("");

  const detailRowsHtml = shown.map((r) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;font-family:monospace">${esc(r.code)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed">${esc(eatTimestamp(r.atMs))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed">${esc(r.details)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed">${esc(r.status)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;text-align:right">${r.paidInCents ? money(r.paidInCents) : ""}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;text-align:right">${r.withdrawnCents ? money(r.withdrawnCents) : ""}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e8eaed;text-align:right">${money(r.balanceCents)}</td>
      </tr>`).join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8">
<div style="max-width:720px;margin:0 auto;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <h1 style="margin:0 0 18px;font-size:19px;color:#2fa84f;text-align:center;letter-spacing:.5px">M-PESA STATEMENT</h1>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:22px">
    <tr><td style="color:#2fa84f;width:150px;padding:3px 0">Customer Name:</td><td>${esc(s.customerName)}</td></tr>
    <tr><td style="color:#2fa84f;padding:3px 0">Mobile Number:</td><td>${esc(s.mobileNumber)}</td></tr>
    <tr><td style="color:#2fa84f;padding:3px 0">Statement Period:</td><td>${esc(s.periodLabel)}</td></tr>
    <tr><td style="color:#2fa84f;padding:3px 0">Request Date:</td><td>${esc(eatStamp(s.generatedAtMs))}</td></tr>
    <tr><td style="color:#2fa84f;padding:3px 0">Email Address:</td><td>${esc(s.emailAddress ?? "Not set")}</td></tr>
    <tr><td style="color:#2fa84f;padding:3px 0">Reference:</td><td style="font-family:monospace">${esc(s.ref)}</td></tr>
  </table>
  <p style="font-size:12px;color:#1a1a1a;background:#eef7f0;border:1px solid #cde6d4;border-radius:4px;padding:10px 12px">
    The full statement is attached as a PDF. What follows is a preview of it.
  </p>

  <h2 style="font-size:14px;color:#2fa84f;text-align:center;margin:0 0 8px">SUMMARY</h2>
  <table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff">
    <tr style="background:#2fa84f;color:#fff">
      <th style="padding:7px 10px;text-align:left">TRANSACTION TYPE</th>
      <th style="padding:7px 10px;text-align:right">PAID IN</th>
      <th style="padding:7px 10px;text-align:right">PAID OUT</th>
    </tr>${summaryRowsHtml}
    <tr style="font-weight:bold">
      <td style="padding:7px 10px">TOTAL</td>
      <td style="padding:7px 10px;text-align:right">${money(s.totalPaidInCents)}</td>
      <td style="padding:7px 10px;text-align:right">${money(s.totalPaidOutCents)}</td>
    </tr>
  </table>

  <h2 style="font-size:14px;color:#2fa84f;text-align:center;margin:24px 0 8px">DETAILED STATEMENT</h2>
  ${shown.length === 0 ? `<p style="font-size:12px;color:#6b6b6b;text-align:center">No transactions in this period.</p>` : `
  <table style="width:100%;border-collapse:collapse;font-size:11px;background:#fff">
    <tr style="background:#2fa84f;color:#fff">
      <th style="padding:7px 10px;text-align:left">RECEIPT NO.</th>
      <th style="padding:7px 10px;text-align:left">COMPLETION TIME</th>
      <th style="padding:7px 10px;text-align:left">DETAILS</th>
      <th style="padding:7px 10px;text-align:left">STATUS</th>
      <th style="padding:7px 10px;text-align:right">PAID IN</th>
      <th style="padding:7px 10px;text-align:right">WITHDRAWN</th>
      <th style="padding:7px 10px;text-align:right">BALANCE</th>
    </tr>${detailRowsHtml}
  </table>`}
  ${omitted > 0 ? `<p style="font-size:11px;color:#6b6b6b">Showing the most recent ${shown.length} of ${s.txnCount} transactions. The totals above cover all ${s.txnCount}.</p>` : ""}
  <p style="font-size:11px;color:#6b6b6b;margin-top:22px">
    Amounts are in KES. This statement covers the marketer wallet only.
  </p>
</div></body></html>`;

  const text = [
    "M-PESA STATEMENT",
    "The full statement is attached as a PDF. What follows is a preview of it.",
    "",
    `Customer Name: ${s.customerName}`,
    `Mobile Number: ${s.mobileNumber}`,
    `Statement Period: ${s.periodLabel}`,
    `Email Address: ${s.emailAddress ?? "Not set"}`,
    `Request Date: ${eatStamp(s.generatedAtMs)}`,
    `Reference: ${s.ref}`,
    "",
    "SUMMARY (PAID IN / PAID OUT)",
    ...s.summary.map((r) => `  ${r.type}: ${money(r.paidInCents)} / ${money(r.paidOutCents)}`),
    `  TOTAL: ${money(s.totalPaidInCents)} / ${money(s.totalPaidOutCents)}`,
    "",
    "DETAILED STATEMENT",
    ...(shown.length === 0
      ? ["  No transactions in this period."]
      : shown.map((r) => `  ${r.code}  ${eatTimestamp(r.atMs)}  ${r.details}  ${r.status}  in ${money(r.paidInCents)}  out ${money(r.withdrawnCents)}  bal ${money(r.balanceCents)}`)),
    ...(omitted > 0 ? ["", `Showing the most recent ${shown.length} of ${s.txnCount} transactions. The totals cover all ${s.txnCount}.`] : []),
  ].join("\n");

  return { subject: `M-PESA statement ${s.periodLabel} (${s.ref})`, html, text };
}
