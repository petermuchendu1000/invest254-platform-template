/**
 * seed-names.mjs — deterministic generator for SEEDED display handles (plus the two-line CLI
 * parser both callers need), shared by scripts/seed-activity.mjs (activity_seed, 0193) and
 * scripts/seed-leaderboard.mjs (leaderboard_seed, 0194).
 *
 * This file writes nothing and connects to nothing. It has no side effects on import, so both
 * seeding scripts and the test beside it (seed-names.test.mjs) can pull the pure helpers out.
 *
 * WHY HANDLES AND NOT NAMES. Both seed tables store `name` ready to display, and the read path
 * (`apps/api/src/activity.pg.ts`) deliberately does NOT pass a seeded name through `publicName` —
 * there is no account behind it to protect, so whatever is stored is rendered VERBATIM to every
 * visitor. The feed and the Top board therefore read as the market they are shown to: Kenyan
 * TikTok-style handles (`pfx`, `dollybaib`, `wanjiku_254`, `mrotieno`) rather than bare Title-case
 * first names, which is what the first version of the activity seeder used and which read like a
 * class register.
 *
 * THREE RULES, because the output is unescaped public copy:
 *  1. Nothing offensive. Every syllable comes from a curated pool — no random consonant soup that
 *     could spell something by accident — and every composed handle is then re-checked against
 *     DENY below. A draw that trips the check is discarded and redrawn, never "cleaned up".
 *  2. Nothing that impersonates. The stems are invented or are ordinary Kenyan given names; no
 *     surnames, no public figures, no operator, bank, telco or rival-brand names. DENY carries the
 *     obvious Kenyan ones explicitly so a later edit to a pool cannot quietly reintroduce them.
 *  3. Nothing that collides with a real player. Handles are synthetic, but `profiles.username` is
 *     player-chosen and globally unique, so a collision is possible in principle. Both scripts
 *     read the existing usernames once (a plain SELECT, no writes) and drop any seeded handle that
 *     matches one case-insensitively — see `rejectTaken`.
 *
 * LENGTH. `leaderboard_seed.name` is CHECK-constrained to 1..40 trimmed characters, and both
 * surfaces are read on a 320px phone where the name shares a row with an amount and an age. The
 * generator caps at MAX_LEN = 16, well inside the constraint and short enough that the UI never has
 * to truncate.
 *
 * DETERMINISM. Everything is a pure function of a `SeedRng`, which is an HMAC-SHA256 keystream in
 * the same shape as `packages/shared/src/prng.ts` (that file is TypeScript and these are plain
 * .mjs scripts, so the few lines are restated rather than imported — no build step to run a seed).
 * The same seed string reproduces the same handles, so a `--dry-run` preview is exactly what the
 * real run inserts, and a reviewer can re-derive it.
 */
import { createHmac } from "node:crypto";

/** Longest handle we will emit. Inside leaderboard_seed's 40-char CHECK, and reads on a 320px row. */
export const MAX_LEN = 16;
/** Shortest. Two characters is not a handle, it is a typo. */
export const MIN_LEN = 3;

/**
 * Deterministic uniform stream, keyed by a seed string — same construction as SeededRng:
 * HMAC-SHA256(seed, "label:counter") consumed as 48-bit big-endian blocks.
 */
export class SeedRng {
  #buf = Buffer.alloc(0);
  #off = 0;
  #ctr = 0;
  constructor(seed, label = "seed") {
    if (!seed) throw new Error("SeedRng: seed is required");
    this.seed = String(seed);
    this.label = String(label);
  }
  /** Uniform float in [0, 1). */
  next() {
    if (this.#off + 6 > this.#buf.length) {
      this.#buf = createHmac("sha256", this.seed).update(`${this.label}:${this.#ctr++}`).digest();
      this.#off = 0;
    }
    let v = 0;
    for (let i = 0; i < 6; i++) v = v * 256 + this.#buf[this.#off + i];
    this.#off += 6;
    return v / 2 ** 48;
  }
  /** Uniform float in [min, max). */
  range(min, max) { return min + (max - min) * this.next(); }
  /** Uniform integer in [min, max] inclusive. */
  int(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  /** Standard normal via Box-Muller — the shape that gives a long tail without a hard cap. */
  normal() {
    let u1 = this.next();
    if (u1 < 1e-12) u1 = 1e-12;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * this.next());
  }
  /** Uniform element of a non-empty array. */
  pick(xs) { return xs[Math.floor(this.next() * xs.length)]; }
  /** Weighted element: `weights[i]` is the relative weight of `xs[i]`. */
  weighted(xs, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (let i = 0; i < xs.length; i++) { r -= weights[i]; if (r < 0) return xs[i]; }
    return xs[xs.length - 1];
  }
}

