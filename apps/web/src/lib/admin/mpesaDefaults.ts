/**
 * Pure derivation of the M-Pesa (Daraja) callback endpoints from the app's API base URL, plus the
 * production default. These are OUR own, fixed endpoints — they never change per paybill — so the
 * admin M-Pesa form can auto-fill them and leave the operator entering only the Safaricom-issued
 * values (shortcode, consumer key/secret, passkey, and for withdrawals the B2C initiator/credential).
 */
export const DEFAULT_MPESA_ENV = 'production';

export interface MpesaEndpointDefaults {
  stkCallbackUrl: string;
  b2cResultUrl: string;
  b2cTimeoutUrl: string;
}

export function defaultMpesaEndpoints(apiBaseUrl: string): MpesaEndpointDefaults {
  const base = (apiBaseUrl || '').replace(/\/+$/, '');
  return {
    // Routes: app.payments.ts -> POST /deposits/mpesa/callback and /withdrawals/mpesa/result/:txId.
    stkCallbackUrl: `${base}/deposits/mpesa/callback`,
    b2cResultUrl: `${base}/withdrawals/mpesa/result`,
    // No dedicated timeout handler exists; prod uses the same URL as the result endpoint.
    b2cTimeoutUrl: `${base}/withdrawals/mpesa/result`,
  };
}
