import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { type Direction, instrumentById, isKnownInstrument, type DigitKind, type MultDir } from "@invest254/shared";
import type { SiteRegistry } from "./siteregistry.js";
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
  const platformSockets = new Set<WebSocket>();
  /** RAW per-site online counts (no onlineFloor) — the console needs the true live-player figure. */
  const onlineSnapshot = () => {
    const sites: Array<{ siteId: string; count: number }> = [];
    let total = 0;
    for (const [siteId, set] of perSiteSockets) {
      const c = set.size;
      if (c > 0) { sites.push({ siteId, count: c }); total += c; }
    }
    return { sites, total };
  };
  const broadcastPlatformOnline = () => {
    if (platformSockets.size === 0) return;
    const snap = onlineSnapshot();
    platformSockets.forEach((ws) => send(ws, "platform_online", { sites: snap.sites, totalOnline: snap.total, ts: Date.now() }));
  };
  /** Fan a confirmed deposit (from the DepositNotifier LISTEN) out to every platform socket. */
  const emitPlatformDeposit = (dep: unknown) => platformSockets.forEach((ws) => send(ws, "platform_deposit", dep));

  /** A `?platform=1` connection: platform_superadmin-gated live feed, bound to NO brand. */
  function handlePlatformConnection(ws: WebSocket) {
    send(ws, "hello", { serverTime: Date.now(), platform: true });
    let authed = false;
    ws.on("message", async (raw) => {
      let msg: any; try { msg = JSON.parse(String(raw)); } catch { return send(ws, "error", { code: "BAD_JSON" }); }
      switch (msg.type) {
        case "auth": {
          if (opts.verifier) {
            let claims;
            try { claims = await opts.verifier(String(msg.data?.token ?? "")); }
            catch { return send(ws, "error", { code: "AUTH_INVALID" }); }
            if ((claims as { role?: string }).role !== "platform_superadmin") return send(ws, "error", { code: "NOT_AUTHORIZED" });
          } else if (String(msg.data?.role ?? "") !== "platform_superadmin") {
            return send(ws, "error", { code: "NOT_AUTHORIZED" });
          }
          authed = true;
          return send(ws, "platform_authed", {});
        }
        case "subscribe_platform": {
          if (!authed) return send(ws, "error", { code: "AUTH_REQUIRED" });
          platformSockets.add(ws);
          const snap = onlineSnapshot();
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
        onTick: (t) => toSite(siteId, "tick", t),
        onUpdate: (u) => {
          const p = rt.game.getPosition(u.positionId);
          if (p) toSiteUser(siteId, p.userId, "position_update", u);
        },
        onSettled: (e) => {
          toSiteUser(siteId, e.position.userId, "position_settled", {
            positionId: e.position.id, result: e.position.outcome.result, lockedMultiplier: e.lockedMultiplier,
            payoutCents: e.payoutCents, pnlCents: e.pnlCents, balance: e.balance, mode: e.mode, presentation: e.presentation,
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

  const wss = new WebSocketServer({ host: opts.host ?? "0.0.0.0", port: opts.port });

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
              return send(ws, "balance", { real: snap.real, bonus: snap.bonus, currency: snap.currency });
            }
            case "open_position": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              if (opts.playAllowed && !(await opts.playAllowed()))
                return send(ws, "error", { code: "SYSTEM_DISABLED", message: "Play is temporarily disabled by the platform." });
              const { position: p, balance } = await rt.game.openPosition({
                userId, stakeCents: Number(msg.data.stakeCents), direction: msg.data.direction as Direction, durationS: msg.data.durationS,
                role: roleOf.get(ws) ?? "player",
              });
              send(ws, "position_opened", { positionId: p.id, entryRate: p.outcome.entryRate, direction: p.direction, stakeCents: p.stakeCents, durationS: p.durationS, expiresAtMs: p.expiresAtMs });
              // Bonus-first staking (0094) spends bonus_balance before real, so the stake usually
              // moves BOTH buckets — push the full snapshot or the client bonus figure goes stale.
              const afterOpen = await opts.repo.getWalletSnapshot(userId);
              return send(ws, "balance", { real: afterOpen.real, bonus: afterOpen.bonus, currency: afterOpen.currency });
            }
            case "sell": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              await rt.game.sell(String(msg.data.positionId), userId); return;
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
            case "ping": return send(ws, "pong", {});
            default: return send(ws, "error", { code: "UNKNOWN_TYPE", message: msg.type });
          }
        } catch (err: any) { send(ws, "error", { code: "ENGINE_ERROR", message: String(err?.message ?? err) }); }
      });

      ws.on("close", () => {
        unsubInstrument(ws);
        perSiteSockets.get(siteId)?.delete(ws);
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
