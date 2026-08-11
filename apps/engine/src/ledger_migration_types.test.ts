import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Guardrail for a class of bug the in-memory repos CANNOT catch: a SQL migration that inserts a
 * ledger_entries row with a `type` not permitted by the CHECK constraint (which aborts the whole
 * money mutation at runtime — e.g. bulk reset-balance failing with
 * "violates check constraint ledger_entries_type_check"). We read the allowed set from the schema
 * migration (0003) as the source of truth, then assert every migration's ledger_entries insert that
 * uses a LITERAL type only uses an allowed value.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "db", "migrations");

function allowedLedgerTypes(): Set<string> {
  const schema = readFileSync(join(MIGRATIONS, "0003_wallet_ledger.sql"), "utf8");
  const m = schema.match(/type\s+text\s+not null\s+check\s*\(\s*type\s+in\s*\(([\s\S]*?)\)\s*\)/i);
  assert.ok(m, "could not locate the ledger_entries type CHECK in 0003_wallet_ledger.sql");
  const set = new Set([...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!));
  assert.ok(set.size >= 5, `expected several allowed ledger types, got ${[...set].join(",")}`);
  return set;
}

/** Extract the literal `type` value from each `insert into ledger_entries(...) values (...)`
 *  where type is the 2nd column and a quoted literal. Dynamic (non-literal) types are skipped. */
function literalLedgerInsertTypes(sql: string): string[] {
  const types: string[] = [];
  const re = /into\s+ledger_entries\s*\([^)]*\btype\b[^)]*\)\s*(?:as\s+\w+\s*)?values\s*\(\s*[^,]+,\s*'([a-z_]+)'/gi;
  for (const m of sql.matchAll(re)) types.push(m[1]!);
  return types;
}

test("every migration inserts ledger_entries with an ALLOWED type", () => {
  const allowed = allowedLedgerTypes();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  let checked = 0;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    for (const t of literalLedgerInsertTypes(sql)) {
      checked++;
      assert.ok(allowed.has(t), `migration ${f} inserts ledger_entries type '${t}' which is not in the CHECK set {${[...allowed].join(", ")}}`);
    }
  }
  assert.ok(checked > 0, "expected to find at least one literal ledger_entries insert to validate");
});

test("reset-balance migration (0042) uses an allowed ledger type", () => {
  const allowed = allowedLedgerTypes();
  const sql = readFileSync(join(MIGRATIONS, "0042_admin_reset_balance.sql"), "utf8");
  const types = literalLedgerInsertTypes(sql);
  assert.ok(types.length >= 1, "0042 should insert a ledger_entries row");
  for (const t of types) assert.ok(allowed.has(t), `0042 uses disallowed ledger type '${t}'`);
});