/**
 * Ordinary Kenyan given names, lowercase, as they are written in a handle. Given names only — a
 * surname would start to describe a specific person. Mirrors the pool in
 * `packages/shared/src/activity.ts` (left untouched) and extends it a little.
 */
export const FIRST_NAMES = [
  "brian", "kevin", "john", "peter", "james", "david", "samuel", "dennis", "victor", "collins",
  "wanjiku", "achieng", "amina", "njeri", "faith", "mercy", "grace", "cynthia", "esther", "joy",
  "otieno", "kamau", "mwangi", "kiprop", "wafula", "omondi", "chebet", "barasa", "mutua", "njoroge",
  "shiro", "zawadi", "baraka", "imani", "salim", "halima", "rashid", "abdi", "yusuf", "fatuma",
  "nyambura", "atieno", "mueni", "kirui", "makena", "cherono", "nduta", "kemunto", "juma", "auma",
];

/**
 * Invented short stems — the brandable half of the pool, the `pfx` / `dolly` / `baib` shape that
 * reads as a handle somebody picked rather than as a name they were given. All are nonsense
 * syllables or harmless everyday Sheng/Swahili words; none is a company, a person or a place.
 */
export const STEMS = [
  "pfx", "dolly", "baib", "kiki", "tala", "vybz", "nia", "zuri", "sauti", "chapaa",
  "mkali", "poa", "safi", "mambo", "kali", "tamu", "simba", "duma", "mzuka", "fundi",
  "jabu", "kobe", "tuko", "sawa", "bozz", "dede", "lulu", "mimo", "nene", "tito",
  "vybe", "zigi", "kadi", "mali", "jozi", "rozi", "tuzo", "wazi", "yema", "zedi",
];

/**
 * Tokens that must never appear in a seeded handle, whatever the pools are later edited to
 * contain. Payment rails, telcos, banks, rival betting brands, this brand's own operator words,
 * and the words a visitor would read as an official account. Checked as substrings, so
 * `safaricomdeals` is caught as well as `safaricom`.
 *
 * Keep additions here rather than in the pools: a pool is a creative list, this is the hard floor.
 */
export const DENY = [
  // payment rails, telcos, banks
  "mpesa", "safaricom", "airtel", "equity", "kcb", "coop", "absa", "ncba", "stanbic", "paybill",
  "till", "mshwari", "fuliza", "tala254", "visa", "mastercard", "paypal", "binance", "crypto",
  // rival / adjacent gambling brands
  "betika", "odibets", "sportpesa", "shabiki", "betway", "mozzart", "22bet", "1xbet", "aviator",
  // official-sounding, support-impersonating
  "admin", "support", "helpdesk", "invest254", "customercare", "agent", "moderator", "verified",
  // public figures / politics / religion — a seeded handle must not put words in anyone's mouth
  "ruto", "uhuru", "raila", "obama", "kenyatta", "odinga", "jesus", "allah", "mungu",
  // crude or abusive
  "sex", "porn", "fuck", "shit", "bitch", "nigga", "rape", "kill", "malaya", "mavi",
  // scam bait
  "freemoney", "loan", "mkopo", "winner254", "jackpot",
];

/** Allowed shape of a finished handle: lowercase letters, digits, one of `_` or `.` as separator. */
const SHAPE = /^[a-z][a-z0-9._]{1,14}[a-z0-9]$/;

/** True when a candidate handle is safe to render verbatim to every visitor. */
export function isSafeHandle(h) {
  if (typeof h !== "string") return false;
  if (h.length < MIN_LEN || h.length > MAX_LEN) return false;
  if (!SHAPE.test(h)) return false;
  if (/[._]{2,}/.test(h)) return false; // "mr__x" reads as a bug, not a handle
  const flat = h.replace(/[^a-z0-9]/g, "");
  return !DENY.some((bad) => flat.includes(bad) || h.includes(bad));
}

/**
 * The style mix, with relative weights. Roughly a third brandable (`pfx`, `dollybaib`), the rest
 * built on a given name, because that is the split a Kenyan TikTok follower list actually shows:
 * plenty of `wanjiku_254` and `mrotieno`, and a visible minority of invented one-word handles.
 */
