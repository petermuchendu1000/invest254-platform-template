import { create } from 'zustand';

/*
 * Operator session facts the client needs to mirror the 0196 server gate: which roles it applies to,
 * how long a session may sit idle, and when this browser last spoke to the API.
 *
 * Everything here is INERT until an operator console arms it. Players and marketers are the
 * overwhelming majority of traffic and none of this applies to them: nothing below runs a timer,
 * makes a request or renders anything for them.
 */

/**
 * The roles the gate applies to.
 *
 * Mirrors GATED_ROLES in apps/api/src/stepup.ts, which is not importable here: `apps/api` is a
 * separate app and not a dependency of `apps/web`, so this is the one copy in the web client. If the
 * server's set changes, change it here too — a role in one set and not the other means either an
 * operator who is challenged with no modal to answer it, or a countdown shown to someone whose
 * session never expires.
 */
const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(['admin', 'platform_admin', 'platform_superadmin']);

export const isPrivilegedRole = (role: string | null | undefined): boolean =>
  typeof role === 'string' && PRIVILEGED_ROLES.has(role);

/** Mirrors IDLE_WINDOW_MS in apps/api/src/stepup.ts — the server is the one that enforces it. */
export const IDLE_WINDOW_MS = 5 * 60_000;

/** How long before the deadline the warning appears. */
export const IDLE_WARNING_MS = 60_000;

/*
 * The activity clock.
 *
 * Deliberately NOT mouse or keyboard activity: the server measures inactivity from the last
 * authenticated REQUEST (see makeIdleGate), so anything else would count a session as alive while
 * the server was already refusing it — a countdown that lies in the dangerous direction. A plain
 * module-level number rather than a store, because this is written on every API response and a
 * subscribable value there would re-render the console a few times a second.
 */
let activityArmed = false;
let lastActivityMs = 0;

/** Called by the console watcher for a privileged session only. */
export function armOperatorActivity(on: boolean): void {
  activityArmed = on;
  if (on) lastActivityMs = Date.now();
}

/** Called from apiFetch on every answered authenticated call. One boolean test when disarmed. */
export function noteOperatorActivity(): void {
  if (activityArmed) lastActivityMs = Date.now();
}

export function lastOperatorActivityMs(): number {
  return lastActivityMs;
}

interface SessionEndState {
  /** Why the session ended, for the sign-in screen to explain. Null = ended normally, or never. */
  reason: 'idle' | null;
  setReason: (reason: 'idle' | null) => void;
}

/**
 * Why the operator is looking at a sign-in screen they did not ask for.
 *
 * Not persisted: a reason that outlived the tab would greet an operator with "you were signed out
 * for inactivity" days later. It only has to survive the re-render that swaps the console for the
 * sign-in form.
 */
export const useSessionEnd = create<SessionEndState>()((set) => ({
  reason: null,
  setReason: (reason) => set({ reason }),
}));
