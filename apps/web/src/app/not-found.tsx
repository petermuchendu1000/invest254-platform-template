import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <section className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <span className="text-5xl font-bold tracking-tight text-accent">404</span>
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <Link
        href="/"
        className="inline-flex h-11 items-center justify-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-fg"
      >
        Back to trading
      </Link>
    </section>
  );
}
