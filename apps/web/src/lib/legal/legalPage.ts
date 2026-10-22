/**
 * The legal page, as data, in the two registers this platform genuinely has.
 *
 * One deployment serves two kinds of product. A brand whose shell is the MetaTrader terminal is a
 * BROKER: its users are traders, its risk is market risk, and its disclosures are about spreads,
 * stops and position sizing. A brand on the classic or digits shell is a real-money prediction
 * game: its users are players, its risk is gambling harm, and its disclosures are the ones a gaming
 * regulator expects. The two need different words, not the same words with "player" swapped out, so
 * each register is written rather than substituted.
 *
 * It is data rather than markup for three reasons. The page was hard-coded to one brand's name,
 * one brand's support address and one brand's regulator, which is a real fault on a multi-tenant
 * deployment: a MuchWins trader was reading Invest254's terms. It carried a literal placeholder
 * ("Licence no.: to be confirmed") where the brand's own licence line belongs. And the Company tab
 * links into these sections by anchor, so the ids have to be something a caller can ask for rather
 * than guess.
 */

import { registerOf, type Register } from '../ui/register.js';

/** The register is the product's, not the legal page's; lib/ui/register owns it. */
export type LegalRegister = Register;
export { registerOf };

export interface LegalBrand {
  name: string;
  /** The brand's own licence line, or null where it publishes none. */
  licenceLine?: string | null;
  supportEmail?: string | null;
  currency: string;
}

export type LegalBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'ul'; items: readonly string[] }
  /** A paragraph with one mailto in it, so the page can render the link without parsing prose. */
  | { kind: 'contact'; before: string; email: string; after: string }
  /** A paragraph with one tel: in it. Gaming register only: the statutory helpline. */
  | { kind: 'helpline'; before: string; label: string; tel: string; after: string };

export interface LegalSection {
  /** Stable anchor. Callers ask for it rather than hard-coding one. */
  id: string;
  title: string;
  blocks: readonly LegalBlock[];
}

/**
 * The anchor of the risk section, which differs by register: a broker publishes a risk disclosure
 * and a gaming operator a responsible-gaming statement, and neither should be reached under the
 * other's name.
 */
export const riskAnchor = (register: LegalRegister): string =>
  register === 'trading' ? 'risk' : 'responsible-gaming';

/** The page's own title and standfirst. */
export const legalTitle = (register: LegalRegister): { title: string; standfirst: string } =>
  register === 'trading'
    ? {
        title: 'Legal and risk disclosure',
        standfirst: 'The rules, your protections, and what you are taking on when you open a position.',
      }
    : {
        title: 'Legal & Responsible Gaming',
        standfirst: 'The rules, your protections, and how we keep play safe. Must be 18+.',
      };

/** Where to write when the brand publishes no address: its own support, not another brand's. */
const addressOf = (b: LegalBrand): string | null =>
  b.supportEmail && b.supportEmail.trim() ? b.supportEmail.trim() : null;

const contact = (b: LegalBrand, before: string, after: string): LegalBlock => {
  const email = addressOf(b);
  return email === null
    // No address published is said plainly. A mailto to a brand that is not this one would send a
    // trader's account details to a stranger, which is worse than no link.
    ? { kind: 'p', text: `${before} the support channel on your account page${after}` }
    : { kind: 'contact', before, email, after };
};

