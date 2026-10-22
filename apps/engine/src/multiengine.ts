import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import {
  type Direction, instrumentById, isKnownInstrument, isTimeframe, symbolDef,
  type DigitKind, type MultDir,
} from "@invest254/shared";
import { isPendingKind } from "@invest254/shared/pending";
import type { SiteRegistry } from "./siteregistry.js";
import { MAX_ANCHORS } from "./markethistory.js";
import type { SymbolHistories } from "./symbolhistories.js";
import { MarketNews } from "./marketnews.js";
import type { GameRepository } from "./wallet.js";
import type { Verifier } from "./auth.js";

/**
 * Multiplexed WebSocket engine.
 *
 * One process, many brands. Each socket is bound to a brand AT CONNECT (resolved from the URL /
 * host by `resolveSite`) so the public tick stream can start immediately, and its JWT `site`
 * claim is verified to MATCH that brand on `auth` (a token minted for Brand A cannot drive Brand
 * B). Fan-out is per-site (ticks/online) and per-(site,user) (balance/position events), so no
 * frame ever crosses brands.
 *
 * The heavy lifting stays in the reused GameServer/SeedManager via SiteRegistry; this module is
 * only transport + routing, which is why it can be started standalone in tests.
 */
export interface MultiEngineOptions {
  port: number;
  host?: string;
  registry: SiteRegistry;
  repo: GameRepository;
  verifier: Verifier | null;
  /**
   * Resolve the brand id for a new connection (from `?site=` / host). May be async so the engine
   * can resolve a brand ONBOARDED AFTER boot via a live lookup (GAP 2). Return the site_id, or
   * throw/reject to reject the connection.
   */
  resolveSite: (req: IncomingMessage) => string | Promise<string>;
  onlineFloor?: number;
  /** Dev/test only: ensure a just-authenticated user has a wallet/balance (in-memory seeding). */
  devSeedBalance?: (siteId: string, userId: string) => Promise<void> | void;
  onError?: (err: Error, ctx: string) => void;
  /** Platform master switch (migration 0092): when it returns false, new positions are refused
   * platform-wide. Omitted in dev/tests => play always allowed. In-flight positions are unaffected. */
  playAllowed?: () => boolean | Promise<boolean>;
  /** docs/42 UI-5: the brands of a platform, so a PLATFORM ADMIN's live console feed carries only its own
   *  platform's online counts and deposits. Omitted => platform admins are refused the live feed. */
  sitesOfPlatform?: (platformId: string) => Promise<string[]>;
  /** Newswire for the News tab. Injectable so tests never reach the network. */
  news?: MarketNews;
}

export interface MultiEngineHandle {
  wss: WebSocketServer;
  close(): Promise<void>;
  /** Fan a confirmed deposit out to connected platform_superadmin sockets (docs/24 live feed). */
  emitPlatformDeposit(dep: unknown): void;
}

