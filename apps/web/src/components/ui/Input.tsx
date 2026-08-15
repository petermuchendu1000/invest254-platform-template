import * as React from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  /** Decoration rendered inside the field, before the input (e.g. an icon or country code). */
  leading?: React.ReactNode;
  /** Interactive/decoration node rendered inside the field, after the input (e.g. show/hide). */
  trailing?: React.ReactNode;
  /** Mark the field as optional with an explicit "(optional)" tag next to the label (Baymard: mark both). */
  optional?: boolean | undefined;
}

/**
 * Form input with an optional label, inline error/hint, and leading/trailing adornments.
 * The focus ring lives on the wrapper so leading icons and trailing buttons sit flush inside
 * the control. Backward compatible: omit `leading`/`trailing` for a plain field.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, leading, trailing, optional, id, className, ...props },
  ref,
) {
  const inputId = id ?? props.name;
  return (
    <label htmlFor={inputId} className="flex flex-col gap-1.5 text-sm">
      {label ? (
        <span className="font-medium text-fg">
          {label}
          {props.required ? (
            <span className="text-down" aria-hidden> *</span>
          ) : optional ? (
            <span className="font-normal text-muted"> (optional)</span>
          ) : null}
        </span>
      ) : null}
      <span
        className={cn(
          'group flex items-center rounded-brand border bg-surface-2 transition',
          'focus-within:ring-2 focus-within:ring-accent focus-within:border-accent',
          error ? 'border-down' : 'border-border',
        )}
      >
        {leading ? (
          <span className="flex shrink-0 items-center pl-3 text-muted">{leading}</span>
        ) : null}
        <input
          id={inputId}
          ref={ref}
          className={cn(
            'h-12 w-full rounded-brand bg-transparent px-3.5 text-fg outline-none placeholder:text-muted',
            leading ? 'pl-2.5' : undefined,
            trailing ? 'pr-1.5' : undefined,
            className,
          )}
          aria-invalid={error ? true : undefined}
          {...props}
        />
        {trailing ? (
          <span className="flex shrink-0 items-center pr-2 text-muted">{trailing}</span>
        ) : null}
      </span>
      {error ? (
        <span className="text-xs text-down">{error}</span>
      ) : hint ? (
        <span className="text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
});