function tradingSections(b: LegalBrand): LegalSection[] {
  return [
    {
      id: 'risk',
      title: 'Risk disclosure',
      blocks: [
        {
          kind: 'p',
          text: `${b.name} offers leveraged-style short-horizon contracts on synthetic instruments. Trading carries risk: prices move both ways, and you can lose the whole of what you commit to a position. Never trade money you cannot afford to lose.`,
        },
        { kind: 'h3', text: 'What we commit to' },
        {
          kind: 'ul',
          items: [
            'You must be 18 or older to open an account.',
            'The spread is the only cost on a position. There is no commission, no overnight financing and no withdrawal fee on the trade itself.',
            'A Stop Loss or Take Profit is held on our server and checked on every tick, so it protects you whether or not your terminal is open.',
            'Your balance, equity, margin and free margin are on screen at all times, and settled money is never mixed with bonus funds.',
            'We never extend credit. You can only ever commit money you have deposited.',
            'You can request a cool-off or account closure at any time (see below).',
          ],
        },
        { kind: 'h3', text: 'Staying in control' },
        {
          kind: 'ul',
          items: [
            'Decide what you are prepared to lose before you open a position, and size the volume from that and the stop, not from your balance.',
            'Do not widen a stop to avoid taking a loss. The level you chose was your decision; moving it is not a new one.',
            'Do not trade to recover money you have lost.',
            'Do not borrow money to fund an account.',
            'Know what is due on the economic calendar in the next hour before you commit.',
          ],
        },
        { kind: 'h3', text: 'Cool-off and account closure' },
        contact(
          b,
          'To pause your account, write to',
          ' with the subject "Cool-off" and your registered phone number. We will lock deposits and trading for the period you ask for, or permanently. Pending withdrawals are still paid out.',
        ),
        { kind: 'h3', text: 'If trading stops being a decision' },
        {
          kind: 'p',
          text: 'Chasing a loss, trading to feel something, or funding an account with money meant for something else are the signs that this has stopped being a decision and become a compulsion. If any of them is familiar, ask us to close your account and speak to someone. Free and confidential support is available through your nearest health facility.',
        },
      ],
    },
    {
      id: 'terms',
      title: 'Terms of Service',
      blocks: [
        { kind: 'p', text: `By opening an account you agree to these terms. If you do not agree, do not use ${b.name}.` },
        {
          kind: 'ul',
          items: [
            'Eligibility: you are 18 or older, legally able to enter a contract, and not in a jurisdiction where this service is prohibited.',
            'Account: one account per person. Keep your password secret; you are responsible for activity on your account.',
            'Execution: orders are filled at market. You are asking for a fill, not naming a price, and the fill policy is Fill or Kill: an order is executed in full or not at all.',
            'Settlement: a position opens and closes at prices determined by our authoritative pricing engine. The chart is a real-time view of that same server truth, and the result on your screen is the figure we settle on.',
            'Fair dealing: manipulation, automated abuse, exploits or collusion result in closure and forfeiture.',
            `Deposits and withdrawals: handled in ${b.currency} over M-Pesa. Withdrawals may be reviewed before payout, and we may request verification to comply with the law.`,
            'Suspension: we may suspend or close accounts for fraud, abuse, or legal reasons.',
            'Changes: we may update these terms; continued use means acceptance of the current version.',
          ],
        },
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy',
      blocks: [
        { kind: 'p', text: 'We collect only what we need to run your account, process payments, and keep the platform lawful and secure.' },
        {
          kind: 'ul',
          items: [
            'Data we hold: your phone number, username, wallet and transaction history, trade and order history, and the device and session data needed for security.',
            'How we use it: to operate your account, process deposits and withdrawals, prevent fraud, and meet legal obligations.',
            'Sharing: with payment and infrastructure providers strictly to deliver the service, and with authorities where the law requires.',
            'Security: passwords are hashed; money records are stored on an immutable ledger; access is restricted and audited.',
            'Your rights: you can request a copy of your data, or account deletion, subject to legal retention rules.',
          ],
        },
        contact(b, 'To make a request, write to', '.'),
      ],
    },
    {
      id: 'licence',
      title: 'About and licence',
      blocks: [
        { kind: 'p', text: `${b.name} is a trading platform built for the Kenyan market. Accounts are denominated in ${b.currency} and deposits and withdrawals run over M-Pesa.` },
        // The brand's own line, or a plain statement that it publishes none. The page used to print
        // "Licence no.: to be confirmed", which is a placeholder wearing a fact's clothes.
        b.licenceLine && b.licenceLine.trim()
          ? { kind: 'p', text: b.licenceLine.trim() }
          : { kind: 'p', text: `${b.name} publishes no licence details on this page. Ask support for the operator's registration before you deposit.` },
        contact(b, `Operator: ${b.name}. Support:`, '.'),
      ],
    },
  ];
}

function gamingSections(b: LegalBrand): LegalSection[] {
  return [
    {
      id: 'responsible-gaming',
      title: 'Responsible Gaming',
      blocks: [
        { kind: 'p', text: `${b.name} is a real-money trade-prediction game. It is entertainment, not an income source or an investment. Prices move both ways and you can lose your entire stake on any trade.` },
        { kind: 'h3', text: 'Our commitments' },
        {
          kind: 'ul',
          items: [
            'You must be 18 or older to register or play. Underage play is prohibited.',
            'Your real balance is always visible and is held separately from bonus funds.',
            'We never extend credit. You can only ever stake money you have deposited.',
            'You can request a cool-off or self-exclusion at any time (see below).',
          ],
        },
        { kind: 'h3', text: 'Stay in control' },
        {
          kind: 'ul',
          items: [
            'Set a budget before you play and treat it as the cost of entertainment.',
            'Never chase losses or bet to recover money you have lost.',
            'Take regular breaks; do not play when stressed, tired, or under the influence.',
            'Do not borrow money to trade.',
          ],
        },
        { kind: 'h3', text: 'Cool-off and self-exclusion' },
        contact(
          b,
          'To pause your account, write to',
          ' with the subject "Self-exclusion" and your registered phone number. We will lock deposits and trading for the period you request (or permanently). Pending withdrawals are still paid out.',
        ),
        { kind: 'h3', text: 'Get help' },
        {
          kind: 'helpline',
          before: 'If gambling is affecting your life, free and confidential support is available. Call the Kenya gambling helpline on',
          label: '1190',
          tel: '1190',
          after: ', or reach a counsellor through your nearest health facility. You are not alone.',
        },
      ],
    },
    {
      id: 'terms',
      title: 'Terms of Service',
      blocks: [
        { kind: 'p', text: `By creating an account you agree to these terms. If you do not agree, do not use ${b.name}.` },
        {
          kind: 'ul',
          items: [
            'Eligibility: you are 18+, legally able to enter a contract, and not in a jurisdiction where this service is prohibited.',
            'Account: one account per person. Keep your password secret; you are responsible for activity on your account.',
            "Fair play: outcomes are determined by the operator's authoritative game engine. Manipulation, bots, exploits, or collusion result in closure and forfeiture.",
            'Settlement: trade results, profit and loss, and your balance are decided solely by the server. The on-screen curve is a real-time view of that server truth.',
            `Deposits and withdrawals: handled in ${b.currency} over M-Pesa. Withdrawals may be reviewed before payout. We may request verification to comply with the law.`,
            'Suspension: we may suspend or close accounts for fraud, abuse, or legal reasons.',
            'Changes: we may update these terms; continued use means acceptance of the current version.',
          ],
        },
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy',
      blocks: [
        { kind: 'p', text: 'We collect only what we need to run your account, process payments, and keep play safe and lawful.' },
        {
          kind: 'ul',
          items: [
            'Data we hold: your phone number, username, wallet and transaction history, trade history, and device/session data needed for security.',
            'How we use it: to operate the game, process M-Pesa deposits and withdrawals, prevent fraud, and meet legal obligations.',
            'Sharing: with payment and infrastructure providers strictly to deliver the service, and with authorities where the law requires.',
            'Security: passwords are hashed; money records are stored on an immutable ledger; access is restricted and audited.',
            'Your rights: request a copy of your data or account deletion, subject to legal retention rules.',
          ],
        },
        contact(b, 'To make a request, write to', '.'),
      ],
    },
    {
      id: 'licence',
      title: 'About and licence',
      blocks: [
        { kind: 'p', text: `${b.name} is a real-money trade-prediction game built for the Kenyan market. Play is in ${b.currency} and deposits and withdrawals run over M-Pesa.` },
        {
          kind: 'p',
          text: 'Gaming operations are conducted under a licence issued by the Betting Control and Licensing Board (BCLB) of Kenya.',
        },
        b.licenceLine && b.licenceLine.trim()
          ? { kind: 'p', text: b.licenceLine.trim() }
          : { kind: 'p', text: `${b.name} publishes no licence details on this page. Ask support for the operator's registration before you deposit.` },
        contact(b, `Operator: ${b.name}. Support:`, '.'),
      ],
    },
  ];
}

export function legalSections(register: LegalRegister, brand: LegalBrand): LegalSection[] {
  return register === 'trading' ? tradingSections(brand) : gamingSections(brand);
}
