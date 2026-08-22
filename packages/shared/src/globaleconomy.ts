/**
 * Platform GLOBAL ECONOMY overrides (migration 0099) — the data contract + pure resolution helpers
 * shared by the engine (enforcement), the API (validation/marshalling) and the web console (editing
 * + live feasibility preview). Dependency-light: only money + config.
 *
 * MODEL (decided with the operator):
 *  - HARD ENFORCE per field: every field is { v:number, on:boolean }. Only on=true is enforced across
 *    ALL clients; on=false / absent leaves each brand on its own value.
 *  - SEPARATE player vs marketer game economies on the statistical (pool-OFF) path. Cohort field keys
 *    are IDENTICAL to GameConfig keys, so applying an enforced cohort over a base config is a plain
 *    per-field override.
 *  - GLOBAL WINS: an enforced global field beats site_game_config AND per-user user_overrides.
 *
 * Cross-field feasibility (RTP/winRate ∈ (1, maxMultiplier]) is checked here via `checkFeasible` over
 * the MERGED config (console preview + engine fail-safe), never on a cohort block in isolation — a
 * partially-enforced cohort composes with each brand's own base.
 */
import type { Cents } from "./money.js";
import { checkFeasible, type ConfigFeasibility, type GameConfig } from "./config.js";

/** One enforce-able global field: a value plus whether it is enforced platform-wide. */
export interface EconField {
  v: number;
  on: boolean;
}

/** Cohort (player/marketer) game-economy keys — a subset of GameConfig applied per-cohort at open. */
export type CohortKey =
  | "houseEdge"
  | "targetWinRate"
  | "maxMultiplier"
  | "minStakeCents"
  | "maxStakeCents"
  | "defaultDurationS";

/** Platform payment keys. `minDepositCents` was a hardcoded constant before 0099. */
export type PaymentKey = "minDepositCents" | "maxDepositCents" | "minWithdrawalCents";

export type CohortEconomy = Partial<Record<CohortKey, EconField>>;
export type PaymentsEconomy = Partial<Record<PaymentKey, EconField>>;

export interface PlatformEconomy {
  player: CohortEconomy;
  marketer: CohortEconomy;
  payments: PaymentsEconomy;
}

export const EMPTY_PLATFORM_ECONOMY: PlatformEconomy = { player: {}, marketer: {}, payments: {} };

export const COHORT_KEYS: readonly CohortKey[] = [
  "houseEdge", "targetWinRate", "maxMultiplier", "minStakeCents", "maxStakeCents", "defaultDurationS",
] as const;

export const PAYMENT_KEYS: readonly PaymentKey[] = [
  "minDepositCents", "maxDepositCents", "minWithdrawalCents",
] as const;

/** UI + validation metadata (single source of truth for the console field renderer). */
export interface EconFieldSpec {
  key: string;
  label: string;
  /** How the value is entered/displayed: pct (0..1 shown as %), kes (cents<->KES), x (multiplier), int. */
  kind: "pct" | "kes" | "x" | "int";
  hint: string;
  min?: number;
  max?: number;
  integer?: boolean;
}

export const COHORT_FIELD_SPECS: Record<CohortKey, EconFieldSpec> = {
  houseEdge:        { key: "houseEdge",        label: "House edge",        kind: "pct", hint: "RTP = 1 − house edge", min: 0,      max: 0.9999 },
  targetWinRate:    { key: "targetWinRate",    label: "Target win rate",   kind: "pct", hint: "Fraction of positions that win", min: 0.0001, max: 1 },
  maxMultiplier:    { key: "maxMultiplier",    label: "Max multiplier",    kind: "x",   hint: "Payout cap (e.g. ×5)", min: 1.0001 },
  minStakeCents:    { key: "minStakeCents",    label: "Min stake",         kind: "kes", hint: "Smallest allowed stake", min: 1, integer: true },
  maxStakeCents:    { key: "maxStakeCents",    label: "Max stake",         kind: "kes", hint: "Largest allowed stake", min: 1, integer: true },
  defaultDurationS: { key: "defaultDurationS", label: "Trade duration (s)",kind: "int", hint: "Auto-sell window in seconds", min: 1, max: 3600, integer: true },
};

