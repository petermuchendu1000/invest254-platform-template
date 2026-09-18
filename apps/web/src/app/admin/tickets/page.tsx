'use client';
import { TicketsView } from '@/components/ops/TicketsView';

export default function AdminTicketsPage() {
  return <TicketsView title="Support tickets" subtitle="Raise an issue to your platform admin with an urgency level. Unresolved tickets auto-escalate to the System admin per their SLA. You see the tickets you raise here." />;
}
