/**
 * What MetaTrader's Settings screen lists here, and what it must not.
 *
 * The screen itself is chrome; these are the two rules behind it that are worth pinning down, so
 * they are here as pure functions with tests rather than as conditions buried in JSX.
 */

import { riskAnchor } from '../legal/legalPage.js';
import type { Register } from '../ui/register.js';

/** A row in the About group. */
export interface AboutRow {
  id: string;
  label: string;
  sub: string;
  href: string;
  /**
   * True when the row only exists because this is a real-money gambling product: a licence, a
   * responsible-gaming page, a problem-gambling helpline.
   */
  gambling: boolean;
}

/**
 * The About group, in the register this brand belongs to.
 *
 * The third row is the one that differs. A gaming brand owes a responsible-gaming page with limits
 * and self-exclusion on it; a broker owes a risk disclosure, and `riskAnchor` decides which of the
 * two the link reaches so this screen cannot send a trader to the other product's page. Both are
 * `gambling: true` only in the sense that marketer mode drops them, which is about what a recording
 * may show rather than about which product it is.
 */
export function aboutRows(isMarketer: boolean, register: Register = 'gaming'): AboutRow[] {
  const rows: readonly AboutRow[] = [
    { id: 'terms', label: 'Terms of service', sub: 'The agreement you trade under', href: '/legal#terms', gambling: false },
    { id: 'privacy', label: 'Privacy policy', sub: 'What we store and why', href: '/legal#privacy', gambling: false },
    register === 'trading'
      ? { id: 'responsible', label: 'Risk disclosure', sub: 'What you are taking on, and how to pause the account', href: `/legal#${riskAnchor('trading')}`, gambling: true }
      : { id: 'responsible', label: 'Responsible gaming', sub: 'Limits, self-exclusion and support', href: `/legal#${riskAnchor('gaming')}`, gambling: true },
    { id: 'licence', label: 'Licence', sub: 'Who this service is operated by', href: '/legal#licence', gambling: true },
  ];
  // A marketer screen is recorded and posted, and the whole point of the marketer skin is that a
  // recording carries no sign of a real-money gambling product. The footer already drops these for
  // the same reason; this keeps the two in step. Terms and Privacy stay: every app has those.
  return rows.filter((r) => !(isMarketer && r.gambling));
}

/**
 * The sub-label under Identity verification, from the KYC status the API reports.
 *
 * `undefined` is NOT "not verified", and collapsing the two was the same defect the verification
 * dialog was fixed for: a status that has not arrived yet -- the request is in flight, the token has
 * not rehydrated, the call failed -- is a question this row cannot answer, and answering it anyway
 * told a trader who HAD submitted their documents that they had not. The dialog behind this row
 * already distinguishes them (`AccountDialogs` keeps an explicit `'unknown'` and never shows the
 * form on it); the row that opens it now does too.
 *
 * `null` still means "asked, and the account has no KYC record", which genuinely is not verified.
 */
export function kycSub(status: string | null | undefined): string {
  if (status === undefined) return 'Checking…';
  switch (status) {
    case 'approved': return 'Verified';
    case 'pending': return 'In review';
    case 'rejected': return 'Not approved: try again';
    default: return 'Not verified';
  }
}

/** Tone for that sub-label: approved reads green, rejected red, anything else neutral. */
export function kycTone(status: string | null | undefined): 'ok' | 'bad' | 'neutral' {
  if (status === 'approved') return 'ok';
  if (status === 'rejected') return 'bad';
  return 'neutral';
}
