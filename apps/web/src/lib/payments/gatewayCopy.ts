/**
 * UI-D: one plain-language description per gateway, shown wherever gateways are listed (the engine schema
 * blurbs are technical: "HMAC-SHA512", "Basic Auth"…). `offers` says what the gateway does for players today.
 */
export interface GatewayCopy { summary: string; offers: Array<'Deposits' | 'Payouts'>; comingSoon?: boolean }
export const GATEWAY_COPY: Readonly<Record<string, GatewayCopy>> = {
  mpesa: { summary: 'Players approve a prompt on their phone to deposit; withdrawals are paid straight to M-Pesa.', offers: ['Deposits', 'Payouts'] },
  megapay: { summary: 'M-Pesa deposits collected through your Mega Pay account.', offers: ['Deposits'] },
  payhero: { summary: 'M-Pesa deposits collected through your PayHero (Lipwa) account.', offers: ['Deposits'] },
  paystack: { summary: 'Cards, bank transfers and mobile money. Save your keys now; players get it when it is switched on in the app.', offers: [], comingSoon: true },
  binance: { summary: 'Crypto payments with Binance Pay. Save your keys now; players get it when it is switched on in the app.', offers: [], comingSoon: true },
  stripe: { summary: 'International cards. Save your keys now; players get it when it is switched on in the app.', offers: [], comingSoon: true },
};
export function gatewayCopy(code: string, fallback: string, playerAvailable = true): GatewayCopy {
  return GATEWAY_COPY[code] ?? { summary: fallback, offers: playerAvailable ? ['Deposits'] : [], comingSoon: !playerAvailable };
}
