import { Router, ApiError, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";
import type { BrandActivityItem, LeaderboardMetric, LeaderboardPeriod } from "./activity.pg.js";
import { seededSocialProofAllowed } from "@invest254/shared";

const BASE = "/api/v1";
/** The feed is a glance, not a ledger: a screenful, and never enough to mine. */
const MAX = 40;
const DEFAULT = 25;
/** The board is a top ten by default, and never more of one than the feed is of a feed. */
const TOP_DEFAULT = 10;

/**
 * `GET /site/activity?host=<host|slug>` (public) — what has actually been happening on this brand.
 *
 * The candlestick screen's Live Chat shows these between players' messages. Every row describes a
 * real event: a deposit that settled, a withdrawal that was paid, a trade that won. The page this
 * screen was copied from generates its equivalent (its own rows come back typed `system_simulated`,
 * naming withdrawals nobody made), and that is the one thing from the mock not reproduced — a feed
 * of invented winnings above a deposit button is a lie told to the person about to deposit.
 *
 * PUBLIC on purpose, like `/site/brand` beside it: the screen shows it before login, which is when
 * it matters most. That is also why the DTO is as thin as it is — a first name, an amount and a
 * coarse age, with no id, receipt or wall-clock time. See `activity.pg.ts` for the privacy rules the
 * query itself enforces.
 */
export function registerActivityRoutes(router: Router, deps: ApiDeps): void {
  router.get(`${BASE}/site/activity`, async (ctx: Ctx) => {
    if (!deps.brandActivity) return { items: [] as BrandActivityItem[] };

    const host = ctx.query.get("host")?.trim().toLowerCase();
    if (!host) throw new ApiError("VALIDATION", "host query parameter is required", 400);
    const brand = await deps.brandByHost(host);
    if (!brand) throw new ApiError("SITE_NOT_FOUND", "no active brand for this host", 404);

    const raw = Number.parseInt(ctx.query.get("limit") ?? "", 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX) : DEFAULT;

    /**
     * THE SEEDED-ROW GATE, decided here because this is where the brand is: seeded social proof may
     * appear on the candlestick trade UI and on the ordinary classic screen, and never on the digits
     * screen or the broker terminal. The predicate is shared with the web app's screen rule
     * (shared/chart.ts) rather than restated, and the brand DTO already carries both columns it
     * needs (`chartStyle`, `tradeUi` — server.ts maps them), so this costs no second DB read.
     *
     * It is enforced on the SERVER on purpose: a client cannot ask for seeded rows its brand is not
     * meant to have by sending a different host, a flag, or nothing at all.
     */
    const seededAllowed = seededSocialProofAllowed(brand.tradeUi, brand.chartStyle);

    return { items: await deps.brandActivity.recent(brand.siteId, limit, { seededAllowed }) };
  });

  /**
   * `GET /site/leaderboard?host=&period=today|yesterday|week|month&metric=winnings|profit` (public)
   * — the Top tab.
   *
   * Ranked by TOTAL WINNINGS over the window, which is the product decision; `metric=profit` still
   * asks for the net ranking this board used to be, and the response echoes which it gave. Ranking
   * by winnings does put whoever staked most near the top whether or not they are up, which is why
   * the net metric is kept rather than removed — see the note on the query.
   *
   * An unknown period or metric is read as the default rather than refused: both reach this from a
   * chip, and a bad chip should show a board, not an error.
   */
  router.get(`${BASE}/site/leaderboard`, async (ctx: Ctx) => {
    if (!deps.brandActivity) return { items: [] };

    const host = ctx.query.get("host")?.trim().toLowerCase();
    if (!host) throw new ApiError("VALIDATION", "host query parameter is required", 400);
    const brand = await deps.brandByHost(host);
    if (!brand) throw new ApiError("SITE_NOT_FOUND", "no active brand for this host", 404);

    /**
     * BOTH AXES ARE VALIDATED HERE, AGAINST A CLOSED SET OF LITERALS, and that is not a formality:
     * `period` and `metric` are each used to look up a SQL fragment that is string-interpolated into
     * the board query (WINDOW_AT / METRIC_SQL in activity.pg.ts). What reaches the SQL is therefore
     * always one of that file's own literals and never a byte of request text. Any axis added to
     * this route must be narrowed the same way, in this shape — a ternary over literals, falling
     * back to a default — and must never be passed through as a string.
     */
    const raw = (ctx.query.get("period") ?? "today").toLowerCase();
    const period: LeaderboardPeriod =
      raw === "yesterday" || raw === "week" || raw === "month" ? raw : "today";

    const rawMetric = (ctx.query.get("metric") ?? "winnings").toLowerCase();
    const metric: LeaderboardMetric = rawMetric === "profit" ? "profit" : "winnings";

    const rawLimit = Number.parseInt(ctx.query.get("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX) : TOP_DEFAULT;

    // Same gate as the feed, same reason, same predicate — see the note above.
    const seededAllowed = seededSocialProofAllowed(brand.tradeUi, brand.chartStyle);

    return {
      period,
      metric,
      items: await deps.brandActivity.leaderboard(brand.siteId, period, limit, { metric, seededAllowed }),
    };
  });
}
