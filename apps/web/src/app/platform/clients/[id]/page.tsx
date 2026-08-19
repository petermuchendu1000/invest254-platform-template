// Edge-runtime server wrapper so @cloudflare/next-on-pages can render this dynamic route as a
// Cloudflare edge function. The UI lives in ./view (client component); params are forwarded.
import ClientDetailView from './view';

export const runtime = 'edge';

export default function Page({ params }: { params: { id: string } }) {
  return <ClientDetailView params={params} />;
}
