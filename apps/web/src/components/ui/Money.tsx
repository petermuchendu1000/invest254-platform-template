import { formatKes, type Cents } from '@invest254/shared/money';
import { cn } from '@/lib/cn';

/** Renders integer KES cents as a formatted currency string. */
export function Money({ cents, className }: { cents: Cents; className?: string }) {
  return <span className={cn('font-mono tabular-nums', className)}>{formatKes(cents)}</span>;
}
