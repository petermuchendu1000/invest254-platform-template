import * as React from 'react';
import { cn } from '@/lib/cn';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
}

/**
 * Select styled to match <Input>: same label, wrapper focus ring, height and radius, plus a custom
 * chevron (native arrow removed via appearance-none) so form popups look consistent and professional.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, id, className, children, ...props },
  ref,
) {
  const selectId = id ?? props.name;
  return (
    <label htmlFor={selectId} className="flex flex-col gap-1.5 text-sm">
      {label ? (
        <span className="font-medium text-fg">
          {label}
          {props.required ? <span className="text-down" aria-hidden> *</span> : null}
        </span>
      ) : null}
      <span
        className={cn(
          'group relative flex items-center rounded-brand border bg-surface-2 transition',
          'focus-within:ring-2 focus-within:ring-accent focus-within:border-accent',
          error ? 'border-down' : 'border-border',
        )}
      >
        <select
          id={selectId}
          ref={ref}
          className={cn(
            'h-12 w-full appearance-none rounded-brand bg-transparent px-3.5 pr-10 text-fg outline-none',
            '[&>option]:bg-surface [&>option]:text-fg', // readable options on dark themes (supported browsers)
            className,
          )}
          aria-invalid={error ? true : undefined}
          {...props}
        >
          {children}
        </select>
        <span className="pointer-events-none absolute right-3 flex items-center text-muted">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
      {error ? (
        <span className="text-xs text-down">{error}</span>
      ) : hint ? (
        <span className="text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
});
