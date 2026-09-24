/** DIGITS-UI: the line-icon set used by the digits trade shell (stroke icons, currentColor). */
const P: Record<string, string> = {
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  deposit: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  withdraw: 'M12 21V9M7 14l5-5 5 5M4 3h16',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5zM4 19a2 2 0 0 1 2-2h13',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  chevronDown: 'M6 9l6 6 6-6',
  menu: 'M3 6h18M3 12h18M3 18h18',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  grid: 'M4 4h16v16H4zM4 12h16M12 4v16',
  triangle: 'M12 4l9 16H3z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  stop: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16h.01',
  sparkles: 'M9.5 3l1.6 4.4L15.5 9l-4.4 1.6L9.5 15l-1.6-4.4L3.5 9l4.4-1.6zM18 13l.9 2.1L21 16l-2.1.9L18 19l-.9-2.1L15 16l2.1-.9z',
  trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 6h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3',
  crosshair: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4',
  bars: 'M5 20V10M10 20V4M15 20v-7M20 20v-4',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  line: 'M3 17l5-5 4 3 9-9',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  gift: 'M4 11h16v10H4zM2 7h20v4H2zM12 7v14M12 7s-1.5-4-4-4a2 2 0 0 0 0 4M12 7s1.5-4 4-4a2 2 0 0 1 0 4',
  logout: 'M15 12H3M7 8l-4 4 4 4M13 4h6a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-6',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
  dollar: 'M12 3v18M16.5 7.5c0-1.9-2-3-4.5-3s-4.5 1.1-4.5 3.2c0 4.6 9 2.4 9 7 0 2.1-2 3.3-4.5 3.3s-4.5-1.1-4.5-3',
  arrowDownRight: 'M7 7l10 10M17 9v8H9',
  arrowUpRight: 'M7 17L17 7M9 7h8v8',
  x: 'M6 6l12 12M18 6L6 18',
  volume: 'M11 5L6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M18.4 5.6a9 9 0 0 1 0 12.8',
  mute: 'M11 5L6 9H3v6h3l5 4V5zM22 9l-6 6M16 9l6 6',
  paperclip: 'M21 11l-8.6 8.6a5 5 0 0 1-7-7L14 3.9a3.3 3.3 0 0 1 4.7 4.7L10 17.3a1.7 1.7 0 0 1-2.4-2.4L15.5 7',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  headset: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1zM17 20a4 4 0 0 1-4 2h-1',
  whatsapp: 'M20.5 11.9a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.2-4.3A8.5 8.5 0 1 1 20.5 11.9zM9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2z',
  idcard: 'M3 5h18v14H3zM7 10a2 2 0 1 0 4 0 2 2 0 0 0-4 0M5.5 16c.5-1.5 1.8-2.3 3.5-2.3s3 .8 3.5 2.3M14 9h5M14 12h5',
  stopSquare: 'M6 6h12v12H6z',
};

export type IconName = keyof typeof P;

export function DIcon({ name, className = 'h-5 w-5', strokeWidth = 1.8 }: { name: IconName; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={P[name]} />
    </svg>
  );
}
