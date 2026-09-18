/**
 * Brand logos for the payment gateways. These are the vendors' own official logo assets (downloaded
 * from each provider / an official logo repository) stored under apps/web/public/gateways, used to
 * identify each integration in the console — standard nominative use on a payments settings screen.
 * A white rounded tile keeps every mark crisp on the dark operator console.
 */
export const GATEWAY_LOGOS: Record<string, string> = {
  megapay: '/gateways/megapay.png',
  paystack: '/gateways/paystack.svg',
  binance: '/gateways/binance.svg',
  payhero: '/gateways/payhero.jpg',
};

export function GatewayLogo({ code, name, size = 'md' }: { code: string; name: string; size?: 'md' | 'lg' }) {
  const src = GATEWAY_LOGOS[code];
  const box = size === 'lg' ? 'h-12' : 'h-10';
  const imgH = size === 'lg' ? 'h-8' : 'h-6';
  const maxW = size === 'lg' ? 'max-w-[136px]' : 'max-w-[104px]';
  if (!src) {
    return (
      <div className={`flex ${box} w-10 items-center justify-center rounded-xl border border-border bg-surface text-base font-bold text-fg`}>
        {name.charAt(0)}
      </div>
    );
  }
  return (
    <span className={`inline-flex ${box} shrink-0 items-center justify-center rounded-xl border border-border bg-white px-2 shadow-sm`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={`${name} logo`} className={`${imgH} w-auto ${maxW} object-contain`} loading="lazy" />
    </span>
  );
}