const STYLES = [
  { w: 14, f: (r) => r.pick(STEMS) },                                       // pfx
  { w: 10, f: (r) => r.pick(STEMS) + r.pick(STEMS) },                       // dollybaib
  { w: 6,  f: (r) => r.pick(STEMS) + r.int(1, 99) },                        // tala07
  { w: 4,  f: (r) => r.pick(STEMS) + "_254" },                              // mzuka_254
  { w: 12, f: (r) => r.pick(FIRST_NAMES) + "_254" },                        // wanjiku_254
  { w: 8,  f: (r) => r.pick(FIRST_NAMES) + ".ke" },                         // otieno.ke
  { w: 10, f: (r) => r.pick(FIRST_NAMES) + r.int(1, 999) },                 // mercy254
  { w: 7,  f: (r) => r.pick(FIRST_NAMES) + "_" + r.int(1, 99) },            // kamau_07
  { w: 8,  f: (r) => (r.next() < 0.55 ? "mr" : "ms") + r.pick(FIRST_NAMES) },
  { w: 5,  f: (r) => r.pick(FIRST_NAMES) + "official" },                    // faithofficial
  { w: 6,  f: (r) => "the" + r.pick(FIRST_NAMES) },                         // thebaraka
  { w: 5,  f: (r) => r.pick(FIRST_NAMES) + r.pick(STEMS) },                 // joykiki
  { w: 5,  f: (r) => r.pick(STEMS) + "." + r.pick(STEMS) },                 // nia.tuzo
];
const STYLE_WEIGHTS = STYLES.map((s) => s.w);

/**
 * One handle. Pure function of `rng`; redraws until the candidate passes `isSafeHandle` (the length
 * cap is what usually bites — `nyamburaofficial` is 16 and fine, `chepkoechofficial` would be 17).
 */
export function makeHandle(rng) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const h = String(rng.weighted(STYLES, STYLE_WEIGHTS).f(rng)).toLowerCase();
    if (isSafeHandle(h)) return h;
  }
  // Unreachable with the pools above; an explicit throw beats emitting something unchecked.
  throw new Error("makeHandle: no safe handle after 64 attempts — check DENY/MAX_LEN vs the pools");
}

/**
 * `n` DISTINCT handles, in generation order.
 *
 * Distinct matters on both surfaces: a feed where the same handle deposits three times in a minute
 * reads as a bot, and the Top board groups by name, so two traders sharing a handle would silently
 * merge into one row with double the winnings.
 */
export function makeHandles(rng, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error("makeHandles: n must be a positive integer");
  const out = [];
  const seen = new Set();
  // The pools yield tens of thousands of combinations, but ask for too many and the short styles
  // exhaust; the attempt budget keeps that a clear error instead of a hang.
  for (let attempts = 0; out.length < n && attempts < n * 200 + 5_000; attempts++) {
    const h = makeHandle(rng);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  if (out.length < n) throw new Error(`makeHandles: could only produce ${out.length} distinct handles of ${n}`);
  return out;
}

/**
 * Drop handles that a real player already owns.
 *
 * `taken` is whatever `select username from public.profiles` returned. The comparison is
 * lowercase-insensitive because the handles are lowercase and a player's username may not be.
 * Returns `{ kept, dropped }` so the caller can say out loud that it happened.
 */
export function rejectTaken(handles, taken) {
  const t = new Set((taken ?? []).map((u) => String(u ?? "").trim().toLowerCase()).filter(Boolean));
  const kept = [];
  const dropped = [];
  for (const h of handles) (t.has(h.toLowerCase()) ? dropped : kept).push(h);
  return { kept, dropped };
}

/**
 * The CLI shape both seeding scripts use: positional arguments, `--flag=value` or `--flag value`,
 * and a fixed set of boolean flags (so `--dry-run <slug>` cannot swallow the slug as its value).
 *
 * Returns `{ pos, flags }`. Shared because the two scripts must not drift into accepting slightly
 * different syntax; an operator types these at a terminal under time pressure.
 */
export const BOOLEAN_FLAGS = new Set(["dry-run", "help"]);

export function parseCli(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    if (!BOOLEAN_FLAGS.has(name) && argv[i + 1] && !argv[i + 1].startsWith("--")) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return { pos, flags };
}
