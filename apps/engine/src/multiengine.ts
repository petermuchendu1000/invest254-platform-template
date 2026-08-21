import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { type Direction } from "@invest254/shared";
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
            case "ping": return send(ws, "pong", {});
            default: return send(ws, "error", { code: "UNKNOWN_TYPE", message: msg.type });
          }
        } catch (err: any) { send(ws, "error", { code: "ENGINE_ERROR", message: String(err?.message ?? err) }); }
      });

      ws.on("close", () => {
        perSiteSockets.get(siteId)?.delete(ws);
        const u = userOf.get(ws);
        if (u) perSiteUser.get(siteId)?.get(u)?.delete(ws);
        toSite(siteId, "online", { count: onlineCount(siteId) });
        broadcastPlatformOnline();
      });
    })();
  });

  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  return {
    wss,
    emitPlatformDeposit,
    close: () => new Promise<void>((resolve) => { opts.registry.stopAll(); wss.close(() => resolve()); }),
  };
}
