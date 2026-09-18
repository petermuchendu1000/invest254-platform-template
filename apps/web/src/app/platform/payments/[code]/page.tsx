// Edge-runtime server wrapper so @cloudflare/next-on-pages can render this dynamic route as a
// Cloudflare edge function. The UI lives in ./view (client component); the gateway code is forwarded.
import GatewayDetailView from './view';

export const runtime = 'edge';

export default function Page({ params }: { params: { code: string } }) {
  return <GatewayDetailView params={params} />;
}
