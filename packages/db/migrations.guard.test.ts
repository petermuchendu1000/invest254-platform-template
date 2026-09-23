/**
 * migrations.guard.test.ts — static, DB-free CI guard for the PostgREST table/view surface
 * (Issue 1 / BUGLOG #42, migration 0153).
 *
 * Supabase grants anon + authenticated ALL privileges on every new public table/view, so RLS is the
 * only thing between the public anon key and the data. 0153 closed every existing gap; this guard
 * makes sure no FUTURE migration (> 0153) re-opens one:
 *   1. every `create table` in public must `enable row level security` in the same file;
 *   2. every `create [or replace] view` must set `security_invoker` (a plain CREATE OR REPLACE VIEW
 *      silently RESETS the option — verified on PG16 — so the view would bypass RLS again);
 *   3. no `grant insert/update/delete/truncate/all … to anon|authenticated` on tables.
 * A statement may opt out with the marker `-- surface-guard:allow <reason>` in the same file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
/** Migrations up to and including this number were remediated wholesale by 0153. */
export const ENFORCED_AFTER = 153;

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
const IDENT = `"?([a-z_][a-z0-9_]*)"?`;

export interface Violation { rule: string; object: string }

export function checkMigration(rawSql: string): Violation[] {
  if (/surface-guard:allow/i.test(rawSql)) return [];
  const sql = stripComments(rawSql).toLowerCase();
  const out: Violation[] = [];

  const createTable = new RegExp(`create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(?:${IDENT}\\.)?${IDENT}`, "g");
  for (const m of sql.matchAll(createTable)) {
    const [schema, name] = m[1] && m[2] ? [m[1], m[2]] : ["public", m[1] ?? m[2]];
    if (schema !== "public") continue;
    const rls = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:"?public"?\\.)?"?${name}"?\\s+enable\\s+row\\s+level\\s+security`);
    if (!rls.test(sql)) out.push({ rule: "table-without-rls", object: name });
  }

  const createView = new RegExp(`create\\s+(?:or\\s+replace\\s+)?(?:temp(?:orary)?\\s+)?view\\s+(?:${IDENT}\\.)?${IDENT}([\\s\\S]*?)\\bas\\b`, "g");
  for (const m of sql.matchAll(createView)) {
    const [schema, name] = m[1] && m[2] ? [m[1], m[2]] : ["public", m[1] ?? m[2]];
    if (schema !== "public") continue;
    const inline = /security_invoker\s*=\s*(true|on|1)/.test(m[3] ?? "");
    const later = new RegExp(`alter\\s+view\\s+(?:"?public"?\\.)?"?${name}"?\\s+set\\s*\\([^)]*security_invoker\\s*=\\s*(true|on|1)`).test(sql);
    if (!inline && !later) out.push({ rule: "view-without-security-invoker", object: name });
  }

  const grant = /grant\s+([a-z_,\s]+?)\s+on\s+([^;]*?)\bto\s+([^;]*)/g;
  for (const m of sql.matchAll(grant)) {
    const [, privs, target, grantees] = m;
    if (/^\s*(function|functions|all\s+functions|sequence|all\s+sequences|schema|routine)\b/.test(target)) continue;
    if (/\b(insert|update|delete|truncate|all)\b/.test(privs) && /\b(anon|authenticated|public)\b/.test(grantees))
      out.push({ rule: "write-grant-to-public-role", object: target.trim().replace(/^table\s+/, "") });
  }
  return out;
}

test("guard catches the three failure modes (self-test)", () => {
  assert.deepEqual(checkMigration("create table public.foo (id int);"), [{ rule: "table-without-rls", object: "foo" }]);
  assert.deepEqual(checkMigration("create table if not exists foo (id int); alter table public.foo enable row level security;"), []);
  assert.deepEqual(checkMigration("create table auth.x (id int);"), []);
  assert.deepEqual(checkMigration("create or replace view public.v_real_profiles as select 1;"),
    [{ rule: "view-without-security-invoker", object: "v_real_profiles" }]);
  assert.deepEqual(checkMigration("create or replace view v with (security_invoker = true) as select 1;"), []);
  assert.deepEqual(checkMigration("create view v as select 1; alter view public.v set (security_invoker = true);"), []);
  assert.deepEqual(checkMigration("grant select, insert on public.foo to authenticated;"), [{ rule: "write-grant-to-public-role", object: "public.foo" }]);
  assert.equal(checkMigration("grant all on all tables in schema public to anon;").length, 1);
  assert.deepEqual(checkMigration("grant usage on schema public to anon, authenticated;"), []);
  assert.deepEqual(checkMigration("grant all on schema public to anon;"), []);
  assert.deepEqual(checkMigration("grant all on sequence public.s to authenticated;"), []);
  assert.deepEqual(checkMigration("grant select on public.foo to authenticated;"), []);
  assert.deepEqual(checkMigration("grant execute on function public.f(uuid) to service_role;"), []);
  assert.deepEqual(checkMigration("-- create table public.x (a int);\nselect 1;"), [], "comments ignored");
  assert.deepEqual(checkMigration("create table public.x (a int); -- surface-guard:allow reason"), []);
});

test("0153 (the remediation) exists", () => {
  assert.ok(readdirSync(MIG_DIR).some((f) => f.startsWith("0153_")));
});

test(`every migration after ${String(ENFORCED_AFTER).padStart(4, "0")} keeps the PostgREST surface closed`, () => {
  const offenders: string[] = [];
  for (const f of readdirSync(MIG_DIR).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
    if (Number(f.slice(0, 4)) <= ENFORCED_AFTER) continue;
    for (const v of checkMigration(readFileSync(join(MIG_DIR, f), "utf8"))) offenders.push(`${f}: ${v.rule} (${v.object})`);
  }
  assert.deepEqual(offenders, [], `PostgREST surface regressions:\n${offenders.join("\n")}`);
});
