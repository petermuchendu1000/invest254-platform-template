/**
 * The broker's own page, behind MetaTrader's Company tab.
 *
 * MetaQuotes: *"A broker may choose to show a useful web resource here, for example a support
 * website. Any link added here opens in a separate web browser window. This tab is hidden if the
 * web page is disabled by the broker."* (docs/mt5/09-toolbox.md 7.9.) It is the one tab MetaTrader
 * hides rather than disables, and the one tab whose content is entirely the broker's.
 *
 * So this is not a grid and not a feed: it is this brand's own identity, licence, deposit currency
 * and support channels, read off the `sites` row the whole app is skinned from, with links out to
 * the pages the brand genuinely publishes. Nothing here is written into the file — a second brand
 * on this deployment shows its own details, which is the only way a multi-tenant Company tab can
 * be honest.
 *
 * And MetaTrader's hiding rule is implemented rather than hard-coded: a brand that publishes no
 * licence line, no support email and no support number has no company page, so the tab is not
 * drawn. That is `published` below, and it is why this lives in a module with a test rather than
 * as a boolean in the tab table.
 */

import { riskAnchor } from '../legal/legalPage.js';

export interface CompanyBrand {
  name: string;
  wordmarkText?: string | null;
  licenceLine?: string | null;
  supportEmail?: string | null;
  supportWhatsapp?: string | null;
  currency: string;
  locale: string;
}

export interface CompanyLink {
  label: string;
  /** Absolute `mailto:`/`https:` or an in-app path. Every one of them opens in a new window. */
  href: string;
  /** What the trader gets by following it, written out rather than left to the label. */
  note: string;
}

export interface CompanyField {
  label: string;
  value: string;
}

export interface CompanyPage {
  /** False when the brand publishes nothing, which is when MetaTrader hides the tab. */
  published: boolean;
  /** The brand's trading name, as the terminal's own wordmark writes it. */
  title: string;
  /** The licence line the brand publishes, or null where it publishes none. */
  licence: string | null;
  fields: readonly CompanyField[];
  support: readonly CompanyLink[];
  resources: readonly CompanyLink[];
}

/**
 * E.164 digits only. A stored number may carry the `+`, spaces or dashes a human would type, and
 * `wa.me` accepts neither, so the link is built from the digits and the display keeps the `+`.
 */
const waDigits = (n: string): string => n.replace(/\D+/g, '');

export function companyPage(
  brand: CompanyBrand,
  /**
   * The trade server this account is on, as `mt5ServerName` builds it (`MuchWins-Live09`). It is
   * passed in rather than derived here because it depends on the ACCOUNT's mode, not the brand:
   * the same brand prints `-Demo` for a demo account and `-LiveNN` for a real one.
   */
  opts: { server?: string | null } = {},
): CompanyPage {
  const licence = brand.licenceLine?.trim() ? brand.licenceLine.trim() : null;
  const email = brand.supportEmail?.trim() ? brand.supportEmail.trim() : null;
  const wa = brand.supportWhatsapp?.trim() ? waDigits(brand.supportWhatsapp) : '';

  const support: CompanyLink[] = [];
  if (email) {
    support.push({
      label: email,
      href: `mailto:${email}`,
      note: 'Account, deposit and withdrawal questions. Quote the ticket for anything about a trade.',
    });
  }
  if (wa) {
    support.push({
      label: `+${wa}`,
      href: `https://wa.me/${wa}`,
      note: 'WhatsApp, for the fastest answer during trading hours.',
    });
  }

  /**
   * The pages this brand publishes. These are real routes in this deployment, not a list of links
   * a broker might have: `/legal` carries all four sections under these anchors.
   */
  const resources: readonly CompanyLink[] = [
    { label: 'Terms of Service', href: '/legal#terms', note: 'The agreement every account trades under.' },
    { label: 'Privacy', href: '/legal#privacy', note: 'What is held about you, and for how long.' },
    { label: 'Licence', href: '/legal#licence', note: 'Who operates this platform and under what authority.' },
    // The anchor comes from the legal module rather than being written here: a terminal brand
    // publishes a risk disclosure, not a responsible-gaming statement, and the two have different
    // ids so neither is reached under the other's name.
    { label: 'Risk disclosure', href: `/legal#${riskAnchor('trading')}`, note: 'What you are taking on, and how to pause the account.' },
  ];

  return {
    // The name alone is not a company page: every brand has one, and a tab carrying nothing but the
    // name is the empty tab MetaTrader hides.
    published: licence !== null || support.length > 0,
    title: brand.wordmarkText?.trim() ? brand.wordmarkText.trim() : brand.name,
    licence,
    fields: [
      { label: 'Trading name', value: brand.name },
      // The server the account strip and the Funds screen already name, so the Company page agrees
      // with them rather than being a second, separate account of who you are connected to.
      ...(opts.server ? [{ label: 'Trade server', value: opts.server }] : []),
      { label: 'Deposit currency', value: brand.currency },
      { label: 'Region', value: brand.locale },
      // Every grid in the terminal stamps UTC, so a trader reconciling a fill against a release
      // does not have to convert anything. Saying so is part of knowing who you are trading with.
      { label: 'Server time', value: 'UTC' },
    ],
    support,
    resources,
  };
}
