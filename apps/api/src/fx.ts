/**
 * Foreign-exchange provider for per-brand DISPLAY currency (migration 0111 / docs/22).
 *
 * The implementation now lives in `@invest254/shared/fx` so BOTH the API and the game ENGINE resolve
 * the SAME KES→currency rate (the engine needs it for the currency-native withdrawal line that drives
 * the pool near-miss lever — docs/25 §16). This module just re-exports it to keep existing imports
 * (`./fx`) working unchanged.
 */
export { kesToCurrencyRate, primeFx } from "@invest254/shared/fx";
