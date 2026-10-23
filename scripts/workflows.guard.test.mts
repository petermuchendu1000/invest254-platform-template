/**
 * workflows.guard.test.mts — the CI bill is a design property, so it gets a test (BUGLOG #156).
 *
 * Three invariants, each of which was violated in production and cost real money:
 *
 *  1. EVERY job declares `timeout-minutes`. A job without one inherits GitHub's 360-minute default,
 *     and three `deploy` jobs that hung until that default killed them accounted for 92% of every
 *     minute the deploy matrix has ever billed. The cap is also bounded above (<= MAX_CAP), because
 *     a 300-minute "cap" is the same unbounded hang with extra steps.
 *
 *  2. Every job that reads `secrets.DATABASE_URL` is INERT IN THE MIRROR TEMPLATE — either by its
 *     own job-level `if`, or transitively through `needs`. The template can never hold that secret,
 *     so such a job there can only install the workspace and exit (one billed runner minute per
 *     fire), or — `reproducibility.yml`, which has no skip guard — fail outright, 26 nights of 26.
 *     A job-level `if` is the only form that allocates no runner; a step that exits 0 still bills.
 *
 *  3. Every SCHEDULED job has a job-level `if`. The floor on how many scheduled workflows exist
 *     drops as ops crons move into the API process where they actually run on time — ticket
 *     escalation first, then pool health (#160) — so a falling count is progress, not rot. What
 *     the assertion protects is that whatever IS still on a schedule carries a guard. The two repositories share one byte-identical tree
 *     (docs/30), so a cron added without a guard silently runs twice as often as it reads, in a
 *     repository that usually cannot do the work.
 *
 *  4. The deploy matrix stays SERIAL. Both legs build the same root Dockerfile, so Fly gives them
 *     one remote builder and buildkit deduplicates their layers; run them together and one leg can
 *     sit in `exporting to image` forever while the other succeeds in a minute. That happened four
 *     times in sixty runs and, because the matrix is `fail-fast: false`, each time left a split
 *     release that reported success (#155, #157).
 *
 * It reads the workflow text rather than importing a YAML parser: the only one on disk is a
 * transitive hoist that no package.json declares, and a guard that disappears with a lockfile bump
 * is not a guard. The parser is therefore deliberately strict and the test asserts how much it
 * found — a checker that silently examines nothing looks exactly like a passing test (BUGLOG #152).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = join(ROOT, ".github", "workflows");
const MIRROR = "invest254-platform-template";
const PRODUCTION = "petermuchendu1000/invest254'";   // trailing quote: never matches the template
const MAX_CAP = 60;

type Job = {
  file: string; id: string; body: string;
  ifExpr: string | null; timeout: number | null; needs: string[];
};

/** Lines of a job's own block: job ids sit at 2 spaces, their keys at 4+. */
function parseJobs(file: string, text: string): Job[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const heads: { id: string; from: number }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(lines[i] ?? "");
    if (m) heads.push({ id: m[1] as string, from: i });
  }
  return heads.map((h, k) => {
    const to = k + 1 < heads.length ? (heads[k + 1] as { from: number }).from : lines.length;
    const block = lines.slice(h.from + 1, to);
    const body = block.join("\n");

    // A 4-space key, plus any deeper-indented continuation (handles `if: >-` folded over lines).
    const key = (name: string): string | null => {
      const at = block.findIndex((l) => new RegExp(`^ {4}${name}:`).test(l));
      if (at < 0) return null;
      const first = (block[at] as string).slice(`    ${name}:`.length).trim();
      const rest: string[] = [];
      for (let i = at + 1; i < block.length; i++) {
        const l = block[i] as string;
        if (l.trim() === "" || l.trim().startsWith("#")) continue;
        if (/^ {5,}/.test(l)) rest.push(l.trim()); else break;
      }
      return [first.replace(/^[>|][-+]?$/, ""), ...rest].join(" ").replace(/\s+#.*$/, "").trim();
    };

    const t = key("timeout-minutes");
    const needsRaw = key("needs");
    return {
      file, id: h.id, body,
      ifExpr: key("if"),
      timeout: t && /^\d+$/.test(t) ? Number(t) : null,   // t is comment-stripped above
      needs: needsRaw ? needsRaw.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean) : [],
    };
  });
}

const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml")).sort();
const texts = new Map(files.map((f) => [f, readFileSync(join(WF_DIR, f), "utf8")]));
const jobs = files.flatMap((f) => parseJobs(f, texts.get(f) as string));

test("the guard actually parsed the workflows (a scanner that finds nothing always passes)", () => {
  assert.ok(files.length >= 10, `expected >= 10 workflow files, found ${files.length}`);
  assert.ok(jobs.length >= 17, `expected >= 17 jobs, parsed ${jobs.length}`);
  // Spot-check two jobs whose shape differs the most: a matrix job and one with a folded `if`.
  const deploy = jobs.find((j) => j.file === "deploy.yml" && j.id === "deploy");
  assert.ok(deploy, "deploy.yml::deploy not parsed");
  assert.equal(typeof deploy?.timeout, "number");
  const drift = jobs.find((j) => j.file === "schema-drift.yml" && j.id === "schema-drift");
  assert.ok(drift?.ifExpr?.includes(MIRROR), `folded \`if\` not read: ${drift?.ifExpr}`);
});