export const PAYMENT_FIELD_SPECS: Record<PaymentKey, EconFieldSpec> = {
  minDepositCents:    { key: "minDepositCents",    label: "Min deposit",    kind: "kes", hint: "Smallest M-Pesa deposit accepted", min: 1, integer: true },
  maxDepositCents:    { key: "maxDepositCents",    label: "Max deposit",    kind: "kes", hint: "Largest single M-Pesa deposit (blank = none)", min: 1, integer: true },
  minWithdrawalCents: { key: "minWithdrawalCents", label: "Min withdrawal", kind: "kes", hint: "Smallest withdrawal accepted", min: 1, integer: true },
};

// ── defensive parsing (never throws; ignores malformed data — fail-open like the rest of the gate) ──

function parseField(x: unknown): EconField | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const v = Number(o.v);
  if (!Number.isFinite(v)) return undefined;
  return { v, on: o.on === true };
}

function parseBlock<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, EconField>> {
  const out: Partial<Record<K, EconField>> = {};
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const k of keys) {
    const f = parseField(o[k]);
    if (f) out[k] = f;
  }
  return out;
}

export function parseCohort(raw: unknown): CohortEconomy {
  return parseBlock<CohortKey>(raw, COHORT_KEYS);
}
export function parsePayments(raw: unknown): PaymentsEconomy {
  return parseBlock<PaymentKey>(raw, PAYMENT_KEYS);
}

/** Parse the three jsonb blocks off a platform_global_config row (snake_case) into typed economy. */
export function parsePlatformEconomy(
  row: { player_economy?: unknown; marketer_economy?: unknown; payments?: unknown } | null | undefined,
): PlatformEconomy {
  if (!row) return EMPTY_PLATFORM_ECONOMY;
  return {
    player: parseCohort(row.player_economy),
    marketer: parseCohort(row.marketer_economy),
    payments: parsePayments(row.payments),
  };
}

// ── resolution helpers (pure) ──────────────────────────────────────────────────────────────────

/** The enforced numeric value for a field, or null when not enforced / absent. */
export function enforcedValue(block: CohortEconomy | PaymentsEconomy, key: string): number | null {
  const f = (block as Record<string, EconField | undefined>)[key];
  return f && f.on ? f.v : null;
}

/** Only the enforced cohort fields, as GameConfig-shaped overrides (keys match GameConfig 1:1). */
export function enforcedCohortValues(cohort: CohortEconomy): Partial<Record<CohortKey, number>> {
  const out: Partial<Record<CohortKey, number>> = {};
  for (const k of COHORT_KEYS) {
    const v = enforcedValue(cohort, k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** Apply enforced cohort fields over a base GameConfig (used for feasibility preview). */
export function applyCohortEconomy(base: GameConfig, cohort: CohortEconomy): GameConfig {
  return { ...base, ...enforcedCohortValues(cohort) } as GameConfig;
}

/** Feasibility of a base config once a cohort's enforced fields are applied. */
export function cohortFeasibility(base: GameConfig, cohort: CohortEconomy): ConfigFeasibility {
  return checkFeasible(applyCohortEconomy(base, cohort));
}

/** Effective min deposit: enforced global value wins, else the caller's base. */
export function effectiveMinDeposit(base: Cents, p: PaymentsEconomy): Cents {
  const g = enforcedValue(p, "minDepositCents");
  return g !== null && Number.isInteger(g) && g > 0 ? g : base;
}
/** Effective max deposit: enforced global value, else the caller's base (null = no cap). */
export function effectiveMaxDeposit(base: Cents | null, p: PaymentsEconomy): Cents | null {
  const g = enforcedValue(p, "maxDepositCents");
  return g !== null && Number.isInteger(g) && g > 0 ? g : base;
}
/** Effective min withdrawal: enforced global value wins, else the caller's base. */
export function effectiveMinWithdrawal(base: Cents, p: PaymentsEconomy): Cents {
  const g = enforcedValue(p, "minWithdrawalCents");
  return g !== null && Number.isInteger(g) && g > 0 ? g : base;
}
