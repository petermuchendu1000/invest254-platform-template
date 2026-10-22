import type { KycMine } from './accountUi';

// Pure, with no `@/` imports: `node --test` (which the deploy's verify step runs) cannot resolve the
// web alias, so a helper the suite tests has to live where it can be loaded without the bundler.
// accountUi re-exports it, so every caller keeps importing it from there.

/**
 * What a "Verify Identity" entry says about the state behind it.
 *
 * One function, because the phone drawer and the desktop avatar menu are the two ways to the same
 * dialog and they were wording it differently: the desktop appended `· in review`, the phone said
 * nothing at all. On a phone the drawer is the ONLY route, so that is the entry a trader whose
 * documents were already under review read as an invitation to send them again.
 */
export const kycLabelSuffix = (status: KycMine['status'] | undefined): string =>
  status === 'approved' ? ' \u00b7 verified'
  : status === 'pending' ? ' \u00b7 in review'
  : status === 'rejected' ? ' \u00b7 not approved'
  : '';
