import * as React from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { FitText } from '@/components/ui/FitText';
import { formatKes } from '@invest254/shared/money';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {subtitle ? <p className="max-w-3xl text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Compact KPI tile. Pass either `value` (string) or `money` (cents). */
export function StatCard({
  label,
  value,
  money,
  hint,
  tone,
  className,
}: {
  label: string;
  value?: string | number;
  money?: number;
  hint?: string;
  tone?: 'default' | 'up' | 'down' | 'warn';
  /** e.g. a column span, so money tiles get the room a long figure needs */
  className?: string;
}) {
  const toneCls =
    tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-warn' : 'text-fg';
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 rounded-2xl border border-border bg-surface p-4', className)}>
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      {/* Figures are always shown in full: the size shrinks to fit the card instead of cutting the
          number off with "…" (BUGLOG #80). Wrapping ("KES" / number) is the last resort only. */}
      <FitText className={cn('text-xl font-bold tabular-nums sm:text-2xl', money !== undefined && 'font-mono', toneCls)}>
        {money !== undefined ? formatKes(money) : value}
      </FitText>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title ? <h2 className="text-sm font-semibold tracking-tight">{title}</h2> : null}
      {children}
    </section>
  );
}

/** Horizontally scrollable table wrapper (uses the global .table-wrapper class). */
export function TableWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="table-wrapper overflow-x-auto rounded-2xl border border-border bg-surface">
      <table className="w-full min-w-[640px] text-sm">{children}</table>
    </div>
  );
}
/** Table header. `numeric` right-aligns (amounts, counts, rates) — numbers always align on the right (UI-B). */
export function Th({ children, className, numeric }: { children?: React.ReactNode; className?: string; numeric?: boolean }) {
  return (
    <th className={cn('whitespace-nowrap px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted', numeric && 'text-right', className)}>
      {children}
    </th>
  );
}
export function Td({ children, className, numeric }: { children?: React.ReactNode; className?: string; numeric?: boolean }) {
  return <td className={cn('px-3 py-2.5 align-middle', numeric && 'whitespace-nowrap text-right tabular-nums', className)}>{children}</td>;
}

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** Toolbar search field — same 36px height as FilterSelect and small buttons (UI-B: one control height per toolbar). */
export function SearchInput({ value, onChange, placeholder, label, className }: {
  value: string; onChange: (v: string) => void; placeholder: string; label?: string; className?: string;
}) {
  return (
    <label className={cn('relative flex h-9 w-60 max-w-full items-center', className)}>
      <span className="sr-only">{label ?? placeholder}</span>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-8 pr-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
      />
    </label>
  );
}

/** Small select used for table filters. */
export function FilterSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      {label ? <span>{label}</span> : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One empty state for every list (UI-B): what is missing, why, and (optionally) what to do next. */
export function Empty({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-2xl border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** Two-step inline confirm for irreversible/visible actions (approve/reject, etc.). */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = 'primary',
  size = 'sm',
  busy,
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
  busy?: boolean;
  disabled?: boolean;
}) {
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);

  if (armed) {
    return (
      <span className="inline-flex items-center gap-1">
        <Button
          size={size}
          variant={variant}
          disabled={busy}
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
        >
          {busy ? '…' : confirmLabel ?? `Confirm ${label.toLowerCase()}`}
        </Button>
        <Button size={size} variant="ghost" onClick={() => setArmed(false)} disabled={busy}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button size={size} variant={variant} onClick={() => setArmed(true)} disabled={disabled || busy}>
      {label}
    </Button>
  );
}

/**
 * Approve action gated by the system owner password (Issue 1). Clicking reveals a password field; the
 * action only fires once the operator enters a value. The password is passed to `onConfirm`, which
 * forwards it to the API (the server verifies it against the system owner's approval password).
 */
export function PasswordConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = 'primary',
  size = 'sm',
  busy,
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: (password: string) => void;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
  busy?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [pw, setPw] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  function submit() {
    if (!pw) return;
    onConfirm(pw);
    setPw('');
    setOpen(false);
  }
  if (open) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          ref={inputRef}
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setPw(''); setOpen(false); } }}
          placeholder="System owner password"
          autoComplete="off"
          className="h-8 w-44 rounded-md border border-border bg-surface px-2 text-sm outline-none focus:border-accent"
        />
        <Button size={size} variant={variant} disabled={busy || !pw} onClick={submit}>
          {busy ? '…' : confirmLabel ?? 'Authorize'}
        </Button>
        <Button size={size} variant="ghost" onClick={() => { setPw(''); setOpen(false); }} disabled={busy}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button size={size} variant={variant} onClick={() => setOpen(true)} disabled={disabled || busy}>
      {label}
    </Button>
  );
}
