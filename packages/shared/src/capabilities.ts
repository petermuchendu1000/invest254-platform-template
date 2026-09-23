/**
 * capabilities.ts — the ONE list of what each tier may see and do in the operator UI (docs/42 §3, P2).
 *
 * Every screen decides visibility with `can(role, capability)`, where `role` is the role the API will
 * actually authorise — the TOKEN's role (during impersonation that is `admin`, never the actor's own
 * tier). `apps/api/src/capabilities.contract.test.ts` calls a representative route of every capability
 * as every tier and fails if the API and this list disagree, so the UI can never again show a control
 * the API refuses, or hide one it allows (the drift behind docs/42 UI-3/UI-6/UI-7).
 *
 * Rows mirror the API gates:
 *   requireSiteAdmin  -> admin + platform_superadmin (a raw platform_admin is refused: it works a brand
 *                        only by opening it, i.e. with an `admin` token)
 *   ownerTier/platform (requireRole("platform_superadmin")) -> platform_superadmin
 *   platformAdmin     -> platform_admin + platform_superadmin
 * and the DB role rules (a site admin moves users only player<->marketer and cannot delete an admin).
 *   requireEarningRole (UI-12) -> player + marketer only; every operator tier is refused.
 */
export type Tier = "player" | "marketer" | "admin" | "platform_admin" | "platform_superadmin";

const OWNER = ["platform_superadmin"] as const;
const SITE_TIER = ["admin", "platform_superadmin"] as const;
const PLATFORM_TIER = ["platform_admin", "platform_superadmin"] as const;
/** docs/42 UI-12: only players and marketers may EARN from referrals — operators never. */
const EARNERS = ["player", "marketer"] as const;

export const CAPABILITIES = {
  // ── brand back office (/admin) — evaluated on the TOKEN role ────────────────────────────────
  "backoffice.enter": SITE_TIER,
  "backoffice.users.edit_details": SITE_TIER,
  "backoffice.users.set_role_basic": SITE_TIER,          // player <-> marketer
  "backoffice.users.set_role_admin": OWNER,              // promote to / change an admin
  "backoffice.users.delete": SITE_TIER,                  // players & marketers
  "backoffice.users.delete_admin": OWNER,
  "backoffice.users.overrides_write": OWNER,
  "backoffice.marketers.default": SITE_TIER,
  "backoffice.economy_integrity": SITE_TIER,             // real-cash RTP + config-change review (read)
  "backoffice.audit": OWNER,
  "backoffice.logs": OWNER,
  "backoffice.governance": OWNER,                        // game-config & withdrawal-pool writes, M-Pesa, Fly
  // ── platform / system console (/platform) ─────────────────────────────────────────────────
  "console.enter": PLATFORM_TIER,
  "console.brands": PLATFORM_TIER,                       // brands, onboarding, identity/theme/economy, players, pool, registrar, open brand
  "console.system": OWNER,                               // platforms, payment providers, global config, add-on catalog, platform admins
  "console.site.owner_settings": OWNER,                  // chart style / trade UI, site owner & default marketer
  "console.performance": PLATFORM_TIER,                  // scoped to its own platform for a platform admin (UI-5)
  "console.live": PLATFORM_TIER,                         // engine feed scoped per platform (UI-5)
  // ── player-side earning (UI-12: operators are never affiliates — conflict of interest) ──────
  "earn.referrals": EARNERS,                             // invite code/link, 5% perk, commission payouts, apply to the programme
  "earn.marketer_dashboard": ["marketer"],               // marketer dashboard, payout & advance requests
} as const satisfies Record<string, readonly Tier[]>;

export type Capability = keyof typeof CAPABILITIES;

/** May a caller whose token carries `role` use `cap`? Unknown or missing role -> false (fail closed). */
export function can(role: string | null | undefined, cap: Capability): boolean {
  if (!role) return false;
  return (CAPABILITIES[cap] as readonly string[]).includes(role);
}

/** All capability names (used by the contract test and docs generation). */
export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];
