import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi, SITE_A } from "./testutil.js";

/**
 * Public GET /game/config must be BRAND-AWARE (fixes the x4/x5 divergence).
 *
 * One shared API serves every brand domain, so the public config a player sees must reflect THEIR
 * brand's live site_game_config (what the engine prices from), not a global singleton. Before this,
 * /game/config always returned the legacy game_config (e.g. cap x4) while the engine used the
 * brand's site_game_config (cap x5) — players saw the wrong cap/limits.
 *
 * The test harness returns a DISTINCT economy per brand (SITE_A -> maxMultiplier 4, SITE_B -> 5,
 * configVersion 7) and falls back to the default singleton (configVersion 0, cap 5) when a ref does
 * not resolve — so these assertions pin the resolution + fallback contract.
 */

const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const get = (api: TestApi, path: string): Promise<Response> => fetch(`${api.baseUrl}${path}`);

test("GET /game/config is brand-scoped by ?site=slug", async () => {
  const api = await startTestApi();
  try {
    const a = await json(await get(api, "/api/v1/game/config?site=invest254"));
    const b = await json(await get(api, "/api/v1/game/config?site=brandb"));
    assert.equal(a.maxMultiplier, 4, "brand A (invest254) gets its own cap");
    assert.equal(b.maxMultiplier, 5, "brand B gets its own cap");
    assert.equal(a.configVersion, 7, "served from the brand's site_game_config, not the singleton");
    assert.equal(b.configVersion, 7);
    assert.notEqual(a.maxMultiplier, b.maxMultiplier, "the two brands are genuinely distinct");
  } finally { await api.close(); }
});

test("GET /game/config resolves a brand by its site id too", async () => {
  const api = await startTestApi();
  try {
    const a = await json(await get(api, `/api/v1/game/config?site=${SITE_A}`));
    assert.equal(a.maxMultiplier, 4);
    assert.equal(a.configVersion, 7);
  } finally { await api.close(); }
});

test("GET /game/config falls back to the default config when unresolved", async () => {
  const api = await startTestApi();
  try {
    const none = await json(await get(api, "/api/v1/game/config"));            // no ref
    const bad = await json(await get(api, "/api/v1/game/config?site=nope404")); // unknown ref
    // Fallback source is deps.config() (DEFAULT_CONFIG): configVersion 0, cap 5.
    assert.equal(none.configVersion, 0, "no ref -> singleton fallback");
    assert.equal(bad.configVersion, 0, "unknown brand -> singleton fallback (never hard-fails)");
    assert.equal(none.maxMultiplier, 5);
  } finally { await api.close(); }
});
