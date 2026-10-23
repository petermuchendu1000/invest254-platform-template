import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, CATALOG, type Snapshot } from "./schema_drift.mts";

const empty = (): Snapshot => Object.fromEntries(Object.keys(CATALOG).map((k) => [k, {}]));

test("schema drift: identical catalogs -> no drift", () => {
  const a = empty(); a.function!["fn_x(uuid)"] = "h1"; a.policy!["wallets.sel_own"] = "p1";
  const b = empty(); b.function!["fn_x(uuid)"] = "h1"; b.policy!["wallets.sel_own"] = "p1";
  assert.deepEqual(diffSnapshots(a, b, {}), []);
});

test("schema drift: reports production-only, migrations-only and changed objects", () => {
  const prod = empty(), ref = empty();
  prod.function!["fn_old(uuid,bigint,text)"] = "h";                 // stale overload left in production
  ref.function!["fn_new(uuid)"] = "h";                              // migration never applied
  prod.policy!["wallets.sel_own"] = "no-site"; ref.policy!["wallets.sel_own"] = "with-site";   // clobbered
  prod["function-exec"]!["fn_x(uuid)"] = "true/true"; ref["function-exec"]!["fn_x(uuid)"] = "false/false";
  const items = diffSnapshots(prod, ref, {});
  assert.deepEqual(items.map((i) => `${i.change}:${i.kind}:${i.key}`).sort(), [
    "differs:function-exec:fn_x(uuid)",
    "differs:policy:wallets.sel_own",
    "only-migrations:function:fn_new(uuid)",
    "only-production:function:fn_old(uuid,bigint,text)",
  ]);
});

test("the gate compares TRIGGERS, which is what it missed for weeks (BUGLOG #161)", () => {
  // Production ran `trg_platform_pool_defaults AFTER INSERT ON platforms` with no migration behind
  // it, and this gate said nothing about the trigger. It only flagged the FUNCTION the trigger
  // calls, and only because that function happened to be production-only as well. Attach a trigger
  // out-of-band to a function the migrations ALREADY create and, before this catalog existed, the
  // gate was silent — while the table had gained a side effect on every INSERT.
  assert.ok(Object.keys(CATALOG).includes("trigger"), "a missing catalog is a blind spot, not a pass");

  const prod = empty(), ref = empty();
  prod.trigger!["platforms.trg_platform_pool_defaults"] = "h";          // added by hand in production
  ref.trigger!["platforms.trg_platform_seed_subscription"] = "h2";      // the one a migration creates
  prod.trigger!["platforms.trg_platform_seed_subscription"] = "h2";
  prod.trigger!["wallets.trg_wallet_audit"] = "before";                 // body quietly changed
  ref.trigger!["wallets.trg_wallet_audit"] = "after";
  assert.deepEqual(diffSnapshots(prod, ref, {}).map((i) => `${i.change}:${i.kind}:${i.key}`).sort(), [
    "differs:trigger:wallets.trg_wallet_audit",
    "only-production:trigger:platforms.trg_platform_pool_defaults",
  ]);
});

test("the trigger catalog ignores the constraint triggers Postgres maintains itself", () => {
  // Every foreign key carries internal RI triggers. Comparing those would make the gate red on
  // every schema that has a foreign key, which is every schema, so the query must exclude them —
  // and must also skip anything an extension owns, like the rest of the catalog does.
  assert.match(CATALOG.trigger!, /not t\.tgisinternal/);
  assert.match(CATALOG.trigger!, /deptype = 'e'/);
  // Keyed by table AND name: two tables may legitimately carry a trigger of the same name.
  assert.match(CATALOG.trigger!, /c\.relname \|\| '\.' \|\| t\.tgname/);
});

test("schema drift: justified known differences are not reported", () => {
  const prod = empty(), ref = empty();
  prod.function!["rls_auto_enable()"] = "h"; prod["function-exec"]!["rls_auto_enable()"] = "false/false";
  assert.deepEqual(diffSnapshots(prod, ref, { "function:rls_auto_enable()": "platform helper" }), []);
});

// ── the report has to be READABLE, which is why it sat red and unexplained for a week ────────────

