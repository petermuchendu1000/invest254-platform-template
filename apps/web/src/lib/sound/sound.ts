'use client';

import { create } from 'zustand';

/**
 * SOUND-1: short game sounds (CC0 "Interface Sounds" by Kenney, public/sounds/LICENSE.txt).
 *
 * Web Audio decodes each clip once and plays it with near-zero latency; if Web Audio is missing it
 * falls back to <audio>. Browsers only allow audio after a user gesture, so the context is created
 * lazily on the first play (always inside a tap/click handler or right after one). Muting is a
 * per-device preference (localStorage, wrapped in try/catch so private mode still works).
 */
export type SoundName = 'tap' | 'place' | 'win' | 'loss' | 'message' | 'toggle';
const NAMES: SoundName[] = ['tap', 'place', 'win', 'loss', 'message', 'toggle'];
const VOLUME: Record<SoundName, number> = { tap: 0.35, place: 0.5, win: 0.6, loss: 0.5, message: 0.55, toggle: 0.4 };
const KEY = 'pp:sound-muted';

function readMuted(): boolean {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(KEY) === '1'; } catch { return false; }
}

interface SoundState { muted: boolean; setMuted: (m: boolean) => void; toggle: () => void; }
export const useSound = create<SoundState>((set, get) => ({
  muted: false,
  setMuted: (muted) => {
    try { window.localStorage.setItem(KEY, muted ? '1' : '0'); } catch { /* private mode */ }
    set({ muted });
  },
  toggle: () => { const m = !get().muted; get().setMuted(m); if (!m) play('toggle', true); },
}));

/** Load the saved preference once on the client (called by the provider). */
export function hydrateSound(): void { useSound.setState({ muted: readMuted() }); }

let ctx: AudioContext | null = null;
const buffers = new Map<SoundName, AudioBuffer>();
const loading = new Map<SoundName, Promise<void>>();

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { ctx = null; }
  return ctx;
}

function load(name: SoundName): Promise<void> {
  const c = audioContext();
  if (!c) return Promise.resolve();
  const existing = loading.get(name);
  if (existing) return existing;
  const p = fetch(`/sounds/${name}.mp3`)
    .then((r) => r.arrayBuffer())
    .then((b) => c.decodeAudioData(b))
    .then((buf) => { buffers.set(name, buf); })
    .catch(() => { loading.delete(name); });
  loading.set(name, p);
  return p;
}

/** Decode every clip ahead of time (call after the first user gesture). */
export function preloadSounds(): void { for (const n of NAMES) void load(n); }

/** Play a clip unless muted. `force` plays even when muted (the unmute confirmation). */
export function play(name: SoundName, force = false): void {
  if (!force && useSound.getState().muted) return;
  const c = audioContext();
  if (!c) {
    try { const a = new Audio(`/sounds/${name}.mp3`); a.volume = VOLUME[name]; void a.play().catch(() => {}); } catch { /* no audio */ }
    return;
  }
  if (c.state === 'suspended') void c.resume().catch(() => {});
  const buf = buffers.get(name);
  if (!buf) { void load(name).then(() => { if (buffers.get(name)) play(name, force); }); return; }
  try {
    const src = c.createBufferSource();
    const gain = c.createGain();
    gain.gain.value = VOLUME[name];
    src.buffer = buf;
    src.connect(gain).connect(c.destination);
    src.start();
  } catch { /* ignore */ }
}
