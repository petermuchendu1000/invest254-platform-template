/**
 * Phone masking for the wallet now comes from the ONE canonical helper
 * (`maskPhoneForDisplay`, packages/shared/src/payments.ts). The `maskMsisdn` that lived here
 * rendered "0712 •••678" while other screens rendered "25*****5678" and admin tables rendered the
 * number in full — three masks for one number, so an operator could never tell which digits were
 * real, and the fully-rendered screens stayed harvestable. It also returned anything under 10
 * characters UNCHANGED, which showed a half-typed number as typed.
 *
 * Re-exported rather than reimplemented so this module cannot drift back into a second mask.
 */
export { maskPhoneForDisplay } from '@invest254/shared/payments';