export async function startMultiEngine(opts: MultiEngineOptions): Promise<MultiEngineHandle> {
  const perSiteSockets = new Map<string, Set<WebSocket>>();
  const perSiteUser = new Map<string, Map<string, Set<WebSocket>>>();
  const siteOf = new WeakMap<WebSocket, string>();
  const userOf = new WeakMap<WebSocket, string>();
  const roleOf = new WeakMap<WebSocket, string>();   // docs/25: role governs pool exemption (marketers)
  const wired = new Set<string>(); // sites whose GameServer fan-out is already subscribed
  const report = (e: Error, c: string) => (opts.onError ? opts.onError(e, c) : console.error(`[engine] ${c}:`, e.message));

  const send = (ws: WebSocket, type: string, data: unknown) =>
    ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type, data, ts: Date.now() }));
  const toSite = (siteId: string, type: string, data: unknown) => perSiteSockets.get(siteId)?.forEach((ws) => send(ws, type, data));
  const toSiteUser = (siteId: string, userId: string, type: string, data: unknown) =>
    perSiteUser.get(siteId)?.get(userId)?.forEach((ws) => send(ws, type, data));
  const onlineCount = (siteId: string) => Math.max(perSiteSockets.get(siteId)?.size ?? 0, opts.onlineFloor ?? 0);

  /**
   * How many symbols one socket may watch at once.
   *
   * MetaTrader's Market Watch holds a list this size in practice, and the cap is not arbitrary: it
   * must stay BELOW a brand's resident-history cap, or every watched symbol would be evicted and
   * rebuilt on every tick and none of them would ever be warm enough to quote. The assertion below
   * is in the test suite rather than here, but the dependency is the reason this number exists.
   */
  const MAX_WATCHED_SYMBOLS = 20;

  /**
   * Which symbols each socket is watching, and the last rate it was sent for each.
   *
   * A real Map rather than a WeakMap because the tick loop iterates it; the close handler deletes
   * the entry, which is also what stops a closed socket's symbols being kept resident.
   */
  const watched = new Map<WebSocket, { symbols: string[]; last: Map<string, number> }>();

  /**
   * One message per socket per tick carrying every symbol it watches.
   *
   * Per socket rather than per symbol because two clients rarely watch the same list, and a message
   * per symbol per tick would be twenty messages a tick for one Market Watch. Per TICK rather than
   * on its own timer so a symbol's quote cannot drift out of step with the brand's own `tick`: for
   * the default symbol the two are the same number, and a client showing both would otherwise see
   * them disagree.
   *
   * A symbol whose chain is not warm yet is skipped rather than quoted. Its rate is available (that
   * only needs today's curve) but its ANCHOR is not, and a rate without the anchor it belongs to
   * cannot be turned into a price — so sending it would be a number the client could only misplot.
   */
  function fanOutQuotes(siteId: string, rt: { histories?: SymbolHistories }, tMs: number): void {
    const sockets = perSiteSockets.get(siteId);
    if (!sockets || !rt.histories) return;
    for (const ws of sockets) {
      const sub = watched.get(ws);
      if (!sub || sub.symbols.length === 0) continue;
      const quotes: Array<{ symbol: string; rate: number; delta: number; high: number; low: number }> = [];
      for (const symbol of sub.symbols) {
        const h = rt.histories.for(symbol);
        if (!h || !h.warmed) continue;
        const tick = h.liveTick(tMs, sub.last.get(symbol));
        sub.last.set(symbol, tick.rate);
        /**
         * The day's range rides the quote, because MetaTrader's phone Quotes row prints `L:` and
         * `H:` under the Bid and the Ask and the engine is the only side that can know them. The
         * alternative was a phone fetching a day of bars for each of twenty watched symbols to
         * print two numbers each.
         *
         * It is a PRICE, not a rate: the two extremes are mapped through the day's anchor here,
         * where that anchor lives, rather than being sent as raw curve values for every client to
         * map again against an anchor it may not have yet.
         *
         * The call extends a walk the history keeps rather than rebuilding it, so this costs the
         * seconds since the last tick per symbol, not a day's.
         */
        const range = h.dayRange(tMs);
        quotes.push({ symbol, rate: tick.rate, delta: tick.delta, high: range.high, low: range.low });
      }
      if (quotes.length > 0) send(ws, "symbol_ticks", { t: tMs, quotes });
    }
  }

  // ── Phase 2: per-(site, instrument) authoritative DIGIT feed streamer ─────────────────────────
  // Each distinct instrument a brand is using runs ONE deterministic ticker at the instrument's
  // cadence. It fans the authoritative tick (quote + provably-fair last digit) out to the sockets
  // watching it, and settles every open digit contract whose settleIndex has arrived (so settlement
  // is driven even if the opener has since navigated away). A streamer auto-stops when it has no
  // watchers AND no open digit contracts, so idle instruments cost nothing.
  interface InstStreamer { timer: ReturnType<typeof setInterval>; subs: Set<WebSocket>; busy: boolean; }
  const instStreamers = new Map<string, Map<string, InstStreamer>>();
  const subInstrument = new WeakMap<WebSocket, string>(); // the one instrument a socket is watching
  const streamersFor = (siteId: string) => instStreamers.get(siteId) ?? instStreamers.set(siteId, new Map()).get(siteId)!;

  async function ensureStreamer(siteId: string, instrumentId: string): Promise<InstStreamer> {
    const m = streamersFor(siteId);
    const existing = m.get(instrumentId);
    if (existing) return existing;
    const rt = await ensureSite(siteId);
    const inst = instrumentById(instrumentId);
    const entry: InstStreamer = { subs: new Set(), busy: false, timer: undefined as unknown as ReturnType<typeof setInterval> };
    const tick = async () => {
      if (entry.busy) return;
      entry.busy = true;
      try {
        let data;
        try { data = rt.game.instrumentTick(instrumentId); } catch { return; } // NO_SEED (dev without seed)
        // Settle due contracts FIRST so a pool-decided digit can override the owner's tick frame at
        // this index (docs/25 applied to digits: the curve/stream is cosmetic; the decision rules).
        const settled = await rt.game.settleDueDigits(instrumentId, data.index);
        const overrideByUser = new Map<string, number>();
        for (const s of settled) overrideByUser.set(s.userId, s.digit);
        const t = data.dayStartMs + data.index * data.tickMs;
        entry.subs.forEach((ws) => {
          const u = userOf.get(ws);
          const d = u !== undefined ? overrideByUser.get(u) : undefined;
          if (d !== undefined && d !== data.digit) {
            const scaled = Math.round(data.quote * 100);
            const quote = (scaled - (((scaled % 10) + 10) % 10) + d) / 100;
            send(ws, "inst_tick", { instrumentId, index: data.index, quote, digit: d, t });
          } else {
            send(ws, "inst_tick", { instrumentId, index: data.index, quote: data.quote, digit: data.digit, t });
          }
        });
        for (const s of settled) {
          toSiteUser(siteId, s.userId, "digit_settled", { positionId: s.positionId, instrumentId, index: data.index, digit: s.digit, won: s.won, payoutCents: s.payoutCents, pnlCents: s.pnlCents, balance: s.balance });
          void opts.repo.getWalletSnapshot(s.userId)
            .then((snap) => toSiteUser(siteId, s.userId, "balance", { real: snap.real, bonus: snap.bonus, currency: snap.currency }))
            .catch(() => { /* client also invalidates ['wallet'] on settle */ });
        }
        // ── Multipliers: live P/L updates + auto-close (TP/SL/stop-out/DC or pool endpoint) ─────
        const mult = await rt.game.tickMultipliers(instrumentId, data.index);
        for (const u of mult.updates) {
          toSiteUser(siteId, u.userId, "mult_update", { positionId: u.positionId, instrumentId, index: data.index, pnlCents: u.pnlCents });
        }
        for (const cl of mult.closed) {
          toSiteUser(siteId, cl.userId, "mult_closed", { positionId: cl.positionId, instrumentId, reason: cl.reason, pnlCents: cl.pnlCents, payoutCents: cl.payoutCents, balance: cl.balance });
          void opts.repo.getWalletSnapshot(cl.userId)
            .then((snap) => toSiteUser(siteId, cl.userId, "balance", { real: snap.real, bonus: snap.bonus, currency: snap.currency }))
            .catch(() => { /* non-fatal */ });
        }
        if (entry.subs.size === 0 && !rt.game.openDigitInstruments().has(instrumentId) && !rt.game.openMultiplierInstruments().has(instrumentId)) {
          clearInterval(entry.timer);
          m.delete(instrumentId);
        }
      } catch (err) { report(err as Error, `${siteId}:inst ${instrumentId}`); }
      finally { entry.busy = false; }
    };
    entry.timer = setInterval(() => { void tick(); }, inst.tickMs);
    (entry.timer as { unref?: () => void }).unref?.();
    m.set(instrumentId, entry);
    return entry;
  }

  /**
   * Everything this user currently has running, in the one shape both callers send.
   *
   * Two callers: the auth reply, so a refreshed tab picks its position back up, and `sync_positions`,
   * so a client whose acknowledgement was lost can ask rather than guess. One builder, so the two
   * can never drift into reporting different things about the same position.
   */
  function openPositionsPayload(rt: Awaited<ReturnType<typeof ensureSite>>, userId: string) {
    return {
      positions: rt.game.openPositionsOf(userId).map((p) => ({
        positionId: p.id,
        // MetaTrader's ticket (0184). A refreshed tab gets the trade back under the SAME number it
        // was showing before, which is the whole point of a ticket.
        ticket: p.ticket,
        direction: p.direction,
        stakeCents: p.stakeCents,
        durationS: p.durationS,
        openedAtMs: p.openedAtMs,
        expiresAtMs: p.expiresAtMs,
        // The protective levels the ENGINE is holding. A refreshed tab gets back the stop it set
        // rather than an empty ticket, because the engine never lost it.
        slPrice: p.slPrice,
        tpPrice: p.tpPrice,
        entryRate: p.outcome.entryRate,
        sellable: p.sellable,
      })),
    };
  }

  /** Backfill the last `n` authoritative ticks so a freshly subscribed chart is full immediately. */
  function sendInstHistory(ws: WebSocket, rt: Awaited<ReturnType<typeof ensureSite>>, instrumentId: string, n = 120) {
    const cur = rt.game.instrumentTick(instrumentId);
    const end = cur.index;
    const start = Math.max(0, end - n + 1);
    const ticks: Array<{ index: number; quote: number; digit: number; t: number }> = [];
    for (let i = start; i <= end; i++) {
      const d = rt.game.instrumentTick(instrumentId, i);
      ticks.push({ index: i, quote: d.quote, digit: d.digit, t: d.dayStartMs + i * d.tickMs });
    }
    send(ws, "inst_history", { instrumentId, ticks, tickMs: cur.tickMs });
  }

  const unsubInstrument = (ws: WebSocket) => {
    const s = siteOf.get(ws);
    const cur = subInstrument.get(ws);
    if (s && cur) { instStreamers.get(s)?.get(cur)?.subs.delete(ws); subInstrument.delete(ws); }
  };
  const stopAllStreamers = () => {
    for (const m of instStreamers.values()) for (const e of m.values()) clearInterval(e.timer);
    instStreamers.clear();
  };

  // ── Platform live channel (docs/24): cross-brand feed for the platform_superadmin console ──
  // Platform sockets connect with `?platform=1`, never join a brand's socket set (so they don't
  // inflate a brand's online count), and receive raw per-site online counts + confirmed deposits.
  // docs/42 UI-5: each console socket carries the brands it may see — null = every brand (system owner),
  // else its platform's brands (platform admin), re-resolved at most once a minute so brands onboarded
  // later appear without a reconnect. Nothing from another platform is ever sent to a platform admin.
  interface PlatformSub { scope: Set<string> | null; platformId: string | null; refreshedAt: number }
  const platformSockets = new Map<WebSocket, PlatformSub>();
  const SCOPE_TTL_MS = 60_000;
  const refreshScope = (ws: WebSocket, sub: PlatformSub): void => {
    if (!sub.platformId || !opts.sitesOfPlatform || Date.now() - sub.refreshedAt < SCOPE_TTL_MS) return;
    sub.refreshedAt = Date.now();
    void opts.sitesOfPlatform(sub.platformId).then((ids) => { if (platformSockets.has(ws)) sub.scope = new Set(ids); }).catch(() => { /* keep last scope */ });
  };
  /** RAW per-site online counts (no onlineFloor) — the console needs the true live-player figure. */
  const onlineSnapshot = (scope: Set<string> | null) => {
    const sites: Array<{ siteId: string; count: number }> = [];
    let total = 0;
    for (const [siteId, set] of perSiteSockets) {
      if (scope && !scope.has(siteId)) continue;
      const c = set.size;
      if (c > 0) { sites.push({ siteId, count: c }); total += c; }
    }
    return { sites, total };
  };
  const broadcastPlatformOnline = () => {
    if (platformSockets.size === 0) return;
    platformSockets.forEach((sub, ws) => {
      refreshScope(ws, sub);
      const snap = onlineSnapshot(sub.scope);
      send(ws, "platform_online", { sites: snap.sites, totalOnline: snap.total, ts: Date.now() });
    });
  };
  /** Fan a confirmed deposit (from the DepositNotifier LISTEN) out to the console sockets allowed to see its brand. */
  const emitPlatformDeposit = (dep: unknown) => {
    const siteId = (dep as { siteId?: unknown } | null)?.siteId;
    platformSockets.forEach((sub, ws) => {
      if (sub.scope && !(typeof siteId === "string" && sub.scope.has(siteId))) return;
      send(ws, "platform_deposit", dep);
    });
  };

  /** A `?platform=1` connection: the console live feed (system owner: every brand; platform admin: its own
   *  platform's brands), bound to NO brand. */
  function handlePlatformConnection(ws: WebSocket) {
    send(ws, "hello", { serverTime: Date.now(), platform: true });
    let grant: PlatformSub | null = null;
    ws.on("message", async (raw) => {
      let msg: any; try { msg = JSON.parse(String(raw)); } catch { return send(ws, "error", { code: "BAD_JSON" }); }
      switch (msg.type) {
        case "auth": {
          let role = "", platformId: string | null = null;
          if (opts.verifier) {
            let claims;
            try { claims = await opts.verifier(String(msg.data?.token ?? "")); }
            catch { return send(ws, "error", { code: "AUTH_INVALID" }); }
            role = String((claims as { role?: string }).role ?? "");
            platformId = (claims as { platform?: string }).platform ?? null;
          } else {
            role = String(msg.data?.role ?? "");
            platformId = typeof msg.data?.platform === "string" ? msg.data.platform : null;
          }
          if (role === "platform_superadmin") {
            grant = { scope: null, platformId: null, refreshedAt: Date.now() };
          } else if (role === "platform_admin" && platformId && opts.sitesOfPlatform) {
            // Fail closed: a platform admin without a platform claim (or no resolver) gets nothing.
            let ids: string[];
            try { ids = await opts.sitesOfPlatform(platformId); } catch { return send(ws, "error", { code: "SCOPE_UNAVAILABLE" }); }
            grant = { scope: new Set(ids), platformId, refreshedAt: Date.now() };
          } else {
            return send(ws, "error", { code: "NOT_AUTHORIZED" });
          }
          return send(ws, "platform_authed", { scope: grant.scope ? "platform" : "system" });
        }
        case "subscribe_platform": {
          if (!grant) return send(ws, "error", { code: "AUTH_REQUIRED" });
          platformSockets.set(ws, grant);
          const snap = onlineSnapshot(grant.scope);
          return send(ws, "platform_snapshot", { sites: snap.sites, totalOnline: snap.total, ts: Date.now() });
        }
        case "ping": return send(ws, "pong", {});
        default: return send(ws, "error", { code: "UNKNOWN_TYPE", message: msg.type });
      }
    });
    ws.on("close", () => { platformSockets.delete(ws); });
  }

  /** Build (once) a brand's runtime and wire its per-site fan-out. */
  async function ensureSite(siteId: string) {
    const rt = await opts.registry.ensure(siteId);
    if (!wired.has(siteId)) {
      wired.add(siteId);
      rt.game.subscribe({
        onTick: (t) => {
          toSite(siteId, "tick", t);
          fanOutQuotes(siteId, rt, t.t);
        },
        onUpdate: (u) => {
          const p = rt.game.getPosition(u.positionId);
          if (p) toSiteUser(siteId, p.userId, "position_update", u);
        },
        /**
         * A pending order reached its level. The trader armed it earlier and is very likely not
         * watching, so this is pushed rather than waited for: MetaTrader moves the row from Orders
         * to Trade and writes a Journal line, and a terminal cannot do either without being told.
         */
        onPendingFilled: (e) => {
          toSiteUser(siteId, e.order.userId, "pending_filled", {
            orderId: e.order.id,
            kind: e.order.kind,
            symbol: e.order.symbol,
            triggerPrice: e.order.triggerPrice,
            stakeCents: e.order.stakeCents,
            positionId: e.positionId,
            error: e.error,
          });
          /**
           * And the position itself, in the SAME frame shape the `open_position` reply uses.
           *
           * Without this a filled order left the Orders list and nothing appeared in Trade: that
           * reply is the only other place `position_opened` is sent, and it is sent to the client
           * that asked. Nobody asked for this one, so it has to be pushed, and it has to look
           * exactly like the other so the client needs no second code path for it.
           */
          const p = e.position;
          if (p) {
            toSiteUser(siteId, p.userId, "position_opened", {
              /**
               * Nobody's request, so there is no `clientId` to echo and the client must not guess
               * one: its fallback is "the oldest order still awaiting its ack", which would pair
               * THIS position's ticket and entry price with a market order the trader happened to
               * have in flight. This flag is what tells it to adopt the position instead.
               */
              fromPending: true,
              orderId: e.order.id,
              positionId: p.id,
              ticket: p.ticket,
              entryRate: p.outcome.entryRate,
              direction: p.direction,
              stakeCents: p.stakeCents,
              durationS: p.durationS,
              expiresAtMs: p.expiresAtMs,
              slPrice: p.slPrice,
              tpPrice: p.tpPrice,
            });
          }
        },
        onSettled: (e) => {
          toSiteUser(siteId, e.position.userId, "position_settled", {
            positionId: e.position.id,
            // The ticket, so the deal the terminal reports closed is named the way MetaTrader names
            // one ("Close #328906"), including when the settle arrives after a reconnect.
            ticket: e.position.ticket,
            // On a continuous contract the result is whatever the close actually paid, not a
            // decision taken at open, so it is read off the money rather than off `outcome`.
            result: e.position.continuous ? (e.payoutCents > e.position.stakeCents ? "win" : "loss") : e.position.outcome.result,
            lockedMultiplier: e.lockedMultiplier,
            payoutCents: e.payoutCents, pnlCents: e.pnlCents, balance: e.balance, mode: e.mode, presentation: e.presentation,
            // Which level ended it, so the terminal can say "Stop Loss triggered" the way
            // MetaTrader does rather than describing every close the same way.
            ...(e.closedBy ? { closedBy: e.closedBy } : {}),
            // The side, so a terminal can name the deal the way MetaTrader names one. Taken from the
            // position itself rather than left to the client to remember: the client may have
            // dropped it, or never had it (a settle after a reconnect).
            direction: e.position.direction,
          });
          // A settle can convert wagered bonus into real cash (0094 FIFO conversion) — push the
          // full wallet snapshot so the client's bonus figure updates live, not on next refetch.
          void opts.repo.getWalletSnapshot(e.position.userId).then((snap) =>
            toSiteUser(siteId, e.position.userId, "balance", { real: snap.real, bonus: snap.bonus, currency: snap.currency }),
          ).catch(() => { /* non-fatal: the client also invalidates ['wallet'] on settle */ });
        },
        onError: (err, c) => report(err, `${siteId}:${c}`),
      });
      rt.game.start();
    }
    return rt;
  }

  // One newswire for the whole process: the feeds are public market copy, identical for every
  // brand, so polling them per brand would be the same request many times over.
  const news = opts.news ?? new MarketNews({ onError: (e, c) => report(e, c) });
  // Warm it at boot so the first player to open the tab is not the one who waits.
  void news.refresh().catch(() => { /* reported by onError */ });

  /**
   * Compressed frames. The candle replies are the reason: 240 M1 bars is ~23KB of JSON whose
   * every row is the same six keys and prices that differ in their last two digits, which deflate
   * takes down by four to five times. On a phone on a mobile network that is most of the wait.
   *
   * `threshold` keeps the tick stream out of it: a tick frame is ~90 bytes, where the deflate
   * header alone would make it bigger, and ticks are the one thing here that must never be delayed.
   * `concurrencyLimit` bounds the zlib thread pool so a burst of history requests cannot starve it.
   */
  const wss = new WebSocketServer({
    host: opts.host ?? "0.0.0.0",
    port: opts.port,
    perMessageDeflate: {
      threshold: 1024,
      concurrencyLimit: 10,
      zlibDeflateOptions: { level: 6 },
      // Per-message context takeover costs memory per connection and buys little on frames this
      // self-similar; without it each frame compresses independently and the sockets stay cheap.
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    },
  });

  wss.on("connection", (ws, req) => {
    void (async () => {
      // Platform-console sockets are brand-less: route them to the cross-brand live channel.
      const purl = new URL(req.url ?? "/", "http://localhost");
      if (purl.searchParams.get("platform") === "1") { handlePlatformConnection(ws); return; }

      let siteId: string;
      try { siteId = await opts.resolveSite(req); } catch { try { ws.close(1008, "unknown site"); } catch { /* ignore */ } return; }
      let rt;
      try { rt = await ensureSite(siteId); } catch (err) { report(err as Error, "ensureSite"); try { ws.close(1011); } catch { /* ignore */ } return; }

      siteOf.set(ws, siteId);
      (perSiteSockets.get(siteId) ?? perSiteSockets.set(siteId, new Set()).get(siteId)!).add(ws);
      const ctx = rt.seeds.getActive();
      send(ws, "hello", { serverTime: Date.now(), serverSeedHash: ctx.seedHash, tradeDate: ctx.dateKey, gameConfig: rt.game.onlineConfigSnapshot(), site: siteId });
      toSite(siteId, "online", { count: onlineCount(siteId) });
      broadcastPlatformOnline();

      ws.on("message", async (raw) => {
        let msg: any; try { msg = JSON.parse(String(raw)); } catch { return send(ws, "error", { code: "BAD_JSON" }); }
        try {
          switch (msg.type) {
            case "auth": {
              let userId: string;
              let role = "player";
              if (opts.verifier) {
                let claims;
                try { claims = await opts.verifier(String(msg.data?.token ?? "")); }
                catch { return send(ws, "error", { code: "AUTH_INVALID" }); }
                userId = claims.userId;
                role = (claims as { role?: string }).role ?? "player";
                // A token minted for another brand must not drive this socket's brand.
                const tokenSite = (claims as { site?: string }).site;
                if (tokenSite && tokenSite !== siteId) return send(ws, "error", { code: "AUTH_SITE_MISMATCH" });
              } else {
                userId = String(msg.data?.userId ?? "");
                role = String(msg.data?.role ?? "player");
                if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              }
              userOf.set(ws, userId);
              roleOf.set(ws, role);
              const um = perSiteUser.get(siteId) ?? perSiteUser.set(siteId, new Map()).get(siteId)!;
              (um.get(userId) ?? um.set(userId, new Set()).get(userId)!).add(ws);
              if (opts.devSeedBalance) await opts.devSeedBalance(siteId, userId);
              // Full snapshot (real + bonus) so a freshly granted welcome bonus (0094) shows in the
              // client wallet immediately on connect, not only after the next REST /wallet refetch.
              const snap = await opts.repo.getWalletSnapshot(userId);
              send(ws, "balance", { real: snap.real, bonus: snap.bonus, currency: snap.currency });
              /**
               * Whatever this user already has running, so a refreshed client can pick it up.
               *
               * A reload destroyed the client's only record of an open contract, and the engine had
               * no way to be asked about it: the Trade screen said "No open positions" while the
               * contract was still running, its tick updates were arriving at this very socket and
               * being dropped for want of a position to attach them to, and it would settle into a
               * balance change the trader could not account for.
               *
               * On the AUTH reply rather than in `hello`, because `hello` is sent before auth and
               * cannot carry a user's data. Nothing is decided here: it reports what the engine
               * already holds, and the live multiplier, the countdown and `sellable` all arrive on
               * the next tick as they already did.
               */
              return send(ws, "open_positions", openPositionsPayload(rt, userId));
            }
            /**
             * The same list, on demand, because an ACK can be lost.
             *
             * `open_position` is the one request on this socket that moves money, and it was the one
             * request with no way to ask again. A client whose `position_opened` never arrived (a
             * dropped frame, a socket that died between the send and the reply) was left showing an
             * optimistic "Opening…" position and an optimistic debit, for ever: the frame above is
             * sent only on the auth reply, so nothing could re-ask without reconnecting.
             *
             * This decides nothing and changes nothing. It reports what the engine already holds, so
             * a client that times out waiting for an ack can ask the authoritative question, "do I
             * have this position or not", instead of guessing. Guessing either way is a real error:
             * roll back a position that exists and the trader cannot see or close it; keep one that
             * does not and the trader sees money committed to nothing.
             */
            case "sync_positions": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              return send(ws, "open_positions", openPositionsPayload(rt, userId));
            }
            case "open_position": {
              /**
               * The caller's own id for this order, echoed on every answer to it.
               *
               * MetaTrader holds many positions at once, so a trader can send a second order while
               * the first is still in flight, and this handler AWAITS the repository: with a real
               * database those awaits are real I/O, so two orders can finish in either order. The
               * ack carries no clue which order it answers, and binding by arrival order would be a
               * guess that is wrong exactly when it costs money, pairing one order's ticket with
               * another's stake.
               *
               * `candles` above already does this, and for the same stated reason: several requests
               * can be in flight at once, so the reply echoes the caller's id rather than leaving it
               * to be matched by guesswork. An order deserves it more than a chart does.
               *
               * Optional, so a client written before this still works: absent means the field is
               * simply not echoed, and such a client only ever has one order outstanding anyway.
               */
              const orderId = msg.data?.clientId === undefined ? undefined : String(msg.data.clientId);
              const cid = orderId === undefined ? {} : { clientId: orderId };
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED", ...cid });
              if (opts.playAllowed && !(await opts.playAllowed()))
                return send(ws, "error", { code: "SYSTEM_DISABLED", message: "Play is temporarily disabled by the platform.", ...cid });
              // MetaTrader arms the protective levels with the order itself, so they are part of
              // the request rather than a second round trip the trader could lose a tick inside.
              const lvl = (v: unknown): number | null => {
                const n = Number(v);
                return Number.isFinite(n) && n > 0 ? n : null;
              };
              // `balance` is deliberately not read: the authoritative snapshot is re-fetched below,
              // because bonus-first staking can move two buckets (0094).
              let p;
              try {
                ({ position: p } = await rt.game.openPosition({
                  userId, stakeCents: Number(msg.data.stakeCents), direction: msg.data.direction as Direction, durationS: msg.data.durationS,
                  role: roleOf.get(ws) ?? "player",
                  slPrice: lvl(msg.data.slPrice), tpPrice: lvl(msg.data.tpPrice),
                }));
              } catch (err: any) {
                // Refused with the order's own id, so a client with several orders outstanding can
                // roll back the one that failed instead of the newest one it happens to be holding.
                return send(ws, "error", { code: "TRADE_REJECTED", message: String(err?.message ?? err), ...cid });
              }
              send(ws, "position_opened", { positionId: p.id, ticket: p.ticket, ...cid, entryRate: p.outcome.entryRate, direction: p.direction, stakeCents: p.stakeCents, durationS: p.durationS, expiresAtMs: p.expiresAtMs, slPrice: p.slPrice, tpPrice: p.tpPrice });
              // Bonus-first staking (0094) spends bonus_balance before real, so the stake usually
              // moves BOTH buckets — push the full snapshot or the client bonus figure goes stale.
              const afterOpen = await opts.repo.getWalletSnapshot(userId);
              return send(ws, "balance", { real: afterOpen.real, bonus: afterOpen.bonus, currency: afterOpen.currency });
            }
            case "sell": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              await rt.game.sell(String(msg.data.positionId), userId); return;
            }
            /**
             * MetaTrader's pending orders: arm an order at a price, and wait.
             *
             * The three frames below are deliberately the same shape as `open_position`'s: the
             * caller's own id is echoed on every answer, because a trader can arm a second order
             * while the first is still being written and binding by arrival order would be a guess
             * that is wrong exactly when it costs money.
             *
             * The LEVEL is validated against the market by the engine, not by the browser. The
             * client calls the same `pendingLevelValid` so it never offers an impossible row, but
             * the price it holds is a tick or two old and the engine's is not — and an order that
             * would fill the instant it was placed is a market order wearing the wrong name.
             */
            case "place_pending": {
              const orderId = msg.data?.clientId === undefined ? undefined : String(msg.data.clientId);
              const cid = orderId === undefined ? {} : { clientId: orderId };
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED", ...cid });
              if (opts.playAllowed && !(await opts.playAllowed()))
                return send(ws, "error", { code: "SYSTEM_DISABLED", message: "Play is temporarily disabled by the platform.", ...cid });
              const lvl = (v: unknown): number | null => {
                const n = Number(v);
                return Number.isFinite(n) && n > 0 ? n : null;
              };
              const market = rt.game.priceRightNow();
              if (market === null) {
                return send(ws, "error", {
                  code: "NO_PRICE",
                  message: "The trade server has no price for this symbol yet.",
                  ...cid,
                });
              }
              /**
               * Only the symbol this brand ticks. The sweep offers `pending.step` that one symbol
               * and no other, so an order armed on anything else would be armed forever: listed,
               * never filled, and never refused. MetaTrader's own `Disabled` trade mode is what the
               * client already shows for those symbols; this is the server saying the same thing.
               */
              if (!isPendingKind(msg.data.kind)) {
                return send(ws, "error", {
                  code: "ORDER_REJECTED",
                  message: "That is not one of the four pending order types.",
                  ...cid,
                });
              }
              const traded = rt.game.tradedSymbol();
              const asked = String(msg.data.symbol ?? "");
              if (traded === null || asked !== traded) {
                return send(ws, "error", {
                  code: "WRONG_SYMBOL",
                  message: traded === null
                    ? "This account has no tradable instrument right now."
                    : `Orders on this account are placed on ${traded}.`,
                  ...cid,
                });
              }
              try {
                const order = await rt.game.pending.place({
                  userId,
                  kind: msg.data.kind,
                  symbol: traded,
                  stakeCents: Number(msg.data.stakeCents),
                  triggerPrice: Number(msg.data.triggerPrice),
                  slPrice: lvl(msg.data.slPrice),
                  tpPrice: lvl(msg.data.tpPrice),
                  durationS: Number(msg.data.durationS ?? 60),
                  marketPrice: market,
                });
                return send(ws, "pending_placed", { ...cid, order });
              } catch (err: any) {
                return send(ws, "error", { code: "ORDER_REJECTED", message: String(err?.message ?? err), ...cid });
              }
            }
            case "cancel_pending": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              try {
                const order = await rt.game.pending.cancel(String(msg.data.orderId), userId);
                return send(ws, "pending_canceled", { orderId: order.id });
              } catch (err: any) {
                return send(ws, "error", { code: "ORDER_REJECTED", message: String(err?.message ?? err) });
              }
            }
            case "pending_orders": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              return send(ws, "pending_orders", { orders: rt.game.pending.list(userId) });
            }
            /**
             * MetaTrader's Modify position: move or clear the protective levels on an open trade.
             *
             * The levels live on the ENGINE, not in the tab that set them. That is the whole point:
             * a stop held in a browser disarms itself when the trader closes the laptop, and this
             * one does not. The reply echoes what the engine now holds, so a client that lost the
             * race (two devices, say) is corrected rather than left believing its own copy.
             */
            case "set_levels": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              const lvl = (v: unknown): number | null => {
                const n = Number(v);
                return Number.isFinite(n) && n > 0 ? n : null;
              };
              try {
                const p = rt.game.setLevels(String(msg.data.positionId), userId, lvl(msg.data.slPrice), lvl(msg.data.tpPrice));
                return send(ws, "levels_set", { positionId: p.id, slPrice: p.slPrice, tpPrice: p.tpPrice });
              } catch (err) {
                return send(ws, "error", { code: "LEVELS_REJECTED", message: (err as Error).message });
              }
            }
            // ── Phase 2: Deriv-style DIGIT contracts + per-instrument feed subscription ──────────
            case "subscribe_instrument": {
              const instrumentId = String(msg.data?.instrumentId ?? "");
              if (!isKnownInstrument(instrumentId)) return send(ws, "error", { code: "INVALID_INSTRUMENT" });
              unsubInstrument(ws);
              const entry = await ensureStreamer(siteId, instrumentId);
              entry.subs.add(ws);
              subInstrument.set(ws, instrumentId);
              try { sendInstHistory(ws, rt, instrumentId); } catch { /* NO_SEED (dev without a seed) */ }
              return;
            }
            case "open_digit": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              if (opts.playAllowed && !(await opts.playAllowed()))
                return send(ws, "error", { code: "SYSTEM_DISABLED", message: "Play is temporarily disabled by the platform." });
              const instrumentId = String(msg.data?.instrumentId ?? "");
              if (!isKnownInstrument(instrumentId)) return send(ws, "error", { code: "INVALID_INSTRUMENT" });
              const stakeCents = Number(msg.data.stakeCents);
              const r = await rt.game.openDigitContract({
                userId, stakeCents, kind: String(msg.data.kind) as DigitKind,
                target: msg.data.target != null ? Number(msg.data.target) : undefined,
                instrumentId, ticks: msg.data.ticks != null ? Number(msg.data.ticks) : undefined,
                role: roleOf.get(ws) ?? "player",
              });
              await ensureStreamer(siteId, instrumentId); // guarantee settlement fires even with no watcher
              send(ws, "digit_opened", { positionId: r.positionId, instrumentId, openIndex: r.openIndex, settleIndex: r.settleIndex, entryRate: r.entryRate, stakeCents, kind: msg.data.kind, target: msg.data.target ?? null });
              const after = await opts.repo.getWalletSnapshot(userId);
              return send(ws, "balance", { real: after.real, bonus: after.bonus, currency: after.currency });
            }
            case "open_multiplier": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              if (opts.playAllowed && !(await opts.playAllowed()))
                return send(ws, "error", { code: "SYSTEM_DISABLED", message: "Play is temporarily disabled by the platform." });
              const instrumentId = String(msg.data?.instrumentId ?? "");
              if (!isKnownInstrument(instrumentId)) return send(ws, "error", { code: "INVALID_INSTRUMENT" });
              const r = await rt.game.openMultiplierContract({
                userId, stakeCents: Number(msg.data.stakeCents), dir: String(msg.data.dir) as MultDir,
                multiplier: Number(msg.data.multiplier),
                tpCents: msg.data.tpCents != null ? Number(msg.data.tpCents) : null,
                slCents: msg.data.slCents != null ? Number(msg.data.slCents) : null,
                dcMinutes: msg.data.dcMinutes != null ? Number(msg.data.dcMinutes) : undefined,
                instrumentId, role: roleOf.get(ws) ?? "player",
              });
              await ensureStreamer(siteId, instrumentId); // evaluation/updates run even with no watcher
              send(ws, "mult_opened", { positionId: r.positionId, instrumentId, entry: r.entry, stakeCents: Number(msg.data.stakeCents), dir: msg.data.dir, multiplier: Number(msg.data.multiplier), tpCents: r.tpCents, slCents: r.slCents, dcUntilMs: r.dcUntilMs, dcFeeCents: r.dcFeeCents });
              const after = await opts.repo.getWalletSnapshot(userId);
              return send(ws, "balance", { real: after.real, bonus: after.bonus, currency: after.currency });
            }
            case "close_multiplier": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              const r = await rt.game.closeMultiplierContract(String(msg.data.positionId), userId);
              send(ws, "mult_closed", { positionId: r.positionId, reason: r.reason, pnlCents: r.pnlCents, payoutCents: r.payoutCents, balance: r.balance });
              const after = await opts.repo.getWalletSnapshot(userId);
              return send(ws, "balance", { real: after.real, bonus: after.bonus, currency: after.currency });
            }
            case "candles": {
              // Chart history. Unauthenticated on purpose: the price series is public (every player
              // watches the same curve), it reveals nothing about any account, and the chart draws
              // before a token arrives. Settlement is untouched — these are display bars.
              // The chart pages backwards while the live edge keeps updating, so several requests can
              // be in flight at once. Echoing the caller's id is what lets it match each reply —
              // including a failure — to the request that caused it instead of guessing by timeframe.
              const reqId = msg.data?.reqId === undefined ? undefined : String(msg.data.reqId);
              const rid = reqId === undefined ? {} : { reqId };
              const fail = (code: string, message?: string) =>
                send(ws, "error", { code, ...(message === undefined ? {} : { message }), ...rid });

              if (!rt.history) return fail("NO_CANDLES", "this brand draws a line chart, not candles");
              // Which symbol's bars. Absent means the brand's default, which is every client written
              // before multi-symbol. A symbol the brand does not offer is refused rather than
              // quietly served the default's bars under the requested name.
              const want = msg.data?.symbol === undefined || msg.data?.symbol === null
                ? undefined : String(msg.data.symbol);
              // Warmed rather than chained inline. A cold symbol is ~2.2s of CPU, and spending it
              // inside this handler is 2.2s during which the process serves no other brand; warming
              // slices it and yields between the slices. The reply is no later for it, because the
              // work is the same work.
              const hist = await rt.histories?.warm(want ?? rt.history.instrument.symbol);
              if (!hist) return fail("UNKNOWN_SYMBOL", want);
              const tf = String(msg.data?.tf ?? "");
              if (!isTimeframe(tf)) return fail("BAD_TIMEFRAME", tf);
              const count = Number(msg.data?.count ?? 500);
              if (!Number.isFinite(count) || count <= 0) return fail("BAD_COUNT");
              // `to` lets the client page backwards: ask again for bars ending at the oldest it holds.
              const rawTo = msg.data?.to;
              const to = rawTo === undefined || rawTo === null ? undefined : Number(rawTo);
              if (to !== undefined && !Number.isFinite(to)) return fail("BAD_TO");
              const anchor = hist.liveAnchor();
              return send(ws, "candles", {
                ...rid, tf, instrument: anchor.instrument,
                bars: hist.candles(tf, count, to),
                // How to place live ticks on the same axis: price = base + scale*(value - openValue),
                // where value = (rate - CURVE_BASE_RATE) / CURVE_AMPLITUDE.
                anchor: { tradeDate: anchor.dateKey, base: anchor.base, openValue: anchor.openValue },
              });
            }
            case "anchors": {
              // The day anchors a client needs to price OLD rates — one per UTC date it asks about.
              // Unauthenticated for the same reason the candles are: these are public chart facts,
              // identical for every player on the brand, and reveal nothing about anyone's trades.
              const reqId = msg.data?.reqId === undefined ? undefined : String(msg.data.reqId);
              const rid = reqId === undefined ? {} : { reqId };
              if (!rt.history) {
                return send(ws, "error", { code: "NO_CANDLES", message: "this brand draws a line chart, not candles", ...rid });
              }
              const want = msg.data?.symbol === undefined || msg.data?.symbol === null
                ? undefined : String(msg.data.symbol);
              const hist = await rt.histories?.warm(want ?? rt.history.instrument.symbol);
              if (!hist) return send(ws, "error", { code: "UNKNOWN_SYMBOL", message: want, ...rid });
              const raw = msg.data?.days;
              if (!Array.isArray(raw)) return send(ws, "error", { code: "BAD_DAYS", ...rid });
              const days = raw.slice(0, MAX_ANCHORS).map((d: unknown) => String(d));
              return send(ws, "anchors", {
                ...rid,
                instrument: hist.instrument,
                days: hist.anchors(days),
              });
            }
            case "symbols": {
              // The brand's tradable list, for Market Watch and the Symbols dialog.
              //
              // Unauthenticated for the same reason the candles are: which instruments a brand
              // offers is public, identical for every player on it, and reveals nothing about any
              // account. It carries no prices — a quote is the tick stream's job — only what each
              // instrument IS, which is what a list has to print beside it.
              const reqId = msg.data?.reqId === undefined ? undefined : String(msg.data.reqId);
              const rid = reqId === undefined ? {} : { reqId };
              if (!rt.histories) {
                return send(ws, "error", { code: "NO_CANDLES", message: "this brand draws a line chart, not candles", ...rid });
              }
              return send(ws, "symbols", {
                ...rid,
                // The symbol the chart draws when a client asks for none, so a client need not know
                // which of the list that is.
                defaultSymbol: rt.history!.instrument.symbol,
                symbols: rt.histories.symbols.flatMap((sym) => {
                  const d = symbolDef(sym);
                  // A brand configured with a symbol the catalogue does not carry is a
                  // misconfiguration, not a client error: leave it out rather than send a row
                  // nothing can describe or chart.
                  return d ? [{
                    symbol: d.symbol, description: d.description, group: d.group,
                    digits: d.digits,
                  }] : [];
                }),
              });
            }
            case "subscribe_symbols": {
              // The socket's Market Watch list. It REPLACES the previous list rather than adding to
              // it, because that is what the list is: a set the client owns and re-sends when the
              // trader changes it.
              const reqId = msg.data?.reqId === undefined ? undefined : String(msg.data.reqId);
              const rid = reqId === undefined ? {} : { reqId };
              if (!rt.histories) {
                return send(ws, "error", { code: "NO_CANDLES", message: "this brand draws a line chart, not candles", ...rid });
              }
              const raw = msg.data?.symbols;
              if (!Array.isArray(raw)) return send(ws, "error", { code: "BAD_SYMBOLS", ...rid });
              const accepted: string[] = [];
              const rejected: string[] = [];
              for (const sym of raw.map((x: unknown) => String(x))) {
                if (accepted.includes(sym)) continue;  // a duplicate is one subscription, not two
                if (accepted.length >= MAX_WATCHED_SYMBOLS) { rejected.push(sym); continue; }
                if (rt.histories.has(sym)) accepted.push(sym); else rejected.push(sym);
              }
              // Rates already sent for symbols still on the list are kept, so changing the list
              // does not reset every delta to zero and flash the whole watch window one colour.
              const prev = watched.get(ws);
              const last = new Map<string, number>();
              for (const sym of accepted) {
                const v = prev?.last.get(sym);
                if (v !== undefined) last.set(sym, v);
              }
              watched.set(ws, { symbols: accepted, last });
              send(ws, "subscribed_symbols", { ...rid, symbols: accepted, rejected, max: MAX_WATCHED_SYMBOLS });

              // Then warm each one and seed the client with what it needs to price that symbol's
              // ticks: the instrument, its day anchor, and a first quote. Queued inside
              // SymbolHistories, so a list of twenty cold symbols is twenty warms in order rather
              // than twenty concurrent chain walks.
              const hists = rt.histories;
              void (async () => {
                for (const symbol of accepted) {
                  try {
                    const h = await hists.warm(symbol);
                    if (!h) continue;
                    // The trader may have changed the list, or left, while this was warming.
                    if (!watched.get(ws)?.symbols.includes(symbol)) return;
                    if (ws.readyState !== ws.OPEN) return;
                    const a = h.liveAnchor();
                    const tick = h.liveTick();
                    watched.get(ws)?.last.set(symbol, tick.rate);
                    send(ws, "symbol_quote", {
                      symbol, instrument: a.instrument,
                      anchor: { tradeDate: a.dateKey, base: a.base, openValue: a.openValue },
                      rate: tick.rate, t: tick.t,
                    });
                  } catch (err) { report(err as Error, `${siteId}:warm ${symbol}`); }
                }
              })();
              return;
            }
            case "unsubscribe_symbols": {
              const reqId = msg.data?.reqId === undefined ? undefined : String(msg.data.reqId);
              const rid = reqId === undefined ? {} : { reqId };
              watched.delete(ws);
              return send(ws, "subscribed_symbols", { ...rid, symbols: [], rejected: [], max: MAX_WATCHED_SYMBOLS });
            }
            case "news": {
              // The terminal's newswire. Public market copy, shared by every brand — one poll serves
              // all of them — and unauthenticated for the same reason the candles are.
              const limit = Number(msg.data?.limit ?? 40);
              return send(ws, "news", {
                items: news.list(Number.isFinite(limit) ? limit : 40),
                fetchedAtMs: news.lastFetchedAtMs,
              });
            }
            case "ping": return send(ws, "pong", {});
            default: return send(ws, "error", { code: "UNKNOWN_TYPE", message: msg.type });
          }
        } catch (err: any) { send(ws, "error", { code: "ENGINE_ERROR", message: String(err?.message ?? err) }); }
      });

      ws.on("close", () => {
        unsubInstrument(ws);
        perSiteSockets.get(siteId)?.delete(ws);
        watched.delete(ws);
        const u = userOf.get(ws);
        if (u) perSiteUser.get(siteId)?.get(u)?.delete(ws);
        toSite(siteId, "online", { count: onlineCount(siteId) });
        broadcastPlatformOnline();
      });
    })();
  });

  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));

  // Re-arm instrument streamers for contracts recovered at boot: a crash-recovered open multiplier
  // (or digit) must keep evaluating/settling even before any client connects to its brand.
  for (const rt of opts.registry.all()) {
    const insts = new Set<string>([...rt.game.openDigitInstruments(), ...rt.game.openMultiplierInstruments()]);
    for (const inst of insts) {
      try { await ensureStreamer(rt.siteId, inst); }
      catch (err) { report(err as Error, `boot-streamer ${rt.siteId}:${inst}`); }
    }
  }

  return {
    wss,
    emitPlatformDeposit,
    close: () => new Promise<void>((resolve) => { stopAllStreamers(); opts.registry.stopAll(); wss.close(() => resolve()); }),
  };
}
