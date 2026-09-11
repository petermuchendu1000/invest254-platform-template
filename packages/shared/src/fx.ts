/**
 * Foreign-exchange provider for per-brand DISPLAY currency (migration 0111 / docs/22).
 *
 * The money of record is ALWAYS integer KES cents. A brand whose `sites.currency` is not 'KES'
 * merely RENDERS those KES amounts in its display currency at the live rate this module resolves
 * (units of the display currency per 1 KES). Nothing here moves or stores money.
 *
 * Source: exchangerate-api's free, no-key endpoint (USD-based table, ~166 currencies, refreshed
 * daily upstream). We cache the whole table in-process and refresh at most every TTL. The provider
 * is fail-safe: on any fetch failure it serves the last-good table, then a small embedded fallback,
 * and finally returns 0 for an unknown currency — which makes the web degrade to plain KES rather
 * than ever converting at a wrong/implicit rate.
 */

const SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — display FX only; upstream updates ~daily
const FETCH_TIMEOUT_MS = 8_000;

/** Embedded last-resort USD-base rates (approx; only used if the network is unreachable at boot). */
const FALLBACK_USD_TABLE: Readonly<Record<string, number>> = {
  USD: 1, KES: 129, NGN: 1550, UGX: 3700, TZS: 2650, GHS: 15, ZAR: 18, EUR: 0.92, GBP: 0.79,
};

interface FxState { table: Record<string, number>; fetchedAt: number; }
let state: FxState | null = null;
let inflight: Promise<void> | null = null;

async function fetchTable(): Promise<Record<string, number>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
    const j = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (j?.result !== "success" || !j.rates || typeof j.rates.KES !== "number") throw new Error("FX payload invalid");
    return j.rates;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureFresh(): Promise<void> {
  if (state && Date.now() - state.fetchedAt <= TTL_MS) return;
  if (!inflight) {
    inflight = (async () => {
      try {
        const table = await fetchTable();
        state = { table, fetchedAt: Date.now() };
      } catch (err) {
        console.warn(`[fx] refresh failed (${(err as Error)?.message ?? "error"}); using ${state ? "last-good" : "fallback"} rates`);
        if (!state) state = { table: { ...FALLBACK_USD_TABLE }, fetchedAt: Date.now() };
      } finally {
        inflight = null;
      }
    })();
  }
  await inflight;
}

/**
 * Resolve the KES→currency rate (display-currency units per 1 KES). Returns 1 for KES, and 0 for a
 * currency we cannot price (caller should then render KES). Never throws.
 */
export async function kesToCurrencyRate(currency: string | null | undefined): Promise<number> {
  const cur = (currency ?? "KES").trim().toUpperCase();
  if (cur === "" || cur === "KES") return 1;
  try {
    await ensureFresh();
  } catch { /* ensureFresh already swallows; belt-and-braces */ }
  const table = state?.table ?? FALLBACK_USD_TABLE;
  const kes = table.KES;
  const tgt = table[cur];
  if (typeof kes === "number" && kes > 0 && typeof tgt === "number" && tgt > 0) return tgt / kes;
  const fk = FALLBACK_USD_TABLE.KES;
  const ft = FALLBACK_USD_TABLE[cur];
  if (typeof fk === "number" && fk > 0 && typeof ft === "number" && ft > 0) return ft / fk;
  return 0; // unknown currency -> web falls back to KES
}

/** Warm the cache at server boot (fire-and-forget); safe to call repeatedly. */
export function primeFx(): void { void ensureFresh(); }
