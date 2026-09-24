'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/cn';
import { useSound, hydrateSound, preloadSounds } from '@/lib/sound/sound';
import { DIcon } from '@/components/game/digits/icons';

/** SOUND-1: load the saved preference and decode the clips after the first tap (autoplay rules). */
export function SoundBootstrap() {
  useEffect(() => {
    hydrateSound();
    const once = () => { preloadSounds(); window.removeEventListener('pointerdown', once); };
    window.addEventListener('pointerdown', once, { passive: true });
    return () => window.removeEventListener('pointerdown', once);
  }, []);
  return null;
}

/** Speaker button: sound on / off for this device. */
export function SoundToggle({ className }: { className?: string }) {
  const muted = useSound((s) => s.muted);
  const toggle = useSound((s) => s.toggle);
  return (
    <button type="button" onClick={toggle} aria-pressed={!muted} aria-label={muted ? 'Turn sound on' : 'Turn sound off'} title={muted ? 'Sound off' : 'Sound on'}
      className={cn('grid h-10 w-10 place-items-center rounded-full text-fg transition hover:bg-surface-2', muted && 'text-muted', className)}>
      <DIcon name={muted ? 'mute' : 'volume'} className="h-[18px] w-[18px]" />
    </button>
  );
}
