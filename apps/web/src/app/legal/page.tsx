import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Legal & Responsible Gaming — Invest254',
  description: 'Invest254 licence, terms of service, responsible gaming commitment and privacy.',
};

const sections = [
  { id: 'responsible-gaming', label: 'Responsible Gaming' },
  { id: 'terms', label: 'Terms of Service' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'licence', label: 'About & Licence' },
] as const;

export default function LegalPage() {
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Legal &amp; Responsible Gaming</h1>
        <p className="text-sm text-muted">
          The rules, your protections, and how we keep play safe. Must be 18+.
        </p>
      </header>

      <div className="flex flex-col gap-8 md:flex-row md:items-start md:gap-10">
        {/* Sticky table of contents on desktop; inline chips on mobile. */}
        <nav
          aria-label="On this page"
          className="md:sticky md:top-20 md:w-56 md:flex-none"
        >
          <ul className="flex flex-wrap gap-2 md:flex-col md:gap-1">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="inline-block rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <Section id="responsible-gaming" title="Responsible Gaming">
            <p>
              Invest254 is a real-money trade-prediction game. It is entertainment, not an income
              source or an investment. Prices move both ways and you can lose your entire stake on
              any trade.
            </p>
            <H3>Our commitments</H3>
            <Ul
              items={[
                'You must be 18 or older to register or play. Underage play is prohibited.',
                'Your real balance is always visible and is held separately from bonus funds.',
                'We never extend credit. You can only ever stake money you have deposited.',
                'You can request a cool-off or self-exclusion at any time (see below).',
              ]}
            />
            <H3>Stay in control</H3>
            <Ul
              items={[
                'Set a budget before you play and treat it as the cost of entertainment.',
                'Never chase losses or bet to recover money you have lost.',
                'Take regular breaks; do not play when stressed, tired, or under the influence.',
                'Do not borrow money to trade.',
              ]}
            />
            <H3>Cool-off &amp; self-exclusion</H3>
            <p>
              To pause your account, email{' '}
              <a className="text-accent hover:underline" href="mailto:support@invest254.co.ke">
                support@invest254.co.ke
              </a>{' '}
              with the subject <strong>“Self-exclusion”</strong> and your registered phone number.
              We will lock deposits and trading for the period you request (or permanently). Pending
              withdrawals are still paid out.
            </p>
            <H3>Get help</H3>
            <p>
              If gambling is affecting your life, free and confidential support is available. Call
              the Kenya gambling helpline on{' '}
              <a className="text-accent hover:underline" href="tel:1190">
                1190
              </a>
              , or reach a counsellor through your nearest health facility. You are not alone.
            </p>
          </Section>

          <Section id="terms" title="Terms of Service">
            <p>
              By creating an account you agree to these terms. If you do not agree, do not use
              Invest254.
            </p>
            <Ul
              items={[
                'Eligibility: you are 18+, legally able to enter a contract, and not in a jurisdiction where this service is prohibited.',
                'Account: one account per person. Keep your password secret; you are responsible for activity on your account.',
                'Fair play: outcomes are determined by the operator\'s authoritative game engine. Manipulation, bots, exploits, or collusion result in closure and forfeiture.',
                'Settlement: trade results, profit and loss, and your balance are decided solely by the server. The on-screen curve is a real-time view of that server truth.',
                'Deposits & withdrawals: handled via M-Pesa. Withdrawals may be reviewed before payout. We may request verification to comply with the law.',
                'Suspension: we may suspend or close accounts for fraud, abuse, or legal reasons.',
                'Changes: we may update these terms; continued use means acceptance of the current version.',
              ]}
            />
          </Section>

          <Section id="privacy" title="Privacy">
            <p>
              We collect only what we need to run your account, process payments, and keep play
              safe and lawful.
            </p>
            <Ul
              items={[
                'Data we hold: your phone number, username, wallet and transaction history, trade history, and device/session data needed for security.',
                'How we use it: to operate the game, process M-Pesa deposits and withdrawals, prevent fraud, and meet legal obligations.',
                'Sharing: with payment and infrastructure providers strictly to deliver the service, and with authorities where the law requires.',
                'Security: passwords are hashed; money records are stored on an immutable ledger; access is restricted and audited.',
                'Your rights: request a copy of your data or account deletion by emailing support@invest254.co.ke (subject to legal retention rules).',
              ]}
            />
          </Section>

          <Section id="licence" title="About &amp; Licence">
            <p>
              Invest254 is a real-money trade-prediction game built for the Kenyan market. Play is
              in Kenyan Shillings (KES) and deposits/withdrawals run over M-Pesa.
            </p>
            <p>
              Gaming operations are intended to be conducted under a licence issued by the Betting
              Control and Licensing Board (BCLB) of Kenya. Operator and licence details are
              published here and must be displayed before commercial launch.
            </p>
            <p className="text-muted">
              Operator: Invest254 Ltd · Licence no.: to be confirmed · Support:{' '}
              <a className="text-accent hover:underline" href="mailto:support@invest254.co.ke">
                support@invest254.co.ke
              </a>
            </p>
          </Section>

          <p className="text-xs text-muted">
            <Link href="/" className="text-accent hover:underline">
              ← Back to trading
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="mb-3 border-b border-border pb-2 text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-fg/90">{children}</div>
    </section>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-2 text-sm font-semibold text-fg">{children}</h3>;
}

function Ul({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-fg/90">
      {items.map((it) => (
        <li key={it}>{it}</li>
      ))}
    </ul>
  );
}
