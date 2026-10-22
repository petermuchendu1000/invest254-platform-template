import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * THE THREE SECURITY GATES MUST OUTRANK EVERY OTHER OVERLAY.
 *
 * SecurityQuestionsGate, MfaEnrolmentGate and StepUpGate are deliberately non-dismissible: no
 * backdrop click, no Esc. For StepUpGate a refused API call is parked behind the prompt, and
 * `apiFetch` replays it only once the challenge settles. Non-dismissible plus unreachable is
 * therefore not a cosmetic z-order nit — it is a hang.
 *
 * It shipped that way. The gates sat at z-[60]/[61]/[62] and RejectDialog at z-[70], so rejecting a
 * commission payout — an action launched FROM a dialog — raised a challenge that rendered
 * UNDERNEATH the dialog that triggered it, with the dialog's own full-viewport container swallowing
 * every click. The step-up promise never settled, so the mutation stayed pending forever, and the
 * panel gates its buttons on that shared `isPending`: one stuck reject disabled approve and reject
 * on every row until the operator reloaded. BUGLOG #152.
 *
 * Bumping three numbers fixes today. This test is what stops the next higher-numbered modal from
 * quietly putting it back: the invariant is checked against the source, so it holds for overlays
 * nobody has written yet.
 *
 * NOTE THE PROSE. Arbitrary z-indexes are written here as "z-index 110" and never in Tailwind's
 * bracket form, because `content: ['./src/**\/*.{ts,tsx}']` scans this file too and Tailwind's
 * extractor is a regex over raw text that does not skip comments. Writing the bracket form in a
 * comment emits a real, dead rule into the production bundle — a first draft of this file put
 * `z-index:110` on invest254.com from a sentence in a TEST. Harmless to render, but it defeats
 * reading the shipped CSS to tell which build is live, which is how this bug was confirmed in
 * production in the first place.
 *
 * WHY EVERY `fixed` ELEMENT AND NOT JUST FULL-SCREEN SCRIMS. A positioned overlay that covers only
 * part of the viewport can still land on the gate's inputs or its Cancel link, and deciding which
 * ones do from a class string is guesswork. "Nothing fixed sits at or above the gates" is a rule
 * that can be checked exactly, and it costs nothing — the gates are the top of the stack by
 * definition, because they are the only overlays with a blocked request behind them.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, '..', '..');

const GATES = ['SecurityQuestionsGate.tsx', 'MfaEnrolmentGate.tsx', 'StepUpGate.tsx'] as const;

/**
 * `z-[70]` and `z-50` both appear in this codebase; read either.
 *
 * The trailing `\b` belongs to the BARE form only. After `z-[70]` the next two characters are `]`
 * and a space — both non-word, so there is no boundary there and a trailing `\b` outside the group
 * silently rejects every bracketed value. That first version matched `z-50` and nothing else, so
 * the gates' own arbitrary values read as "no z-index at all".
 */
const Z = /\bz-(?:\[(\d+)\]|(\d+)\b)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Comments have to go first.
 *
 * The scan below pairs off quote characters, and an apostrophe or a quoted phrase inside a comment
 * — this codebase is full of both — desynchronises that pairing for the whole rest of the file, so
 * the real className strings after it never match. The symptom is a test that reports NO overlays
 * rather than a failing comparison, which is the kind of green that means nothing was checked.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/** Every z-index applied to a `fixed` element, by className string. */
function fixedZIndexes(source: string): number[] {
  const found: number[] = [];
  // className strings are the only place these live; match each quoted/backticked run that styles
  // something `fixed`, then take every z-index inside it.
  for (const m of stripComments(source).matchAll(/(["'`])((?:(?!\1)[\s\S])*?)\1/g)) {
    const cls = m[2]!;
    if (!/\bfixed\b/.test(cls)) continue;
    for (const z of cls.matchAll(Z)) found.push(Number(z[1] ?? z[2]));
  }
  return found;
}

test('the security gates sit above every other fixed overlay', () => {
  const gateZ = GATES.map((file) => {
    const zs = fixedZIndexes(readFileSync(join(HERE, file), 'utf8'));
    assert.ok(zs.length > 0, `${file} has no z-index on a fixed element — did its overlay change?`);
    return { file, z: Math.min(...zs) };
  });

  const floor = Math.min(...gateZ.map((g) => g.z));
  assert.ok(floor >= 100, `the gates should sit high in the scale, found ${floor}`);

  const offenders: string[] = [];
  for (const file of walk(WEB_SRC)) {
    if (GATES.some((g) => file.endsWith(g))) continue;
    for (const z of fixedZIndexes(readFileSync(file, 'utf8'))) {
      if (z >= floor) offenders.push(`${file.slice(WEB_SRC.length + 1)} (z-${z})`);
    }
  }

  assert.deepEqual(
    offenders, [],
    `these fixed overlays sit at or above the security gates (z-${floor}), so a challenge raised ` +
      `from one of them would render underneath it and hang:\n  ${offenders.join('\n  ')}`,
  );
});

test('the gates keep their relative order, so two of them never stack ambiguously', () => {
  // Providers.tsx mounts them questions -> 2FA -> step-up, and the comments there say the order is
  // deliberate. The z-order has to agree with the mount order or the "shown after" reasoning is
  // only true for whichever one React happens to paint last.
  const z = (file: string): number => Math.min(...fixedZIndexes(readFileSync(join(HERE, file), 'utf8')));
  assert.ok(
    z('SecurityQuestionsGate.tsx') < z('MfaEnrolmentGate.tsx'),
    'security questions must sit below 2FA enrolment',
  );
  assert.ok(
    z('MfaEnrolmentGate.tsx') < z('StepUpGate.tsx'),
    'step-up is raised by a blocked request and must sit above the enrolment gates',
  );
});
