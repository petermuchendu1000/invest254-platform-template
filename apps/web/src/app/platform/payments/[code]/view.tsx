'use client';

import { GatewayDetail } from '@/components/platform/GatewayDetail';

/** Client view for a single gateway's dedicated configuration page. */
export default function GatewayDetailView({ params }: { params: { code: string } }) {
  return <GatewayDetail code={params.code} />;
}