import { mkdtempSync, readFileSync as readFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { publishReport } from "./schema_drift.mts";

/** Run publishReport with Actions' environment faked, capturing stdout and the step summary. */
function capture(items: Parameters<typeof publishReport>[0], opts: { summary?: boolean } = {}) {
  const dir = mkdtempSync(pathJoin(tmpdir(), "drift-"));
  const summaryPath = pathJoin(dir, "summary.md");
  if (opts.summary !== false) writeFileSync(summaryPath, "");
  const prevActions = process.env.GITHUB_ACTIONS, prevSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_ACTIONS = "true";
  if (opts.summary !== false) process.env.GITHUB_STEP_SUMMARY = summaryPath;
  else delete process.env.GITHUB_STEP_SUMMARY;
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  try { publishReport(items); } finally {
    console.log = log;
    if (prevActions === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevActions;
    if (prevSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = prevSummary;
  }
  return { out, summary: opts.summary === false ? "" : readFile(summaryPath, "utf8") };
}

const item = (key: string, change: "only-production" | "only-migrations" | "differs" = "differs", kind = "function") =>
  ({ kind, key, change });

test("publishReport: emits ONE annotation carrying the whole report", () => {
  const { out } = capture([item("fn_a()"), item("fn_b()", "only-production")]);
  const annotations = out.filter((l) => l.startsWith("::error"));
  // One, not one per item: GitHub shows at most ten per step, and a truncated drift report misleads.
  assert.equal(annotations.length, 1, out.join("\n"));
  assert.match(annotations[0]!, /title=Schema drift \(2\)/);
  assert.match(annotations[0]!, /fn_a\(\)/);
  assert.match(annotations[0]!, /fn_b\(\)/);
  assert.match(annotations[0]!, /function=2/, "counts by kind, so triage starts before reading the list");
});

test("publishReport: newlines are encoded, or the annotation stops after its first line", () => {
  const { out } = capture([item("fn_a()"), item("fn_b()")]);
  const ann = out.find((l) => l.startsWith("::error"))!;
  assert.ok(!ann.slice(8).includes("\n"), "a raw newline would end the workflow command");
  assert.match(ann, /%0A/, "the line breaks survive as %0A");
});

test("publishReport: a percent sign in an object name cannot corrupt the command", () => {
  const { out } = capture([item("fn_pct(text) %s")]);
  const ann = out.find((l) => l.startsWith("::error"))!;
  assert.match(ann, /%25s/, "a literal % is escaped before %0A is introduced");
});

test("publishReport: a very wide drift is summarised, never silently cut", () => {
  const many = Array.from({ length: 200 }, (_, i) => item(`fn_${i}()`));
  const { out } = capture(many);
  const ann = out.find((l) => l.startsWith("::error"))!;
  assert.match(ann, /title=Schema drift \(200\)/, "the real total is in the title");
  assert.match(ann, /and 140 more/, "and the remainder is named rather than dropped");
});

test("publishReport: the step summary is a table of every item, not a sample", () => {
  const { summary } = capture([item("fn_a()"), item("idx_b", "only-migrations", "index")]);
  assert.match(summary, /### Schema drift: 2 difference/);
  assert.match(summary, /\| differs \| function \| `fn_a\(\)` \|/);
  assert.match(summary, /\| only-migrations \| index \| `idx_b` \|/);
  assert.match(summary, /only-production.*no migration builds/s, "it says what each verdict means");
});

test("publishReport: outside Actions it stays a plain log, and never throws without a summary file", () => {
  const prev = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  try { publishReport([item("fn_a()")]); } finally { console.log = log; if (prev !== undefined) process.env.GITHUB_ACTIONS = prev; }
  assert.equal(out.filter((l) => l.startsWith("::error")).length, 0);
  assert.equal(out.length, 1, "the human-readable line is still printed");

  // In Actions but with no summary file configured: the annotation must still be emitted.
  const { out: out2 } = capture([item("fn_a()")], { summary: false });
  assert.equal(out2.filter((l) => l.startsWith("::error")).length, 1);
});

test("the report names the VALUE of a readable difference, so the fix can be written from it", () => {
  const prod: Snapshot = { column: { "profiles.display_currency": "text", "profiles.id": "uuid" } };
  const ref: Snapshot = { column: { "profiles.id": "uuid" } };
  const items = diffSnapshots(prod, ref, {});
  assert.deepEqual(items, [{ kind: "column", key: "profiles.display_currency", change: "only-production", prod: "text" }]);

  const { out, summary } = capture(items);
  const ann = out.find((l) => l.startsWith("::error"))!;
  // Without the type you cannot write the migration that adopts the column.
  assert.match(ann, /prod=text/);
  assert.match(summary, /\| only-production \| column \| `profiles\.display_currency` \| \[prod=text\] \|/);
});

test("an md5-valued difference stays unadorned — a digest in a report is noise", () => {
  const prod: Snapshot = { function: { "fn_a()": "aaaaaaaa" } };
  const ref: Snapshot = { function: { "fn_a()": "bbbbbbbb" } };
  const { out } = capture(diffSnapshots(prod, ref, {}));
  const ann = out.find((l) => l.startsWith("::error"))!;
  assert.ok(!ann.includes("aaaaaaaa") && !ann.includes("bbbbbbbb"), ann);
});