test("every job declares a bounded timeout-minutes", () => {
  const missing = jobs.filter((j) => j.timeout === null).map((j) => `${j.file}::${j.id}`);
  assert.deepEqual(missing, [], `these jobs would inherit GitHub's 360-minute default: ${missing.join(", ")}`);
  const tooBig = jobs.filter((j) => (j.timeout as number) > MAX_CAP).map((j) => `${j.file}::${j.id}=${j.timeout}`);
  assert.deepEqual(tooBig, [], `a cap above ${MAX_CAP} min is not a cap: ${tooBig.join(", ")}`);
});

/** Inert in the mirror either by its own `if`, or because something it `needs` is. */
function inertInMirror(j: Job, all: Job[], seen = new Set<string>()): boolean {
  const k = `${j.file}::${j.id}`;
  if (seen.has(k)) return false;
  seen.add(k);
  if (j.ifExpr && (j.ifExpr.includes(MIRROR) || j.ifExpr.includes(PRODUCTION))) return true;
  return j.needs.some((n) => {
    const dep = all.find((o) => o.file === j.file && o.id === n);
    return dep ? inertInMirror(dep, all, seen) : false;
  });
}

test("every job that needs DATABASE_URL is inert in the mirror template", () => {
  const dbJobs = jobs.filter((j) => j.body.includes("secrets.DATABASE_URL"));
  assert.ok(dbJobs.length >= 6, `expected >= 6 DATABASE_URL jobs, found ${dbJobs.length}`);
  const unguarded = dbJobs.filter((j) => !inertInMirror(j, jobs)).map((j) => `${j.file}::${j.id}`);
  assert.deepEqual(unguarded, [], `would burn a runner in the mirror for nothing: ${unguarded.join(", ")}`);
});

test("every scheduled job has a job-level if, so it cannot run in both repositories unasked", () => {
  const scheduled = files.filter((f) => /^on:/m.test(texts.get(f) as string) && /^\s{2,4}schedule:/m.test(texts.get(f) as string));
  assert.ok(scheduled.length >= 6, `expected >= 6 scheduled workflows, found ${scheduled.length}`);
  const unguarded = jobs
    .filter((j) => scheduled.includes(j.file) && !j.ifExpr)
    .map((j) => `${j.file}::${j.id}`);
  assert.deepEqual(unguarded, [], `scheduled without a repository guard: ${unguarded.join(", ")}`);
});

test("CI cancels superseded PR runs but never a run on main", () => {
  const ci = texts.get("ci.yml") as string;
  const block = /^concurrency:\n((?: {2}.*\n)+)/m.exec(ci);
  assert.ok(block, "ci.yml declares no concurrency group — superseded PR runs bill in full");
  const cancel = /cancel-in-progress:\s*(.+)$/m.exec(block[1] as string)?.[1]?.trim();
  assert.ok(cancel, "ci.yml concurrency sets no cancel-in-progress");
  assert.notEqual(cancel, "true", "an unconditional cancel also kills main's run — which is the record that the deployed commit was green, and the input deploy.yml's gate reads");
  // Either phrasing is fine, "only pull_request events" or "any ref but main", but it must say one.
  assert.match(cancel as string, /pull_request|refs\/heads\/main/, `cancellation must exclude main, got: ${cancel}`);
});

test("the deploy matrix stays serial, and one app's failure still does not block the other", () => {
  const deploy = jobs.find((j) => j.file === "deploy.yml" && j.id === "deploy");
  assert.ok(deploy, "deploy.yml::deploy not parsed");
  const body = deploy?.body ?? "";

  // Both legs build the same Dockerfile on one Fly builder (BUGLOG #157). Parallel is the bug.
  assert.match(
    body,
    /^\s*max-parallel:\s*1\s*(?:#.*)?$/m,
    "deploy.yml::deploy must keep `max-parallel: 1` — both matrix legs build the same root " +
      "Dockerfile on one shared Fly builder, and running them together is what hung four of sixty " +
      "deploys in `exporting to image` while the sibling leg shipped (BUGLOG #157)",
  );

  // Serialising must not become a reason for one app's failure to skip the other's deploy.
  assert.match(
    body,
    /^\s*fail-fast:\s*false\s*(?:#.*)?$/m,
    "deploy.yml::deploy must keep `fail-fast: false` — serial legs make it MORE important that a " +
      "failed first app still lets the second be attempted, not less",
  );

  // If a third app is ever added, the two assertions above still cover it; this just proves the
  // matrix is the shape they were reasoned about, so a rewrite cannot quietly pass them.
  const apps = [...body.matchAll(/^\s*- app:\s*(\S+)\s*(?:#.*)?$/gm)].map((m) => m[1]);
  assert.ok(apps.length >= 2, `expected >= 2 matrix apps, parsed ${apps.length}: ${apps.join(", ")}`);
});
