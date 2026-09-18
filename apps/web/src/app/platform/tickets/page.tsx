'use client';
import { TicketsView } from '@/components/ops/TicketsView';

export default function PlatformTicketsPage() {
  return <TicketsView title="Tickets" subtitle="Issues raised by your site admins are assigned to you and auto-escalate to the System admin if their SLA is breached. As System admin you see every platform's tickets." />;
}
