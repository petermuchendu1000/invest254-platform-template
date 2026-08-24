'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatKes } from '@invest254/shared/money';
import { cn } from '@/lib/cn';
import { useCountUp } from '@/lib/useCountUp';
import { useOutcomeFx, BALANCE_BUMP_EVENT, type OutcomeHeadline } from '@/lib/game/outcomeFx';

interface Theme {
  ring: string;
  glow: string;
  chipBg: string;
  chipText: string;
  amount: string;
  title: string;
  celebratory: boolean;
}

const THEMES: Record<OutcomeHeadline, Theme> = {
  big_win: {
    ring: 'border-warn/70',
    glow: 'shadow-[0_0_60px_-4px_var(--pp-warn)]',
    chipBg: 'bg-warn/15',
    chipText: 'text-warn',
    amount: 'text-warn',
    title: 'BIG WIN',
    celebratory: true,
  },
  win: {
    ring: 'border-up/70',
    glow: 'shadow-[0_0_48px_-6px_var(--pp-up)]',
    chipBg: 'bg-up/15',
    chipText: 'text-up',
    amount: 'text-up',
    title: 'YOU WON',
    celebratory: true,
  },
  small_win: {
    ring: 'border-up/60',
    glow: 'shadow-[0_0_36px_-8px_var(--pp-up)]',
    chipBg: 'bg-up/15',
    chipText: 'text-up',
    amount: 'text-up',
    title: 'WIN',
    celebratory: true,
  },
  near_miss: {
    ring: 'border-warn/60',
    glow: 'shadow-[0_0_32px_-10px_var(--pp-warn)]',
    chipBg: 'bg-warn/15',
    chipText: 'text-warn',
    amount: 'text-warn',
    title: 'SO CLOSE',
    celebratory: false,
  },
  loss: {
    ring: 'border-down/60',
    glow: 'shadow-[0_0_28px_-12px_var(--pp-down)]',
    chipBg: 'bg-down/15',
    chipText: 'text-down',
    amount: 'text-down',
    title: 'NO WIN',
    celebratory: false,
  },
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Full-screen outcome feedback. Celebratory for genuine wins (confetti, count-up,
 * money flying into the balance pill, haptics); honest and muted for near-misses
 * and losses (no confetti, no money flight, truthful net figure). Auto-dismisses;
 * dismiss-on-tap. Never auto-replays a trade.
 */
export function OutcomeOverlay() {
  const current = useOutcomeFx((s) => s.current);
  const clear = useOutcomeFx((s) => s.clear);
  const [visible, setVisible] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const flyRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const theme = current ? THEMES[current.headline] : THEMES.loss;
  const won = current?.result === 'win';

  // Count-up the headline amount: gross payout on a win, stake lost on a loss.
  const targetAmount = current ? (won ? current.payoutCents : Math.abs(current.pnlCents)) : 0;
  const shown = useCountUp(visible ? targetAmount : 0, won ? 950 : 500, current?.id);

  // Show / auto-dismiss lifecycle.
  useEffect(() => {
    if (!current) return;
    // The stake input (BetPanel) has autoFocus and may still hold focus when a position
    // settles. On mobile that keeps the soft keyboard open, covering the outcome card.
    // Blur whatever is focused so the keyboard dismisses before the overlay appears.
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // Also blur after a microtask: React may re-render BetPanel (removing the active
    // position card and re-showing the idle stake input) in the same commit, and the
    // autoFocus on that input would re-open the keyboard immediately after our blur.
    const t0 = setTimeout(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }, 0);
    setVisible(true);
    // Haptics: celebratory pattern for wins, single soft tap for losses.
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(
          current.headline === 'big_win'
            ? [0, 40, 60, 40, 60, 90]
            : won
              ? [0, 30, 50, 30]
              : [0, 20],
        );
      } catch {
        /* vibrate unsupported */
      }
    }
    const ttl = won ? (current.headline === 'big_win' ? 4200 : 3400) : 2400;
    const t = setTimeout(() => setVisible(false), ttl);
    return () => { clearTimeout(t0); clearTimeout(t); };
  }, [current, won]);

  // Remove from the store shortly after the exit transition.
  useEffect(() => {
    if (visible || !current) return;
    const t = setTimeout(() => clear(), 260);
    return () => clearTimeout(t);
  }, [visible, current, clear]);

  // Confetti (wins only, motion allowed).
  useEffect(() => {
    if (!visible || !current || !theme.celebratory) return;
    if (prefersReducedMotion()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const gold = current.headline === 'big_win';
    const palette = gold
      ? ['#e3b341', '#f2cf5b', '#ffffff', '#3fb950']
      : ['#3fb950', '#22e07e', '#ffffff', '#00a859'];
    const count = gold ? 160 : 110;
    type P = { x: number; y: number; vx: number; vy: number; r: number; c: string; rot: number; vr: number };
    const parts: P[] = Array.from({ length: count }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.4,
      y: H * 0.35 + (Math.random() - 0.5) * 40,
      vx: (Math.random() - 0.5) * 9,
      vy: Math.random() * -11 - 4,
      r: Math.random() * 5 + 3,
      c: palette[Math.floor(Math.random() * palette.length)]!,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
    }));

    const start = performance.now();
    const DUR = 1600;
    const step = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.35; // gravity
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - elapsed / DUR);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6);
        ctx.restore();
      }
      if (elapsed < DUR) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        ctx.clearRect(0, 0, W, H);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ctx.clearRect(0, 0, W, H);
    };
  }, [visible, current, theme.celebratory]);

  // Money-to-balance flight (wins only): a payout chip flies from the card to
  // the balance pill, then triggers the pill's count-up + pulse on arrival.
  useEffect(() => {
    if (!visible || !current || !won) return;
    if (prefersReducedMotion()) {
      window.dispatchEvent(new CustomEvent(BALANCE_BUMP_EVENT));
      return;
    }
    const fly = flyRef.current;
    const card = cardRef.current;
    const pill = document.getElementById('balance-pill');
    if (!fly || !card) return;

    const cardRect = card.getBoundingClientRect();
    const startX = cardRect.left + cardRect.width / 2;
    const startY = cardRect.top + cardRect.height / 2;
    // Target the balance pill if present, else fly to the top-right corner.
    const target = pill?.getBoundingClientRect();
    const endX = target ? target.left + target.width / 2 : window.innerWidth - 40;
    const endY = target ? target.top + target.height / 2 : 40;

    fly.style.left = '0px';
    fly.style.top = '0px';
    fly.style.transform = `translate(${startX}px, ${startY}px) translate(-50%, -50%) scale(1)`;
    fly.style.opacity = '0';

    const t1 = setTimeout(() => {
      fly.style.opacity = '1';
      fly.style.transition =
        'transform 720ms cubic-bezier(0.5,0,0.2,1), opacity 220ms ease-out';
      requestAnimationFrame(() => {
        fly.style.transform = `translate(${endX}px, ${endY}px) translate(-50%, -50%) scale(0.55)`;
      });
    }, 850);

    const onEnd = () => {
      fly.style.opacity = '0';
      window.dispatchEvent(new CustomEvent(BALANCE_BUMP_EVENT));
    };
    fly.addEventListener('transitionend', onEnd, { once: true });
    return () => {
      clearTimeout(t1);
      fly.removeEventListener('transitionend', onEnd);
    };
  }, [visible, current, won]);

  const netLine = useMemo(() => {
    if (!current) return null;
    if (won) return `Net +${formatKes(current.pnlCents)} · stake ${formatKes(current.stakeCents)}`;
    return `−${formatKes(Math.abs(current.pnlCents))} · stake ${formatKes(current.stakeCents)}`;
  }, [current, won]);

  if (!current) return null;

  return (
    <div
      role="dialog"
      aria-live="assertive"
      aria-label={`${theme.title} ${formatKes(targetAmount)}`}
      onClick={() => setVisible(false)}
      className={cn(
        'fixed inset-0 z-[70] flex items-center justify-center px-6 transition-opacity duration-200',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" />

      {/* Confetti canvas (wins) */}
      {theme.celebratory ? (
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      ) : null}

      {/* Result card */}
      <div
        ref={cardRef}
        className={cn(
          'relative z-10 w-full max-w-xs rounded-2xl border bg-surface p-6 text-center',
          theme.ring,
          theme.glow,
          visible ? 'animate-[pp-pop_320ms_cubic-bezier(0.2,0.9,0.2,1)]' : '',
          !won && current.result === 'loss' ? 'animate-[pp-shake_320ms_ease-in-out]' : '',
        )}
      >
        <div className="flex items-center justify-center gap-2">
          <span className={cn('text-xs font-bold uppercase tracking-[0.2em]', theme.chipText)}>
            {theme.title}
          </span>
        </div>

        {/* Multiplier (wins) or "just missed" (near-miss) */}
        {won ? (
          <div className={cn('mt-2 text-sm font-semibold tabular-nums', theme.chipText)}>
            ×{current.lockedMultiplier.toFixed(2)}
          </div>
        ) : current.headline === 'near_miss' ? (
          <div className="mt-2 text-sm font-medium text-muted">Just missed the mark</div>
        ) : null}

        {/* Big count-up amount */}
        <div className={cn('mt-1 text-4xl font-black tabular-nums', theme.amount)}>
          {won ? '+' : '−'}
          {formatKes(Math.round(shown))}
        </div>

        {/* Honest net line — always truthful about the money. */}
        <div className="mt-2 text-xs text-muted">{netLine}</div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setVisible(false);
          }}
          className={cn(
            'mt-5 h-10 w-full rounded-xl text-sm font-semibold transition',
            won ? 'bg-up text-white hover:opacity-90' : 'bg-surface-2 text-fg hover:bg-border',
          )}
        >
          {won ? 'Collect' : 'Continue'}
        </button>
      </div>

      {/* Flying payout chip (wins) */}
      {won ? (
        <div
          ref={flyRef}
          className={cn(
            'pointer-events-none fixed z-20 rounded-full px-3 py-1.5 text-sm font-bold tabular-nums opacity-0 shadow-glow',
            theme.chipBg,
            theme.chipText,
          )}
        >
          +{formatKes(current.payoutCents)}
        </div>
      ) : null}
    </div>
  );
}
