import * as React from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'up' | 'down' | 'brand' | 'outline';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'bg-surface-2 text-fg hover:bg-border',
  ghost: 'bg-transparent text-fg hover:bg-surface-2',
  up: 'bg-up text-white hover:opacity-90',
  down: 'bg-down text-white hover:opacity-90',
  brand: 'bg-brand text-white hover:opacity-90',
  outline: 'border border-border bg-transparent text-fg hover:bg-surface-2',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-brand font-medium transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    />
  );
}
