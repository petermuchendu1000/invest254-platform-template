'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/cn';
import { useBrand } from '@/lib/brand/BrandProvider';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { MT5_TOKENS } from '@/lib/ui/mt5Tokens';
import { useBrokerTerminalBrand } from '@/lib/ui/useBrandShell';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  tone?: ToastTone | undefined;
  title: string;
  description?: string | undefined;
  /** Auto-dismiss after this many ms (default 4500; 0 = sticky). */
  durationMs?: number | undefined;
}

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  durationMs: number;
  description?: string | undefined;
}

interface ToastApi {
  push: (t: ToastInput) => void;
}

const Ctx = createContext<ToastApi | null>(null);

const toneStyles: Record<ToastTone, string> = {
  success: 'border-up/40 bg-up/10',
  error: 'border-down/40 bg-down/10',
  info: 'border-border bg-surface-2',
};

const toneDot: Record<ToastTone, string> = {
  success: 'bg-up',
  error: 'bg-down',
  info: 'bg-accent',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  // Safe here: ToastProvider is mounted inside BrandProvider (app/layout.tsx).
  const terminal = useBrokerTerminalBrand();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = ++seq.current;
      const toast: Toast = {
        id,
        tone: input.tone ?? 'info',
        title: input.title,
        description: input.description,
        durationMs: input.durationMs ?? 4500,
      };
      // Cap the visible stack to the 4 most recent.
      setToasts((cur) => [...cur.slice(-3), toast]);
      if (toast.durationMs > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), toast.durationMs),
        );
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 top-16 z-[60] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
        role="status"
      >
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            /**
             * On a MetaTrader brand the card paints from MetaTrader's palette instead of the
             * brand's. Every surface here resolves through the `--pp-*` custom properties, so
             * setting them on the card is the whole change: `bg-up/10` stops being a green tint
             * from the brand and becomes MetaTrader's own green at the same opacity, and the
             * accent dot stops being the brand's.
             *
             * It arrived as a bright green panel over MetaTrader's grey otherwise, which is what
             * made the one popup this app showed on a terminal look like a different product.
             */
            style={terminal ? MT5_TOKENS : undefined}
            className={cn(
              'pointer-events-auto w-full max-w-sm rounded-xl border p-3 text-left shadow-glow backdrop-blur transition',
              'animate-in fade-in slide-in-from-top-2',
              toneStyles[t.tone],
            )}
          >
            <div className="flex items-start gap-2">
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', toneDot[t.tone])} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-fg">{t.title}</p>
                {t.description ? <p className="text-xs text-muted">{t.description}</p> : null}
              </div>
            </div>
          </button>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used within <ToastProvider>');
  return v;
}
