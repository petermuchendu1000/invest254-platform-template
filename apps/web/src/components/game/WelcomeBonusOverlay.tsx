'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDisplayMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api/endpoints';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useCountUp } from '@/lib/useCountUp';
import { BALANCE_BUMP_EVENT } from '@/lib/game/outcomeFx';
import { useWelcomeBonusFx } from '@/lib/game/welcomeBonusFx';
import { useDepositUi } from '@/lib/wallet/depositUi';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Sign-up welcome-bonus celebration. Reuses the winning-card visual language (confetti, count-up,
 * the payout chip flying into the balance pill, haptics) so a new player's FIRST moment is a
 * genuine "win" — the peak-end rule working for the brand from second zero.
 *
 * Psychology (docs/31): the KES 200 gift is intentionally just below the min stake. The card names
 * the exact, small gap to the first trade ("you're only KES 50 away") — endowment effect (they now
 * own the money) + goal-gradient (a nearly-complete goal pulls hard) + Zeigarnik (an unused balance
 * nags). The primary CTA drops them straight into the deposit sheet, pre-seeded with that gap.
 */
export function WelcomeBonusOverlay() {
  const current = useWelcomeBonusFx((s) => s.current);
  const clear = useWelcomeBonusFx((s) => s.clear);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const brand = useBrand();
  const { fmt } = useDisplayMoney();

  const { data: config } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });

  const [visible, setVisible] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const flyRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const amountCents = current?.amountCents ?? 0;
  // Min stake is the DB-driven amount a player must be able to stake (site_game_config.min_stake,
  // surfaced as GameConfigDto.minStakeCents) — never hard-coded here. Undefined until config loads.
  const minStakeCents = config?.minStakeCents;
  const shown = useCountUp(visible ? amountCents : 0, 1000, current?.id);

  // Show / auto-dismiss lifecycle (celebratory, so it lingers a touch longer than a win).
  useEffect(() => {
    if (!current) return;
    setVisible(true);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([0, 40, 60, 40, 60, 90]);
      } catch {
        /* vibrate unsupported */
      }
    }
    const t = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(t);
  }, [current]);

  // Remove from the store shortly after the exit transition.
  useEffect(() => {
    if (visible || !current) return;
    const t = setTimeout(() => clear(), 260);
    return () => clearTimeout(t);
  }, [visible, current, clear]);

  // Confetti (gold + brand-green for a premium "gift" feel).
  useEffect(() => {
    if (!visible || !current) return;
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

    const palette = ['#e3b341', '#f2cf5b', '#ffffff', '#22e07e', '#16C784'];
    const count = 150;
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
    const DUR = 1800;
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
  }, [visible, current]);

  // Bonus chip flies from the card into the balance pill, then pulses it — the same reward cue as a win.
  useEffect(() => {
    if (!visible || !current) return;
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
    const target = pill?.getBoundingClientRect();
    const endX = target ? target.left + target.width / 2 : window.innerWidth - 40;
    const endY = target ? target.top + target.height / 2 : 40;

    fly.style.left = '0px';
    fly.style.top = '0px';
    fly.style.transform = `translate(${startX}px, ${startY}px) translate(-50%, -50%) scale(1)`;
    fly.style.opacity = '0';

    const t1 = setTimeout(() => {
      fly.style.opacity = '1';
      fly.style.transition = 'transform 720ms cubic-bezier(0.5,0,0.2,1), opacity 220ms ease-out';
      requestAnimationFrame(() => {
        fly.style.transform = `translate(${endX}px, ${endY}px) translate(-50%, -50%) scale(0.55)`;
      });
    }, 950);

    const onEnd = () => {
      fly.style.opacity = '0';
      window.dispatchEvent(new CustomEvent(BALANCE_BUMP_EVENT));
    };
    fly.addEventListener('transitionend', onEnd, { once: true });
    return () => {
      clearTimeout(t1);
      fly.removeEventListener('transitionend', onEnd);
    };
  }, [visible, current]);

  const nudge = useMemo(() => {
    if (minStakeCents && minStakeCents > 0) {
      // The bonus is a sweetener on top of a real deposit — encourage funding at least the min stake.
      return `Deposit ${fmt(minStakeCents)} or more to place your first trade — the bigger your stake, the bigger you can win.`;
    }
    return `Deposit to place your first trade — the more you add, the bigger you can win.`;
  }, [minStakeCents, fmt]);

  if (!current) return null;

  return (
    <div
      role="dialog"
      aria-live="assertive"
      aria-label={`Welcome bonus ${fmt(amountCents)}`}
      onClick={() => setVisible(false)}
      className={cn(
        'fixed inset-0 z-[70] flex items-center justify-center px-6 transition-opacity duration-200',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" />

      {/* Confetti canvas */}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Gift card */}
      <div
        ref={cardRef}
        className={cn(
          'relative z-10 w-full max-w-xs rounded-2xl border border-warn/70 bg-surface p-6 text-center',
          'shadow-[0_0_60px_-4px_var(--pp-warn)]',
          visible ? 'animate-[pp-pop_320ms_cubic-bezier(0.2,0.9,0.2,1)]' : '',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-center gap-2">
          <span className="text-xs font-bold uppercase tracking-[0.2em] text-warn">Welcome bonus</span>
        </div>

        {/* Big count-up amount */}
        <div className="mt-2 text-4xl font-black tabular-nums text-warn">+{fmt(Math.round(shown))}</div>

        {/* Psychology-driven nudge */}
        <div className="mt-3 text-sm text-fg">{nudge}</div>

        {/* Honest small print: it's a restricted bonus. */}
        <div className="mt-2 text-xs text-muted">
          Bonus funds — play them, and win to convert to withdrawable cash.
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setVisible(false);
            openDeposit(minStakeCents ? { amountCents: minStakeCents } : {});
          }}
          className="mt-5 h-10 w-full rounded-xl bg-up text-sm font-semibold text-white transition hover:opacity-90"
        >
          {minStakeCents ? `Deposit ${fmt(minStakeCents)}+ & play` : 'Deposit & play'}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setVisible(false);
          }}
          className="mt-2 h-8 w-full rounded-xl text-xs font-medium text-muted transition hover:text-fg"
        >
          Maybe later
        </button>
      </div>

      {/* Flying bonus chip */}
      <div
        ref={flyRef}
        className="pointer-events-none fixed z-20 rounded-full bg-warn/15 px-3 py-1.5 text-sm font-bold tabular-nums text-warn opacity-0 shadow-glow"
      >
        +{fmt(amountCents)}
      </div>
    </div>
  );
}
