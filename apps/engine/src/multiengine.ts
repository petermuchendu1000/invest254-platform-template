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
}

export interface MultiEngineHandle {
  wss: WebSocketServer;
  close(): Promise<void>;
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
        onSettled: (e) =>
          toSiteUser(siteId, e.position.userId, "position_settled", {
            positionId: e.position.id, result: e.position.outcome.result, lockedMultiplier: e.lockedMultiplier,
            payoutCents: e.payoutCents, pnlCents: e.pnlCents, balance: e.balance, mode: e.mode, presentation: e.presentation,
          }),
        onError: (err, c) => report(err, `${siteId}:${c}`),
      });
      rt.game.start();
    }
    return rt;
  }

  const wss = new WebSocketServer({ host: opts.host ?? "0.0.0.0", port: opts.port });

  wss.on("connection", (ws, req) => {
    void (async () => {
      let siteId: string;
      try { siteId = await opts.resolveSite(req); } catch { try { ws.close(1008, "unknown site"); } catch { /* ignore */ } return; }
      let rt;
      try { rt = await ensureSite(siteId); } catch (err) { report(err as Error, "ensureSite"); try { ws.close(1011); } catch { /* ignore */ } return; }

      siteOf.set(ws, siteId);
      (perSiteSockets.get(siteId) ?? perSiteSockets.set(siteId, new Set()).get(siteId)!).add(ws);
      const ctx = rt.seeds.getActive();
      send(ws, "hello", { serverTime: Date.now(), serverSeedHash: ctx.seedHash, tradeDate: ctx.dateKey, gameConfig: rt.game.onlineConfigSnapshot(), site: siteId });
      toSite(siteId, "online", { count: onlineCount(siteId) });

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
              return send(ws, "balance", { real: await opts.repo.getBalance(userId), currency: "KES" });
            }
            case "open_position": {
              const userId = userOf.get(ws); if (!userId) return send(ws, "error", { code: "AUTH_REQUIRED" });
              const { position: p, balance } = await rt.game.openPosition({
                userId, stakeCents: Number(msg.data.stakeCents), direction: msg.data.direction as Direction, durationS: msg.data.durationS,
                role: roleOf.get(ws) ?? "player",
              });
              send(ws, "position_opened", { positionId: p.id, entryRate: p.outcome.entryRate, direction: p.direction, stakeCents: p.stakeCents, durationS: p.durationS, expiresAtMs: p.expiresAtMs });
              return send(ws, "balance", { real: balance, currency: "KES" });
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
      });
    })();
  });

  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  return {
    wss,
    close: () => new Promise<void>((resolve) => { opts.registry.stopAll(); wss.close(() => resolve()); }),
  };
}
