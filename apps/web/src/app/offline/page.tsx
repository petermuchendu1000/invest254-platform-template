import Link from 'next/link';

export const metadata = { title: 'Offline' };

// Served by the service worker when a navigation fails with no network.
export default function OfflinePage() {
  return (
    <section className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight">You&apos;re offline</h1>
      <p className="max-w-sm text-sm text-muted">Reconnect to trade.</p>
      <Link
        href="/"
        className="inline-flex h-11 items-center justify-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-fg"
      >
        Retry
      </Link>
    </section>
  );
}
