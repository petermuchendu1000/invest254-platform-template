import { cn } from '@/lib/cn';

/** Sentence case, one wording per state (UI-B): "in_progress" → "In progress", "reversed" → "Reversed". */
function label(status: string): string {
  const t = status.replace(/_/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1).toLowerCase() : t;
}

export function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone = /success|paid|credited|complete|approved|settled/.test(s)
    ? 'bg-up/15 text-up'
    : /fail|reject|revers|cancel|error|void/.test(s)
      ? 'bg-down/15 text-down'
      : 'bg-surface-2 text-muted';
  return (
    <span className={cn('inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', tone)}>
      {label(status)}
    </span>
  );
}
