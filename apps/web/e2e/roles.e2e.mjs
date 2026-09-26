// docs/42 role-matrix UI e2e — drives the PRODUCTION web build (`next start`) in headless Chromium as each
// operator tier (incl. impersonation and a second tab), with the API mocked at the network layer, and
// asserts what each tier SEES: nav entries, page gates and key controls. It proves the capability list
// (packages/shared/src/capabilities.ts) is what the screens actually render, on the token role.
//
// Run:  WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/roles.e2e.mjs
//   (build with NEXT_PUBLIC_API_BASE_URL=http://api.e2e.test/api/v1, then `next start -p 3100`;
//    needs `playwright-core` resolvable and Chromium at PLAYWRIGHT_BROWSERS_PATH / CHROMIUM_PATH.)
import { chromium } from 'playwright-core';

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3100';
const API = 'http://api.e2e.test/api/v1';
const SITE = '00000000-0000-0000-0000-000000000001';
const PLATFORM = '10000000-0000-0000-0000-000000000001';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64u({ alg: 'HS256' })}.${b64u({ iat: 1, exp: 9999999999, ...payload })}.sig`;

const T = {
  admin: jwt({ sub: 'u-admin', role: 'admin', site: SITE }),
  owner: jwt({ sub: 'u-owner', role: 'platform_superadmin', site: SITE }),
  pa: jwt({ sub: 'u-pa', role: 'platform_admin', site: SITE, platform: PLATFORM }),
  ownerImp: jwt({ sub: 'u-owner', role: 'admin', site: SITE, act: { sub: 'u-owner', role: 'platform_superadmin', brand: 'Tamu Traders' } }),
  paImp: jwt({ sub: 'u-pa', role: 'admin', site: SITE, act: { sub: 'u-pa', role: 'platform_admin', brand: 'Tamu Traders' } }),
  player: jwt({ sub: 'u-player', role: 'player', site: SITE }),
};
const ME = {
  admin: { userId: 'u-admin', role: 'admin', username: 'siteadmin', phone: '254700000001', scope: { site: { id: SITE, name: 'Tamu Traders' }, platform: null } },
  owner: { userId: 'u-owner', role: 'platform_superadmin', username: 'owner', phone: '254700000002' },
  player: { userId: 'u-player', role: 'player', username: 'punter', phone: '254700000009' },
  pa: { userId: 'u-pa', role: 'platform_admin', username: 'platadmin', phone: '254700000003', scope: { site: { id: SITE, name: 'Tamu Traders' }, platform: { id: PLATFORM, name: 'Alpha Platform' } } },
};
const USER = {
  userId: 'u-target', username: 'target', phone: '254711111111', role: 'player', status: 'active', createdAtMs: 1,
  realBalanceCents: 0, bonusBalanceCents: 0, demoBalanceCents: 0, isMarketer: false, depositsCents: 0, withdrawalsCents: 0,
  netDepositsCents: 0, lastFundedCents: null, turnoverCents: 0, ggrCents: 0, betCount: 0, lastTxAtMs: null, lastTxKind: null,
  lastTxAmountCents: null, lastTxStatus: null, lastActiveAtMs: null, referredBy: null, isBrandDefaultMarketer: false,
};

const REFERRAL = { referralCode: 'K7PQ2MX', referralPath: '/r/K7PQ2MX', isMarketer: false, totalReferrals: 0, earnedCents: 0,
  heldCents: 0, paidCents: 0, availableCents: 0, minPayoutCents: 50000, marketerEarnedCents: 0 };

// docs/42 UI-9 fixtures (owner console)
const OTHER_PLATFORM = '20000000-0000-0000-0000-000000000002';
const PLATFORMS = [
  { platformId: PLATFORM, slug: 'alpha', name: 'Alpha Platform', status: 'active', ownerUserId: null, notes: null },
  { platformId: OTHER_PLATFORM, slug: 'beta', name: 'Beta Platform', status: 'active', ownerUserId: null, notes: null },
];
const SITE_ROW = {
  siteId: SITE, slug: 'tamu', name: 'Tamu Traders', status: 'active', primaryDomain: 'tamu.test', logoUrl: null, faviconUrl: null,
  wordmarkText: 'Tamu', colorPrimary: '#3861FB', colorBg: '#0a0a0a', colorAccent: '#06b6d4', theme: 'dark', currency: 'KES', locale: 'en-KE',
  chartStyle: 'classic', tradeUi: 'classic', licenceLine: null, supportEmail: null, legalCopy: null, ownerUserId: null,
  config: { houseEdge: 0.05, maxMultiplier: 5, minStakeCents: 100, maxStakeCents: 100000, minWithdrawalCents: 1000, defaultDurationS: 10,
    tickRateMs: 150, driftBias: 0.3, volatility: 1, targetWinRate: 0.4, version: 1 },
};
const TICKET = { id: 't-1', platformId: PLATFORM, siteId: SITE, createdBy: 'u-admin', createdByRole: 'admin', subject: 'Payouts stuck',
  body: 'B2C failing', urgency: 'high', status: 'open', escalationLevel: 0, assigneeRole: 'platform_admin', slaDueAtMs: Date.now() + 3600e3,
  firstResponseAtMs: null, resolvedAtMs: null, resolvedBy: null, closedAtMs: null, createdAtMs: 1, updatedAtMs: 1 };
const ADDONS = [
  { category: 'chart', key: 'classic', display_name: 'Classic chart', description: 'The free line.', price_cents: 0, billing_type: 'free', setup_fee_cents: 0, is_default: true, offered: true, entitled: true, granted_at: null, active: true, pending: false, request_id: null, requested_at: null, request_note: null },
  { category: 'chart', key: 'pro', display_name: 'Pro chart', description: 'Candles for pros.', price_cents: 500000, billing_type: 'one_off', setup_fee_cents: 0, is_default: false, offered: true, entitled: false, granted_at: null, active: false, pending: false, request_id: null, requested_at: null, request_note: null },
  { category: 'chart', key: 'area', display_name: 'Area graph', description: 'A filled area.', price_cents: 300000, billing_type: 'monthly', setup_fee_cents: 100000, is_default: false, offered: true, entitled: false, granted_at: null, active: false, pending: true, request_id: 9, requested_at: new Date().toISOString(), request_note: 'Players asked' },
  { category: 'trade_ui', key: 'deriv', display_name: 'Deriv UI', description: 'Digits.', price_cents: 0, billing_type: 'free', setup_fee_cents: 0, is_default: false, offered: true, entitled: true, granted_at: null, active: false, pending: false, request_id: null, requested_at: null, request_note: null },
];
const ADDON_REQ = { id: 9, site_id: SITE, slug: 'tamu', name: 'Tamu Traders', platform_id: PLATFORM, platform_name: 'Alpha Platform', category: 'chart', key: 'area',
  display_name: 'Area graph', status: 'requested', price_cents: 300000, billing_type: 'monthly', setup_fee_cents: 100000, note: 'Players asked',
  decision_note: null, created_at: new Date().toISOString(), requested_by: 'u-admin', requested_by_name: 'siteadmin', decided_by: null, decided_by_name: null, decided_at: null };
const CATALOG = [
  { category: 'chart', key: 'classic', display_name: 'Classic chart', description: 'The free line.', price_cents: 0, billing_type: 'free', setup_fee_cents: 0, is_default: true, active: true, sort_order: 1, brands: 2, in_use: 1, pending: 0 },
  { category: 'chart', key: 'pro', display_name: 'Pro chart', description: 'Candles for pros.', price_cents: 500000, billing_type: 'one_off', setup_fee_cents: 0, is_default: false, active: true, sort_order: 2, brands: 1, in_use: 1, pending: 0 },
  { category: 'chart', key: 'area', display_name: 'Area graph', description: 'A filled area.', price_cents: 300000, billing_type: 'monthly', setup_fee_cents: 100000, is_default: false, active: true, sort_order: 3, brands: 2, in_use: 0, pending: 1 },
  { category: 'trade_ui', key: 'classic', display_name: 'Classic terminal', description: 'Rise/fall.', price_cents: 0, billing_type: 'free', setup_fee_cents: 0, is_default: true, active: true, sort_order: 1, brands: 2, in_use: 2, pending: 0 },
  { category: 'trade_ui', key: 'deriv', display_name: 'Deriv UI', description: 'Digits.', price_cents: 0, billing_type: 'free', setup_fee_cents: 0, is_default: false, active: true, sort_order: 2, brands: 1, in_use: 0, pending: 0 },
];
const FIXTURES = {
  '/platform/platforms': { platforms: PLATFORMS },
  '/platform/sites': { sites: [SITE_ROW] },
  '/platform/platform-admins': { admins: [{ userId: 'u-alice', username: 'alice', phone: '254711000001', status: 'active', platformId: PLATFORM,
    platformName: 'Alpha Platform', homeSiteId: SITE, homeSiteName: 'Tamu Traders', createdAtMs: 1 }] },
  '/platform/users/search': { users: [
    { userId: 'u-bob', username: 'bobkamau', phone: '254722333444', role: 'admin', status: 'active', siteId: SITE, siteName: 'Tamu Traders', platformId: PLATFORM, platformName: 'Alpha Platform', isDefaultMarketer: false },
    { userId: 'u-dm', username: 'bobdefault', phone: '254722333555', role: 'marketer', status: 'active', siteId: SITE, siteName: 'Tamu Traders', platformId: PLATFORM, platformName: 'Alpha Platform', isDefaultMarketer: true },
  ] },
  '/tickets': { tickets: [TICKET] },
  '/tickets/t-1': { ticket: TICKET, comments: [], escalations: [] },
  '/addons/brand': { items: ADDONS },
  '/addons/requests': { requests: [ADDON_REQ] },
  '/addons/catalog': { items: CATALOG },
  '/addons/brands': { brands: [{ site_id: SITE, name: 'Tamu Traders', slug: 'tamu', status: 'active', platform_id: PLATFORM, platform_name: 'Alpha Platform',
    chart_style: 'pro', trade_ui: 'classic', owned: ['chart:classic', 'chart:pro', 'trade_ui:deriv'], pending: 1 }] },
  [`/platform/sites/${SITE}/users`]: { items: [USER] },
  [`/platform/sites/${SITE}/users/u-target`]: { ...USER, realBalanceCents: 50000, bonusBalanceCents: 2000, depositsCents: 100000, turnoverCents: 300000, betCount: 12, createdAtMs: 1 },
  [`/platform/sites/${SITE}/users/u-target/overrides`]: { userId: 'u-target', winRate: null, houseEdge: null, tradeDurationS: null, maxWinMultiplier: null,
    minStakeCents: null, maxStakeCents: null, notes: null, updatedBy: null, updatedAtMs: null },
  '/platform/audit-log': { items: [{ id: '9', actorId: 'u-admin', actorRole: 'admin', actorUsername: 'siteadmin', action: 'user.set_status',
    targetType: 'user', targetId: 'u-target', detail: { status: 'suspended' }, createdAtMs: Date.now() - 60000, siteId: SITE, siteName: 'Tamu Traders' }], nextCursor: null },
  '/platform/payment-scopes': { platformId: PLATFORM, scopes: [
    { scopeType: 'platform', scopeId: PLATFORM, name: 'Alpha Platform', active: false, payoutsEnabled: true, activatedAtMs: null },
    { scopeType: 'site', scopeId: SITE, name: 'Tamu Traders', active: false, payoutsEnabled: true, activatedAtMs: null }] },
  [`/platform/payment-scopes/platform/${PLATFORM}`]: {
    scope: { type: 'platform', id: PLATFORM },
    state: { scopeType: 'platform', scopeId: PLATFORM, name: 'Alpha Platform', active: false, payoutsEnabled: true, activatedAtMs: null },
    schemas: {
      mpesa: { code: 'mpesa', displayName: 'M-Pesa (Daraja)', docsUrl: '', blurb: 'Your own Daraja app', playerAvailable: true, fields: [
        { key: 'environment', label: 'Environment', kind: 'select', secret: false, required: true, options: [{ value: 'production', label: 'Production (live money)' }] },
        { key: 'shortcode', label: 'Business shortcode', kind: 'text', secret: false, required: true, group: 'Deposits (STK)' },
        { key: 'consumer_key', label: 'Consumer key', kind: 'secret', secret: true, required: true, group: 'App credentials' },
        { key: 'passkey', label: 'Lipa na M-Pesa passkey', kind: 'secret', secret: true, required: false, group: 'Deposits (STK)' }] },
    },
    configs: { mpesa: { providerCode: 'mpesa', scopeType: 'platform', scopeId: PLATFORM, settings: { environment: 'production', shortcode: '600111' },
      secretMeta: { consumer_key: { set: true, last4: '1234' } }, hasSecret: true, updatedAt: null, exists: true } },
    status: { mpesa: { configured: true, depositsReady: true, payoutsReady: false, missing: ['b2cInitiator', 'b2cSecurityCredential'] } },
  },
  '/platform/global-config': { config: { depositsEnabled: true, withdrawalsEnabled: true, playEnabled: true, marketersEnabled: true, registrationsEnabled: true,
    maintenanceMessage: null, globalDailyPoolCents: 100000000, playerEconomy: {}, marketerEconomy: {}, payments: {}, version: 3, updatedAt: null } },
  // UI-D fixtures
  '/platform/payment-providers/config': { providers: [
    { code: 'megapay', schema: { code: 'megapay', displayName: 'Mega Pay', docsUrl: 'https://megapay.test', blurb: 'M-Pesa STK deposit rail via Mega Pay. Both the API key and the account email travel in every request.', playerAvailable: true, fields: [] },
      config: { providerCode: 'megapay', settings: {}, secretMeta: {}, hasSecret: false, exists: false, updatedAt: null } },
    { code: 'paystack', schema: { code: 'paystack', displayName: 'Paystack', docsUrl: 'https://paystack.test', blurb: 'Signs webhooks (HMAC-SHA512).', playerAvailable: false, fields: [] },
      config: { providerCode: 'paystack', settings: {}, secretMeta: {}, hasSecret: false, exists: false, updatedAt: null } }] },
  '/platform/payment-providers': { providers: [{ code: 'megapay', displayName: 'Mega Pay', enabledGlobal: false, sortOrder: 1 }], overrides: [] },
  // POOL-1 fixtures
  '/platform/pool/overview': { platformId: PLATFORM, brands: [
    { siteId: SITE, name: 'Tamu Traders', slug: 'tamu', platformId: PLATFORM, platformName: 'Alpha Platform', poolMode: true, withdrawalsEnabled: true,
      defaultCents: 500000, todayCents: 500000, paidCents: 200000, reservedCents: 50000, availableCents: 250000, todaySet: true, pendingCount: 2,
      pendingCents: 30000, paid7dCents: 900000, lastChangedAtMs: Date.now() - 3600e3 },
    { siteId: 'site-2', name: 'Simba FX', slug: 'simba', platformId: PLATFORM, platformName: 'Alpha Platform', poolMode: true, withdrawalsEnabled: false,
      defaultCents: 100000, todayCents: 100000, paidCents: 100000, reservedCents: 0, availableCents: 0, todaySet: true, pendingCount: 0,
      pendingCents: 0, paid7dCents: 100000, lastChangedAtMs: null }] },
  '/platform/pool/auto-settings': { settings: { platformId: PLATFORM, mode: 'dynamic', dailyTotalCents: null, lookbackDays: 14, isDefault: true,
    lastRunAtMs: Date.now() - 7200e3, lastRunOk: true, lastRunMessage: 'Split KES 6,000 across 2 brand(s) by demand.', updatedAtMs: null } },
  '/platform/pool/distributions': { distributions: [{ id: 7, totalCents: 600000, mode: 'per_site', siteCount: 2, perSite: { [SITE]: 500000, 'site-2': 100000 },
    createdAt: new Date(Date.now() - 7200e3).toISOString(), source: 'auto' }] },
  '/platform/pool/auto-run': { run: { platformId: PLATFORM, mode: 'dynamic', ok: true, message: 'Split KES 6,000 across 2 brand(s) by demand.', totalCents: 600000, brands: 2 } },
  // PAY-2 fixtures
  '/admin/mpesa-config': { environment: 'production', shortcode: '600111', stkCallbackUrl: '', b2cInitiator: 'op', b2cResultUrl: '', b2cTimeoutUrl: '',
    hasConsumerKey: true, hasConsumerSecret: true, hasPasskey: true, hasSecurityCredential: false, transactionType: 'paybill', tillNumber: '',
    b2cShortcode: '', b2cCommandId: 'BusinessPayment', updatedBy: null, updatedAtMs: null },
  '/admin/c2b-config': { enabled: true, shortcode: '600999', accountNumber: 'TRIO', businessName: 'Trio Ltd', instructions: '',
    confirmationUrl: 'https://api.e2e.test/api/v1/deposits/c2b/confirmation', validationUrl: '', responseType: 'Completed',
    registeredAtMs: null, registeredShortcode: null, registeredConfirmationUrl: null, lastRegisterAtMs: null, lastRegisterOk: null,
    lastRegisterMessage: null, received7d: 3, unclaimed: 1, lastReceivedAtMs: Date.now() - 600000, updatedAtMs: null, registrationCurrent: false },
  // UI-C fixtures (brand back office pages)
  '/admin/withdrawals': { items: [{ txId: 'w-1', userId: 'u-target', username: 'wanjiku_long_username', phone: '0712345678', amountCents: 158000, status: 'pending',
    provider: 'mpesa', mpesaReceipt: null, createdAtMs: Date.now() - 3600e3, updatedAtMs: null, balanceCents: 2207000, totalDepositsCents: 746000,
    depositCount: 4, totalWithdrawalsCents: 0, withdrawalCount: 0, firstDepositAtMs: Date.now() - 20 * 86400e3 }], nextCursor: null },
  '/admin/notification-templates': { items: [{ key: 'announcement', level: 'info', title: 'Announcement', body: 'We have an update to share with you.',
    dismissible: true, category: 'announcement', resolvesCategory: null, defaultAudience: {}, description: 'Generic announcement. Edit the title and body before sending.' }] },
  '/admin/notifications/audience-count': { count: 22 },
  '/admin/overview': { users: { total: 24, active: 23, suspended: 1, banned: 0, players: 20, marketers: 2, admins: 2 },
    finance: { depositsCents: 0, withdrawalsCents: 0, internalTransfersCents: 0, pendingWithdrawals: 1, walletLiabilityCents: 0 },
    affiliate: { marketers: 2, commissionAccruedCents: 0, commissionPaidCents: 0, pendingPayouts: 0 },
    game: { settledPositions: 0, turnoverCents: 0, ggrCents: 0 }, marketer: { accounts: 2, creditedCents: 0, turnoverCents: 0, ggrCents: 0, walletLiabilityCents: 0 } },
  '/admin/rtp': { targetRtp: 0.95, toleranceAbs: 0.05, minSamples: 100, alert: false, windows: [] },
  '/admin/real-cash-rtp': { rtpTarget: 0.95, windows: [] },
  '/admin/config-review': [],
  '/admin/reports/daily': { items: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    depositsCents: 100000 + i * 1000, withdrawalsCents: i >= 25 ? 50000 : 0, turnoverCents: 0, ggrCents: 0 })) },
  '/platform/registrar/config': { platformId: PLATFORM, providerCode: 'namecheap', settings: {}, secretMeta: {}, hasSecret: false, encVersion: 1,
    updatedAt: null, exists: false, egressIp: '203.0.113.7', encryptionConfigured: true },
};


// BILL-1 fixtures
const DAY = 86400e3;
const INV_SUM = { id: 'inv-1', number: 'TRIO-2026-00007', platformId: PLATFORM, platformName: 'Alpha Platform', kind: 'renewal', status: 'open',
  issuedAt: new Date(Date.now() - 12 * DAY).toISOString(), dueAt: new Date(Date.now() - 5 * DAY).toISOString(),
  periodStart: new Date(Date.now() - 12 * DAY).toISOString(), periodEnd: new Date(Date.now() + 18 * DAY).toISOString(),
  totalCents: 4500000, amountPaidCents: 0, amountDueCents: 4500000, overdue: true, paidAt: null };
const INV_PAID = { ...INV_SUM, id: 'inv-0', number: 'TRIO-2026-00003', status: 'paid', dueAt: new Date(Date.now() - 35 * DAY).toISOString(),
  issuedAt: new Date(Date.now() - 42 * DAY).toISOString(), amountPaidCents: 4000000, totalCents: 4000000, amountDueCents: 0, overdue: false, paidAt: new Date(Date.now() - 36 * DAY).toISOString() };
const SELLER = { name: 'TrioCodes Ltd', address: 'Nairobi', taxPin: 'P051234567X', email: 'billing@triocodes.com', phone: '', taxLabel: 'VAT',
  paymentInstructions: 'Bank: KCB 1234567890', footerNote: 'Thank you.', mpesaPayEnabled: true };
const INVOICE = { ...INV_SUM, currency: 'KES', planKey: 'business', subtotalCents: 4500000, taxRateBp: 0, taxCents: 0, voidedAt: null, statusReason: null, notes: null,
  lines: [{ id: 'l1', kind: 'plan', description: 'Business plan', siteId: null, siteName: null, quantity: 1, unitCents: 4000000, amountCents: 4000000, periodStart: INV_SUM.periodStart, periodEnd: INV_SUM.periodEnd },
    { id: 'l2', kind: 'addon_monthly', description: 'Area graph — Tamu Traders', siteId: SITE, siteName: 'Tamu Traders', quantity: 1, unitCents: 500000, amountCents: 500000, periodStart: INV_SUM.periodStart, periodEnd: INV_SUM.periodEnd }],
  payments: [], seller: SELLER };
const ACCOUNT = { platformId: PLATFORM, platformName: 'Alpha Platform', platformSlug: 'alpha', planKey: 'business', planName: 'Business', priceCents: 4000000,
  customPrice: false, billingPeriod: 'month', status: 'grace_period', billingExempt: false, trialEndsAt: null,
  currentPeriodStart: INV_SUM.periodStart, currentPeriodEnd: INV_SUM.periodEnd, graceEndsAt: new Date(Date.now() + 2 * DAY).toISOString(),
  lastPaymentAt: INV_PAID.paidAt, nextInvoiceAt: INV_SUM.periodEnd, monthlyAddonsCents: 500000, pendingChargesCents: 0,
  balanceDueCents: 4500000, overdueCents: 4500000, openInvoices: 1, maxSites: 5, maxUsers: 1000, sites: 2, users: 812 };
const BILL_PLANS = [
  { key: 'starter', name: 'Starter', priceCents: 100000, maxSites: 1, maxUsers: 100, billingPeriod: 'month', isCustom: false, active: true, sort: 1, platforms: 0 },
  { key: 'business', name: 'Business', priceCents: 4000000, maxSites: 5, maxUsers: 1000, billingPeriod: 'month', isCustom: false, active: true, sort: 2, platforms: 1 },
  { key: 'enterprise', name: 'Enterprise', priceCents: null, maxSites: null, maxUsers: null, billingPeriod: 'month', isCustom: true, active: true, sort: 3, platforms: 1 },
];
Object.assign(FIXTURES, {
  '/platform/billing/accounts': { accounts: [ACCOUNT] },
  '/platform/billing/invoices': { invoices: [INV_SUM, INV_PAID] },
  '/platform/billing/invoices/inv-1': INVOICE,
  '/platform/billing/invoices/inv-1/pay': { paymentId: 'pay-1', amountCents: 4500000, invoiceNumber: 'TRIO-2026-00007', checkoutRequestId: 'ws_CO_1' },
  '/platform/billing/invoices/inv-1/payments': INVOICE,
  '/platform/billing/charges': { charges: [] },
  '/platform/billing/plans': { plans: BILL_PLANS },
  '/platform/billing/settings': { businessName: 'TrioCodes Ltd', businessAddress: 'Nairobi', taxPin: '', billingEmail: '', billingPhone: '', invoicePrefix: 'TRIO',
    nextNumber: 8, daysUntilDue: 7, taxRateBp: 0, taxLabel: 'VAT', paymentInstructions: 'Bank: KCB 1234567890', mpesaPayEnabled: true, footerNote: '',
    trialDays: 3, pastDueDays: 3, graceDays: 5, updatedAt: null },
  '/platform/billing/overview': { mrrCents: 4500000, arrCents: 54000000, outstandingCents: 4500000, overdueCents: 4500000, collectedThisMonthCents: 0,
    collectedLastMonthCents: 4000000, aging: { current: 0, d1_30: 4500000, d31_60: 0, d61_90: 0, d90p: 0 }, statusCounts: { grace_period: 1 },
    upcoming: [], recentPayments: [{ id: 'p0', invoiceId: 'inv-0', number: 'TRIO-2026-00003', platformName: 'Alpha Platform', method: 'mpesa', amountCents: 4000000, reference: 'QK12AB', settledAt: INV_PAID.paidAt }] },
  '/platform/billing/run': { issued: 1, transitions: 0, reminders: 2 },
  [`/platform/subscriptions/${PLATFORM}/events`]: { events: [] },
});

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? `  -- ${detail}` : ''}`); };

async function session(browser, { token, me, stash = null, viewport = null, fixtures = {} }) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const calls = [];
  const full = [];   // method + path + query (UI-9: which platform a request acts for)
  const bodies = []; // [method path, parsed JSON body] of writes (UI-10: what a confirm actually sent)
  await ctx.route(`${API}/**`, async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    const path = u.pathname.replace('/api/v1', '');
    calls.push(`${req.method()} ${path}`);
    full.push(`${req.method()} ${path}${u.search}`);
    if (req.method() !== 'GET') { let b = null; try { b = req.postDataJSON(); } catch { /* none */ } bodies.push([`${req.method()} ${path}`, b]); }
    const body = path === '/auth/me' ? me
      : path === '/me/referral' ? REFERRAL
      : fixtures[path] ? fixtures[path]
      : FIXTURES[path] ? FIXTURES[path]
      : /^\/admin\/users\/[^/]+$/.test(path) ? USER
      : { items: [], sites: [], platforms: [], statuses: {}, configured: false, key: null, enabled: true };
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await ctx.addInitScript(([tok, st]) => {
    localStorage.setItem('pp-session', JSON.stringify({ state: { token: tok }, version: 0 }));
    if (st) sessionStorage.setItem('pp-impersonating-brand', st);
  }, [token, stash]);
  const page = await ctx.newPage();
  return { ctx, page, calls, full, bodies };
}
async function navTexts(page) {
  await page.waitForTimeout(300);
  return (await page.locator('aside a, nav a').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
}
async function open(page, path) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  // 1) Site admin
  { const { ctx, page, calls } = await session(browser, { token: T.admin, me: ME.admin });
    await open(page, '/admin/tickets'); const nav = await navTexts(page);
    check('site admin: operations nav present', nav.includes('Withdrawals') && nav.includes('Users'), nav.join('|'));
    check('site admin: the shell names the brand (UI-8)', await page.locator('aside').getByText('Tamu Traders', { exact: true }).isVisible() && await page.locator('aside').getByText('Brand admin', { exact: true }).first().isVisible());
    check('site admin: NO Audit log / Governance / Platform nav', !nav.some((n) => /Audit log|Game config|M-Pesa|Fly\.io|All brands|System logs/.test(n)), nav.join('|'));
    await open(page, '/admin/audit');
    check('UI-F site admin: old /admin/audit goes back to the back-office home (was: a console 404)', page.url().endsWith('/admin'), page.url());
    check('site admin: no audit request was ever made', !calls.includes('GET /admin/audit'), calls.filter((c) => c.includes('audit')).join());
    await open(page, '/admin/game');
    check('UI-F site admin: old /admin/game goes back to the back-office home (was: a console 404)', page.url().endsWith('/admin'), page.url());
    await open(page, '/admin/users/u-target');
    check('site admin: "Edit details" and "Role" sections visible', await page.getByText('Edit details', { exact: true }).isVisible().catch(() => false) && await page.getByText('Role', { exact: true }).first().isVisible().catch(() => false));
    check('site admin: overrides are read-only (no Save overrides)', !(await page.getByText('Save overrides').isVisible().catch(() => false)));
    check('UI-F user page: marketer money is not repeated here (lives in Marketer payouts)', (await page.getByText('Marketer expenses & advances').count()) === 0);
    check('UI-F user page: brand admins are not appointed from here (console → People)', (await page.locator('option[value="admin"]').count()) === 0);
    await open(page, '/admin/users?status=suspended');
    check('UI-F users: a ?status= deep link pre-selects the quick filter', await page.getByRole('button', { name: /^Suspended/ }).getAttribute('aria-pressed').then((v) => v === 'true').catch(() => false));
    check('UI-F users: one way to open a person (the name), no separate Manage column', (await page.getByRole('columnheader', { name: 'Manage' }).count()) === 0);
    await open(page, '/platform');
    check('site admin: /platform is a 404', await page.getByText('This page could not be found.').isVisible());
    await ctx.close(); }

  // 2) Owner, own session
  { const { ctx, page, calls } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/admin/tickets');
    check('owner (own session): /admin shows the brand picker, not an unscoped back office (UI-2)', await page.getByRole('heading', { name: 'Brand back office' }).isVisible());
    check('owner: no back-office data request was made without a brand', !calls.some((c) => /^GET \/(admin|tickets)/.test(c)), calls.join());
    await open(page, '/platform'); const pnav = await navTexts(page);
    check('owner console: system nav incl. moved governance (Audit log, System logs, Deployment)', ['Platforms', 'Gateways', 'Controls & economy', 'Audit log', 'System logs', 'Deployment'].every((x) => pnav.some((n) => n.includes(x))), pnav.join('|'));
    check('UI-F owner console: M-Pesa defaults is reached from Gateways, not a second nav item', !pnav.some((n) => n.includes('M-Pesa defaults')), pnav.join('|'));
    await open(page, '/admin/mpesa');
    check('owner: old /admin/mpesa forwards to /platform/mpesa', page.url().endsWith('/platform/mpesa'), page.url());
    await ctx.close(); }

  // 3) Owner impersonating, SECOND TAB (no sessionStorage stash — the pre-fix failure mode)
  { const { ctx, page, calls } = await session(browser, { token: T.ownerImp, me: ME.owner });
    await open(page, '/admin/tickets'); const nav = await navTexts(page);
    check('owner impersonating (new tab): brand admin nav only — no Audit/Governance/Platform', nav.includes('Withdrawals') && !nav.some((n) => /Audit log|Game config|All brands|System logs/.test(n)), nav.join('|'));
    check('owner impersonating (new tab): banner names the brand from the token', await page.getByText('Tamu Traders').first().isVisible());
    check('owner impersonating: token NOT re-minted by the session bootstrap', !calls.includes('POST /auth/refresh'), calls.join());
    await open(page, '/admin/users/u-target');
    check('owner impersonating: no admin-role option (API refuses it as admin)', !(await page.locator('option[value="admin"]').count()));
    await open(page, '/platform');
    check('owner impersonating: /platform offers "Exit brand" instead of the console', await page.getByRole('button', { name: 'Exit brand' }).isVisible());
    await ctx.close(); }

  // 4) Platform admin, own session
  { const { ctx, page, calls } = await session(browser, { token: T.pa, me: ME.pa });
    await open(page, '/platform'); const pnav = await navTexts(page);
    check('platform admin console: the shell names its platform (UI-8)', await page.locator('aside').getByText('Alpha Platform', { exact: true }).isVisible() && await page.locator('aside').getByText('Platform console', { exact: true }).isVisible());
    check('platform admin console: NO system nav', !pnav.some((n) => /Platforms|Gateways|Controls|System logs|M-Pesa|Deployment|Brand back office/.test(n)), pnav.join('|'));
    check('ADDON-1: platform admins get Add-ons for their brands', pnav.includes('Add-ons'), pnav.join('|'));
    const paHrefs = await page.locator('aside nav a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    check('UI-F platform admin console: one audit log, the same page as the owner (scoped server-side)', paHrefs.includes('/platform/audit') && !paHrefs.includes('/platform/activity'), paHrefs.join('|'));
    await open(page, '/platform/audit');
    check('UI-F platform admin: /platform/audit opens the audit log', await page.getByRole('heading', { name: 'Audit log' }).isVisible().catch(() => false) && calls.includes('GET /platform/audit-log'), calls.filter((c) => c.includes('audit')).join());
    await open(page, '/platform/onboard');
    check('platform admin: onboarding never calls the owner-only platforms list', !calls.includes('GET /platform/platforms'), calls.filter((c) => c.includes('platforms')).join());
    await open(page, '/admin');
    check('platform admin (raw): /admin is a 404', await page.getByText('This page could not be found.').isVisible());
    await ctx.close(); }

  // 5) Platform admin impersonating (the pre-fix "hidden but allowed" case)
  { const { ctx, page } = await session(browser, { token: T.paImp, me: ME.pa, stash: JSON.stringify({ siteId: SITE, slug: 'tamu', name: 'Tamu Traders', primaryDomain: null }) });
    await open(page, '/admin/tickets'); const nav = await navTexts(page);
    check('platform admin impersonating: enters the brand back office', nav.includes('Withdrawals'), nav.join('|'));
    await open(page, '/admin/users/u-target');
    check('platform admin impersonating: "Edit details" section visible (API allows it as admin)', await page.getByText('Edit details', { exact: true }).isVisible().catch(() => false));
    check('platform admin impersonating: "Role" section visible (player<->marketer)', await page.getByText('Role', { exact: true }).first().isVisible().catch(() => false));
    await ctx.close(); }

  // 6) Deploy-order safety: an impersonation token minted BEFORE the API added `act` (tab stash only)
  { const legacy = jwt({ sub: 'u-owner', role: 'admin', site: SITE });
    const { ctx, page, calls } = await session(browser, { token: legacy, me: ME.owner, stash: JSON.stringify({ siteId: SITE, slug: 'tamu', name: 'Tamu Traders', primaryDomain: null }) });
    await open(page, '/admin/tickets');
    check('legacy impersonation (no act, tab stash): banner + exit still shown', await page.getByText('Tamu Traders').first().isVisible());
    check('legacy impersonation: token not re-minted', !calls.includes('POST /auth/refresh'), calls.join());
    await ctx.close(); }

  // 7) docs/42 UI-12: operators are never affiliates — no enrolment, no referral code, no requests
  for (const [who, token, me] of [['site admin', T.admin, ME.admin], ['owner', T.owner, ME.owner],
    ['platform admin', T.pa, ME.pa], ['owner impersonating', T.ownerImp, ME.owner]]) {
    const { ctx, page, calls } = await session(browser, { token, me });
    await open(page, '/affiliate');
    check(`${who}: /affiliate explains staff accounts can't join (UI-12)`, await page.getByText('Not available for staff accounts').isVisible());
    check(`${who}: /affiliate offers no "Apply to the programme"`, !(await page.getByText('Apply to the programme').isVisible().catch(() => false)));
    await open(page, '/account');
    check(`${who}: /account shows no referral invite card`, !(await page.getByText(/Invite & earn/).isVisible().catch(() => false)));
    check(`${who}: no affiliate/referral request was made`, !calls.some((c) => /\/(me\/referral|affiliate)/.test(c)), calls.join());
    await ctx.close();
  }
  { const { ctx, page } = await session(browser, { token: T.player, me: ME.player });
    await open(page, '/account');
    check('player: /account keeps the referral invite card', await page.getByText(/Invite & earn/).isVisible());
    await open(page, '/affiliate');
    check('player: /affiliate offers "Apply to the programme"', await page.getByText('Apply to the programme').isVisible());
    await ctx.close(); }

  // 8) docs/42 UI-9: owner console gaps
  { const { ctx, page, calls, full } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/platform/tickets');
    await page.getByRole('button', { name: 'New ticket' }).click();
    check("owner: new ticket asks WHICH platform and says it goes to that platform's admin", await page.getByLabel('Platform').isVisible() && await page.getByText("Assigned to the chosen platform's admin").isVisible());
    check('owner: new ticket never claims "your platform admin"', !(await page.getByText('Assigned to your platform admin').isVisible().catch(() => false)));
    await page.keyboard.press('Escape');
    await page.getByText('Payouts stuck').first().click(); await page.waitForTimeout(400);
    check('owner: a ticket offers no "Escalate to System" (it would only reassign it to the owner)', !(await page.getByRole('button', { name: 'Escalate to System' }).isVisible().catch(() => false)));
    await page.keyboard.press('Escape');

    await open(page, '/platform/platforms');
    await page.getByRole('button', { name: 'Platform admins' }).click(); await page.waitForTimeout(300);
    check('owner: platform admins are listed by person (name + platform), not a count', await page.getByText('@alice').isVisible() && await page.getByText(/runs\s+Alpha Platform/).first().isVisible());
    check('owner: no raw "User id" field anywhere', (await page.getByLabel('User id').count()) === 0);
    await page.getByLabel('Find a person').fill('bob'); await page.waitForTimeout(900);
    check('owner: appoint searches people across brands', await page.getByText('@bobkamau').isVisible());
    check("owner: an ineligible person is shown with the reason (default marketer)", await page.getByText(/default marketer — reassign/).isVisible());
    check('owner: the search called the directory route', calls.some((c) => c.startsWith('GET /platform/users/search')), calls.join());

    const poolStart = full.length;
    await open(page, '/platform/pool');
    check('owner: /platform/pool asks which platform (was: every brand, "your brands")', await page.getByLabel('Pool for platform').isVisible() && !(await page.getByText("Set each of your brands").isVisible().catch(() => false)));
    // the page's own data requests (the shell may list all brands for navigation; that is not the pool)
    const poolCalls = full.slice(poolStart).filter((c) => c.startsWith('GET /platform/pool/'));
    check('owner: /platform/pool requests carry the chosen platform (?platform=)', poolCalls.length > 0 && poolCalls.every((c) => c.includes(`platform=${PLATFORM}`)), poolCalls.join());
    await page.getByLabel('Pool for platform').selectOption(OTHER_PLATFORM); await page.waitForTimeout(600);
    check('owner: switching platform re-scopes the pool requests', full.some((c) => c.startsWith('GET /platform/pool/distributions') && c.includes(`platform=${OTHER_PLATFORM}`)), full.filter((c) => c.includes('pool')).join());
    await open(page, '/platform/registrar');
    check('owner: registrar page asks which platform', await page.getByLabel('Registrar for platform').isVisible());
    await open(page, '/platform/onboard');
    check('owner: onboarding asks which platform up-front', await page.getByLabel('Onboard into platform').isVisible());
    await open(page, `/platform/clients/${SITE}?tab=addons`);
    check('UI-C: a brand tab is deep-linkable (?tab=addons opens Add-ons)', (await page.getByRole('tab', { name: 'Add-ons' }).getAttribute('aria-selected', { timeout: 3000 }).catch(() => null)) === 'true');
    check('owner: a brand page can ASSIGN a locked add-on (was: request only)', await page.getByRole('button', { name: 'Assign…' }).first().isVisible());
    check('owner: a brand page can REMOVE an owned non-default add-on', await page.getByRole('button', { name: 'Remove…' }).first().isVisible());
    await page.getByRole('button', { name: 'Assign…' }).first().click();
    check('owner: assigning states the effect on players and the price first', await page.getByRole('dialog').getByText(/becomes the price chart players see, straight away\. KES 5,000 is added once to the platform's next invoice/).isVisible().catch(() => false));
    await ctx.close(); }
  { const { ctx, page, calls } = await session(browser, { token: T.pa, me: ME.pa });
    await open(page, '/platform/pool');
    check('platform admin: /platform/pool has no platform picker (pinned to its own)', (await page.getByLabel('Pool for platform').count()) === 0);
    check('platform admin: no owner-only platforms list was requested', !calls.includes('GET /platform/platforms'), calls.join());
    await open(page, '/platform/tickets');
    await page.getByRole('button', { name: 'New ticket' }).click();
    check('platform admin: new ticket says it goes straight to the System owner', await page.getByText('Goes straight to the System owner.').isVisible());
    await page.keyboard.press('Escape');
    await open(page, `/platform/clients/${SITE}`);
    check('UI-C: add-ons are NOT shown under Identity (own tab)', (await page.getByRole('button', { name: /^Request/ }).count()) === 0);
    await page.getByRole('tab', { name: 'Add-ons' }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(300);
    check('platform admin: a brand page offers Request, never Assign', (await page.getByRole('button', { name: 'Assign…' }).count()) === 0 && await page.getByRole('button', { name: /Request · KES 5,000 one-off/ }).isVisible().catch(() => false));
    await ctx.close(); }
  { const { ctx, page } = await session(browser, { token: T.admin, me: ME.admin });
    await open(page, '/admin/tickets');
    await page.getByRole('button', { name: 'New ticket' }).click();
    check('site admin: new ticket goes to its platform admin (unchanged)', await page.getByText('Assigned to your platform admin').isVisible());
    await page.keyboard.press('Escape');
    await page.getByText('Payouts stuck').first().click(); await page.waitForTimeout(400);
    check('site admin: can still escalate to System', await page.getByRole('button', { name: 'Escalate to System' }).isVisible());
    await ctx.close(); }

  // 9) docs/42 UI-10: platform-admin player management + one audit trail
  { const { ctx, page, calls, bodies } = await session(browser, { token: T.pa, me: ME.pa });
    await open(page, `/platform/clients/${SITE}`);
    await page.getByRole('tab', { name: 'People' }).click(); await page.waitForTimeout(300);
    await page.locator('section[aria-label="Players"]').getByText('@target').first().click(); await page.waitForTimeout(500);
    check('platform admin: selecting a player shows their money + activity (detail)', await page.getByText('Bonus balance').isVisible() && await page.getByText('KES 20').first().isVisible());
    check('UI-F platform admin: balance changes live in the back office only (no second form here)', (await page.getByRole('button', { name: 'Review adjustment' }).count()) === 0 && await page.getByRole('button', { name: 'Manage in back office' }).isVisible());
    check('UI-F platform admin: brand admins are managed on the same People tab', await page.getByRole('region', { name: 'Brand admins' }).isVisible().catch(() => false) || await page.getByText('Brand admins', { exact: true }).isVisible());
    await page.getByText('Game overrides for this player').click(); await page.waitForTimeout(400);
    check('platform admin: player overrides are editable in the console (was: no UI)', await page.getByLabel('Win rate (%)').isVisible());
    await page.getByLabel('Win rate (%)').fill('90');
    check("platform admin: an override better than the brand is stopped before saving", await page.getByText(/at most 4\d(\.\d+)?%/).isVisible() && await page.getByRole('button', { name: 'Save overrides' }).isDisabled());
    await page.getByLabel('Win rate (%)').fill('30');
    await page.getByRole('button', { name: 'Save overrides' }).click(); await page.waitForTimeout(400);
    const ov = bodies.find(([k]) => k === 'PATCH /platform/sites/' + SITE + '/users/u-target/overrides');
    check('platform admin: a valid override is saved', ov && ov[1]?.winRate === 0.3, JSON.stringify(ov));
    await open(page, '/platform'); const nav = await navTexts(page);
    check('platform admin: nav has ONE audit trail across its brands (Audit log)', nav.filter((n) => n.includes('Audit log')).length === 1, nav.join('|'));
    await open(page, '/platform/activity');
    check('UI-F platform admin: the old /platform/activity forwards to the one audit log', page.url().includes('/platform/audit'), page.url());
    check('platform admin: the audit trail names the brand and the person', await page.getByText('@siteadmin').isVisible() && await page.getByRole('cell', { name: 'Tamu Traders' }).first().isVisible());
    check('platform admin: the audit trail uses the platform-scoped route', calls.includes('GET /platform/audit-log'), calls.filter((c) => c.includes('audit')).join());
    await ctx.close(); }
  { const { ctx, page } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/platform'); const nav = await navTexts(page);
    check('owner: nav keeps ONE global Audit log (no platform-scoped duplicate)', nav.filter((n) => n.includes('Audit log')).length === 1 && !(await page.locator('aside nav a[href="/platform/activity"]').count()), nav.join('|'));
    await ctx.close(); }

  // 10) PAY-1 (docs/43): payment accounts — platform admins bring their own gateway accounts
  { const { ctx, page, bodies } = await session(browser, { token: T.pa, me: ME.pa });
    await open(page, '/platform'); const nav = await navTexts(page);
    check('platform admin: nav has "Payment accounts"', nav.some((n) => n.includes('Payment accounts')), nav.join('|'));
    await open(page, '/platform/payment-accounts');
    check('platform admin: the page lists the whole platform and each brand, with who they pay into', await page.getByText('Whole platform · Alpha Platform').isVisible() && await page.getByText('Players pay into the System accounts').isVisible());
    check('platform admin: configs are drafts until go-live (plain statement)', await page.getByText(/drafts until you go live/).isVisible());
    check('platform admin: readiness is shown as a checklist (deposits ready / withdrawals still needed)', await page.getByText('Ready: M-Pesa').isVisible() && await page.getByText(/Add M-Pesa payout details/).isVisible());
    check('platform admin: a saved secret is write-only (masked, "leave blank to keep")', await page.getByText(/saved •••• 1234 — leave blank to keep/).isVisible());
    await page.getByLabel('Business shortcode').fill('600222');
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.waitForTimeout(400);
    const put = bodies.find(([k]) => k === `PUT /platform/payment-scopes/platform/${PLATFORM}/gateways/mpesa`);
    check('platform admin: saving sends the account for ITS platform (secret left blank = keep)', put && put[1]?.shortcode === '600222' && put[1]?.consumer_key === '', JSON.stringify(put));
    await page.getByRole('button', { name: 'Go live on these accounts…' }).click(); await page.waitForTimeout(300);
    check('platform admin: go-live states the blast radius (deposits to YOUR accounts, owner notified)', await page.getByText(/Deposits go to/).isVisible() && await page.getByText(/The System owner is notified/).isVisible());
    const goLive = page.getByRole('button', { name: 'Go live', exact: true });
    check('platform admin: without a payout account, go-live needs an explicit "withdrawals disabled" acknowledgement', await goLive.isDisabled());
    await page.getByRole('checkbox').check();
    check('...and is allowed once acknowledged', !(await goLive.isDisabled()));
    await goLive.click(); await page.waitForTimeout(400);
    const act = bodies.find(([k]) => k === `POST /platform/payment-scopes/platform/${PLATFORM}/activate`);
    check('platform admin: go-live sends payoutsEnabled=false (deposits only)', act && act[1]?.payoutsEnabled === false, JSON.stringify(act));
    await ctx.close(); }
  { const { ctx, page } = await session(browser, { token: T.admin, me: ME.admin });
    await open(page, '/platform/payment-accounts');
    check('site admin: /platform/payment-accounts is a 404', await page.getByText('This page could not be found.').isVisible());
    await ctx.close(); }

  // UI-A (console shell): grouped + labelled navigation, a header that stays inside the sidebar, one current
  // item that follows the route, distinct icons, and — on a phone — a drawer that holds the nav AND the account.
  const OWNER_ROUTES = ['/platform', '/platform/tickets', '/platform/platforms', '/platform/onboard', '/platform/registrar', '/admin',
    '/platform/payment-accounts', '/platform/payments', '/platform/pool', '/platform/billing', '/platform/addons',
    '/platform/config', '/platform/audit', '/platform/logs', '/platform/engine'];
  { const { ctx, page } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/platform/engine');
    const aside = await page.locator('aside').first().boundingBox();
    const tog = await page.getByRole('button', { name: /collapse sidebar/i }).first().boundingBox().catch(() => null);
    check('UI-A owner: the collapse control stays inside the sidebar', !!aside && !!tog && tog.x + tog.width <= aside.x + aside.width + 0.5, JSON.stringify({ aside, tog }));
    const labels = (await page.locator('aside [data-nav-group-label]').allInnerTexts()).map((s) => s.trim().toLowerCase());
    check('UI-A owner: navigation is grouped under labelled sections', ['brands & platforms', 'money', 'system'].every((l) => labels.includes(l)), labels.join('|'));
    const cur = page.locator('aside [aria-current="page"]');
    check('UI-A owner: exactly one current item, and it is the open route', (await cur.count()) === 1 && (await cur.getAttribute('href')) === '/platform/engine');
    const hrefs = await page.locator('aside nav a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    check('UI-A owner: every console route stays reachable from the nav', OWNER_ROUTES.every((h) => hrefs.includes(h)), hrefs.join('|'));
    await open(page, '/platform/mpesa');
    check('UI-F owner: M-Pesa defaults keeps "Gateways" current', (await page.locator('aside [aria-current="page"]').getAttribute('href').catch(() => null)) === '/platform/payments');
    await open(page, '/platform/engine');
    const glyphs = await page.locator('aside nav a svg').evaluateAll((ss) => ss.map((s) => s.innerHTML));
    check('UI-A owner: every nav item has its own icon', glyphs.length === new Set(glyphs).size, `${glyphs.length} icons, ${new Set(glyphs).size} distinct`);
    await open(page, `/platform/clients/${SITE}`);
    check('UI-A owner: a brand page keeps "Overview" current', (await page.locator('aside [aria-current="page"]').getAttribute('href').catch(() => null)) === '/platform');
    await open(page, '/admin');
    check('UI-A owner: the brand picker opens inside the console, with "Brand back office" current', await page.getByRole('heading', { name: 'Brand back office' }).isVisible() && (await page.locator('aside [aria-current="page"]').getAttribute('href').catch(() => null)) === '/admin');
    await ctx.close(); }
  { const { ctx, page } = await session(browser, { token: T.admin, me: ME.admin });
    await open(page, '/admin/withdrawals');
    const labels = (await page.locator('aside [data-nav-group-label]').allInnerTexts()).map((s) => s.trim().toLowerCase());
    check('UI-A site admin: navigation is grouped (Money / Players / Support)', ['money', 'players', 'support'].every((l) => labels.includes(l)), labels.join('|'));
    const glyphs = await page.locator('aside nav a svg').evaluateAll((ss) => ss.map((s) => s.innerHTML));
    check('UI-A site admin: every nav item has its own icon', glyphs.length > 0 && glyphs.length === new Set(glyphs).size);
    await ctx.close(); }
  for (const [who, tok, me, path] of [['site admin', T.admin, ME.admin, '/admin/withdrawals'], ['platform admin', T.pa, ME.pa, '/platform/pool'], ['owner', T.owner, ME.owner, '/platform/config']]) {
    const { ctx, page } = await session(browser, { token: tok, me, viewport: { width: 390, height: 844 } });
    await open(page, path);
    const menu = page.getByRole('button', { name: 'Open menu' });
    check(`UI-A ${who} (phone): a menu button opens the navigation`, await menu.isVisible().catch(() => false));
    await menu.click().catch(() => {}); await page.waitForTimeout(300);
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    check(`UI-A ${who} (phone): the drawer shows the current page`, (await drawer.locator('[aria-current="page"]').getAttribute('href').catch(() => null)) === path);
    check(`UI-A ${who} (phone): Log out is reachable`, await drawer.getByRole('button', { name: 'Log out' }).isVisible().catch(() => false));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    check(`UI-A ${who} (phone): Escape closes the drawer`, !(await drawer.isVisible().catch(() => false)));
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`UI-A ${who} (phone): no sideways page scroll`, sw <= 390, `scrollWidth ${sw}`);
    await ctx.close();
  }

  // UI-C (page P1s): withdrawal actions reachable, editable announcements, honest trends, read-only overrides,
  // no sideways page scroll on phones.
  { const { ctx, page } = await session(browser, { token: T.admin, me: ME.admin, viewport: { width: 1440, height: 900 } });
    await open(page, '/admin/withdrawals');
    const rej = await page.getByRole('button', { name: 'Reject', exact: true }).first().boundingBox().catch(() => null);
    check('UI-C withdrawals (1440px): Reject is on screen, not clipped', !!rej && rej.x + rej.width <= 1440, JSON.stringify(rej));
    await open(page, '/admin');
    const trends = await page.locator('section').filter({ hasText: 'Trends' }).first().innerText().catch(() => '');
    check('UI-C overview: a metric that started this period says "New", never a fake ▲100%', trends.includes('New') && !/100%/.test(trends), trends.slice(0, 200));
    await open(page, '/admin/users/u-target');
    check('UI-C user page: overrides are shown as read-only values, not inputs', await page.getByTestId('overrides-readonly').isVisible().catch(() => false) && (await page.getByLabel(/Win rate/).count()) === 0);
    await ctx.close(); }
  { const { ctx, page, bodies } = await session(browser, { token: T.admin, me: ME.admin });
    await open(page, '/admin/announcements');
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Weekend bonus', { timeout: 3000 }).catch(() => {});
    await page.getByLabel(/^Message/).fill('Deposit this weekend and get 10% extra.', { timeout: 3000 }).catch(() => {});
    check('UI-C announcements: the preview shows the edited text', await page.getByText('Deposit this weekend and get 10% extra.').last().isVisible().catch(() => false));
    await page.getByRole('button', { name: /^Send to 22 people/ }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Yes, send it' }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
    const sent = bodies.find(([k]) => k === 'POST /admin/notifications/broadcast');
    check('UI-C announcements: the edited title and body are what gets sent', sent && sent[1]?.title === 'Weekend bonus' && sent[1]?.body === 'Deposit this weekend and get 10% extra.', JSON.stringify(sent));
    check('UI-C announcements: clearing notices is scoped to the brand (no "platform-wide")', !(await page.getByText(/platform-wide/i).count()));
    await ctx.close(); }
  for (const path of ['/admin/withdrawals', '/admin/announcements', '/admin/marketer-finance']) {
    const { ctx, page } = await session(browser, { token: T.admin, me: ME.admin, viewport: { width: 390, height: 844 } });
    await open(page, path);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`UI-C phone ${path}: no sideways page scroll`, sw <= 390, `scrollWidth ${sw}`);
    if (path === '/admin/withdrawals') {
      const ap = await page.getByRole('button', { name: 'Approve', exact: true }).first().boundingBox().catch(() => null);
      check('UI-C phone withdrawals: Approve is reachable without scrolling sideways', !!ap && ap.x >= 0 && ap.x + ap.width <= 390, JSON.stringify(ap));
    }
    await ctx.close();
  }

  // PAY-2: M-Pesa defaults grouped by purpose, with a C2B (Pay Bill) tab that can register with Safaricom.
  { const { ctx, page, bodies } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/platform/mpesa');
    const bar = await page.locator('main').innerText().catch(() => '');
    check('PAY-2: untouched auto-filled endpoints are "suggested", not "3 unsaved changes"', /Suggested endpoints are filled in/.test(bar) && !/Save 3 changes/.test(bar), bar.slice(-300));
    const hasTab = await page.getByRole('tab', { name: 'Pay Bill (C2B)' }).isVisible().catch(() => false);
    check('PAY-2: the M-Pesa page has a Pay Bill (C2B) section', hasTab);
    await open(page, '/platform/mpesa?tab=c2b');
    check('PAY-2: C2B status says it is not registered yet, with payment health', await page.getByText('Not registered', { exact: true }).isVisible().catch(() => false) && await page.getByText('Not yet claimed').isVisible().catch(() => false));
    await page.getByRole('button', { name: 'Register with Safaricom' }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Yes, register now' }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
    check('PAY-2: "Register with Safaricom" calls the registration endpoint', bodies.some(([k]) => k === 'POST /admin/c2b-config/register'), bodies.map(([k]) => k).join('|'));
    await page.getByLabel('Confirmation URL').fill('https://api.e2e.test/mpesa/confirm', { timeout: 3000 }).catch(() => {});
    check('PAY-2: a URL Safaricom would reject is flagged before saving', await page.getByText(/Safaricom rejects URLs containing/).isVisible().catch(() => false) && await page.getByRole('button', { name: 'Save', exact: true }).isDisabled().catch(() => false));
    await ctx.close(); }

  // POOL-1: each brand's pool today, automatic distribution (dynamic by default), history with each brand's share.
  { const { ctx, page, bodies } = await session(browser, { token: T.pa, me: ME.pa });
    await open(page, '/platform/pool');
    const today = await page.locator('section').filter({ hasText: 'Budget today' }).first().innerText().catch(() => '');
    check('POOL-1: the pool page lists each brand with budget, paid, reserved and available today', /Tamu Traders/.test(today) && /KES 2,500/.test(today) && /KES 500/.test(today) && /Total \(pool on\)/.test(today), today.slice(0, 300));
    check('POOL-1: a brand with withdrawals off is flagged', await page.getByText('withdrawals off').isVisible().catch(() => false));
    check('POOL-1: automatic distribution is on, by demand, and marked as the default', await page.getByText('On — by demand').isVisible().catch(() => false) && await page.getByText('default', { exact: true }).isVisible().catch(() => false));
    await page.getByRole('radio', { name: /Even split/ }).first().click({ timeout: 3000 }).catch(() => {});
    check('POOL-1: an even split cannot be saved without a daily total', await page.getByText('An even split needs a daily total.').isVisible().catch(() => false) && await page.getByRole('button', { name: 'Save', exact: true }).isDisabled().catch(() => false));
    await page.getByRole('radio', { name: /By demand/ }).first().click({ timeout: 3000 }).catch(() => {});
    await page.getByRole('button', { name: 'Run now' }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Yes, run it now' }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
    check('POOL-1: "Run now" runs the automatic distribution', bodies.some(([k]) => k === 'POST /platform/pool/auto-run'), bodies.map(([k]) => k).join('|'));
    await page.getByText('Automatic', { exact: true }).first().click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(200);
    const hist = await page.locator('section').filter({ hasText: 'History' }).last().innerText().catch(() => '');
    check('POOL-1: a history row opens to show each brand’s share by name', /Tamu Traders[\s\S]*KES 5,000/.test(hist) && /Simba FX/.test(hist), hist.slice(0, 300));
    await ctx.close(); }
  { const { ctx, page } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/platform/config');
    check('POOL-1: Controls & economy no longer duplicates the pool; it links to it', !(await page.getByText('Global withdrawal pool').count()) && await page.getByText('Open Withdrawal pool →').isVisible().catch(() => false));
    await open(page, '/platform/pool');
    check('POOL-1: the owner can view every platform at once', await page.getByRole('option', { name: 'All platforms' }).count() === 1);
    await ctx.close(); }


  // BILL-1: platform admin — what is owed, one clear Pay action (M-Pesa STK), invoices; no owner money controls.
  { const { ctx, page, bodies } = await session(browser, { token: T.pa, me: ME.pa });
    await open(page, '/platform/billing');
    const banner = await page.getByRole('alert').first().innerText().catch(() => '');
    check('BILL-1: a platform in its grace period sees when its brands go offline, and what it owes', /keep your brands online/.test(banner) && /KES 45,000/.test(banner), banner.slice(0, 200));
    check('BILL-1: the plan, next-invoice estimate and usage are shown', await page.getByText('Your plan', { exact: true }).isVisible().catch(() => false) && await page.getByText('Estimated total').isVisible().catch(() => false) && /812/.test(await page.getByRole('meter', { name: 'Players' }).locator('..').innerText().catch(() => '')));
    check('BILL-1: invoices show a plain overdue state', await page.getByText('Overdue 5 days').first().isVisible().catch(() => false));
    check('BILL-1: platform admins get no owner money controls', !(await page.getByRole('button', { name: 'Run billing now' }).count()) && !(await page.getByRole('tab', { name: 'Settings' }).count()));
    await page.getByRole('alert').getByRole('button', { name: /Pay KES 45,000/ }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(300);
    const phone = await page.getByLabel('M-Pesa phone number').inputValue().catch(() => '');
    check('BILL-1: Pay now pre-fills the admin’s own phone', phone === '0700000003', phone);
    await page.getByRole('button', { name: /Send prompt for KES 45,000/ }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
    const sent = bodies.find(([k]) => k === 'POST /platform/billing/invoices/inv-1/pay');
    check('BILL-1: Pay now sends the STK request for that invoice with the phone', !!sent && sent[1]?.phone === '0700000003', JSON.stringify(bodies.map(([k]) => k)));
    check('BILL-1: then it says to check the phone', await page.getByText('Check your phone').isVisible().catch(() => false));
    await open(page, '/platform/billing/invoices/inv-1');
    const doc = await page.getByRole('article').innerText().catch(() => '');
    check('BILL-1: the invoice page is a proper invoice (seller, bill-to, lines by brand, amount due, reference)',
      /TrioCodes Ltd/.test(doc) && /Bill to[\s\S]*Alpha Platform/i.test(doc) && /Area graph — Tamu Traders/.test(doc) && /Amount due[\s\S]*KES 45,000/i.test(doc) && /TRIO2600007/.test(doc), doc.slice(0, 300));
    check('BILL-1: a platform admin cannot record, void or write off', !(await page.getByRole('button', { name: 'Record payment' }).count()) && !(await page.getByRole('button', { name: 'Void' }).count()) && await page.getByRole('button', { name: /Pay KES 45,000/ }).isVisible());
    await ctx.close(); }
  { const { ctx, page } = await session(browser, { token: T.pa, me: ME.pa, viewport: { width: 390, height: 844 } });
    await open(page, '/platform/billing');
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    check('BILL-1: the billing page fits a phone (no sideways scroll)', w <= 392, String(w));
    check('BILL-1: on a phone invoices are cards with a Pay button', await page.getByRole('list', { name: 'Invoices' }).getByRole('button', { name: /Pay KES 45,000/ }).isVisible().catch(() => false));
    await ctx.close(); }

  // BILL-1: owner — revenue overview, invoice filters, settings, manual invoice, record payment, credit.
  { const { ctx, page, full, bodies } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/platform/billing');
    check('BILL-1: the owner sees recurring revenue, what is owed and how late', await page.getByText('Monthly recurring').isVisible().catch(() => false) && await page.getByText('Money owed, by how late it is').isVisible().catch(() => false));
    const att = await page.locator('section').filter({ hasText: 'Needs attention' }).first().innerText().catch(() => '');
    check('BILL-1: "Needs attention" lists the platform in its final notice with the amount', /Alpha Platform/.test(att) && /Final notice/.test(att) && /KES 45,000/.test(att), att.slice(0, 200));
    await page.getByRole('tab', { name: 'Invoices' }).click(); await page.waitForTimeout(200);
    await page.getByRole('tab', { name: 'Overdue' }).click(); await page.waitForTimeout(400);
    check('BILL-1: the Overdue filter asks the API for overdue invoices', full.some((c) => c.startsWith('GET /platform/billing/invoices?') && c.includes('status=overdue')), full.filter((c) => c.includes('/billing/invoices')).join('|'));
    check('BILL-1: the tab is kept in the URL', page.url().includes('tab=invoices'));
    await page.getByRole('tab', { name: 'Settings' }).click(); await page.waitForTimeout(300);
    await page.getByLabel('Tax rate (%)').fill('16'); await page.waitForTimeout(100);
    check('BILL-1: settings show the unsaved-change bar and the overdue timeline', await page.getByText('1 unsaved change').isVisible().catch(() => false) && await page.getByRole('list', { name: 'Overdue timeline' }).isVisible());
    await page.getByRole('button', { name: 'Save changes' }).click(); await page.waitForTimeout(400);
    const st = bodies.find(([k]) => k === 'PATCH /platform/billing/settings');
    check('BILL-1: saving sends only what changed (16% = 1600 basis points)', !!st && JSON.stringify(st[1]) === '{"taxRateBp":1600}', JSON.stringify(st?.[1]));
    await page.getByRole('button', { name: 'New invoice' }).click(); await page.waitForTimeout(200);
    await page.getByLabel('Platform').last().selectOption(PLATFORM).catch(() => {});
    await page.getByLabel('Line 1 description').fill('Custom domain setup');
    await page.getByLabel('Line 1 quantity').fill('2');
    await page.getByLabel('Line 1 unit price').fill('2,500');
    await page.getByRole('button', { name: /Send invoice/ }).click(); await page.waitForTimeout(400);
    const ni = bodies.find(([k]) => k === 'POST /platform/billing/invoices');
    check('BILL-1: a manual invoice sends its lines in cents with the quantity', !!ni && ni[1]?.platformId === PLATFORM && JSON.stringify(ni[1]?.lines) === '[{"description":"Custom domain setup","unitCents":250000,"quantity":2}]', JSON.stringify(ni?.[1]));
    await open(page, '/platform/billing/invoices/inv-1');
    await page.getByRole('button', { name: 'Record payment' }).click(); await page.waitForTimeout(200);
    check('BILL-1: recording a payment defaults to the full balance', (await page.getByLabel('Amount (KES)').inputValue()) === '45000');
    await page.getByLabel('Reference').fill('KCB-778');
    await page.getByRole('dialog').getByRole('button', { name: 'Record payment' }).click(); await page.waitForTimeout(400);
    const rp = bodies.find(([k]) => k === 'POST /platform/billing/invoices/inv-1/payments');
    check('BILL-1: the payment is recorded as a bank transfer for the full balance with its reference', !!rp && rp[1]?.method === 'bank' && rp[1]?.amountCents === 4500000 && rp[1]?.reference === 'KCB-778', JSON.stringify(rp?.[1]));
    await open(page, '/platform/billing?tab=subscriptions');
    await page.getByRole('button', { name: 'Manage' }).first().click(); await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Add charge or credit' }).click(); await page.waitForTimeout(150);
    await page.getByRole('radio', { name: /Credit/ }).click();
    await page.getByLabel('Description').fill('Downtime credit'); await page.getByLabel('Amount (KES)').fill('1000');
    await page.getByRole('button', { name: 'Add credit' }).click(); await page.waitForTimeout(400);
    const cr = bodies.find(([k]) => k === 'POST /platform/billing/charges');
    check('BILL-1: a credit is sent as a negative amount for the next invoice', !!cr && cr[1]?.amountCents === -100000 && cr[1]?.platformId === PLATFORM, JSON.stringify(cr?.[1]));
    await ctx.close(); }


  // ADDON-1: owner — requests with the brand's reason and the billing consequence, catalog pricing model, brand matrix.
  { const { ctx, page, bodies } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/platform/addons');
    check('ADDON-1: the owner lands on the requests inbox with the count', await page.getByRole('tab', { name: 'Requests (1)' }).isVisible().catch(() => false));
    const inbox = await page.getByRole('list', { name: 'Requests' }).innerText().catch(() => '');
    check('ADDON-1: a request shows product, brand, platform, quoted price and the brand’s reason',
      /Area graph/.test(inbox) && /Tamu Traders/.test(inbox) && /Alpha Platform/.test(inbox) && /KES 3,000 \/ month \+ KES 1,000 setup/.test(inbox) && /Players asked/.test(inbox), inbox.slice(0, 300));
    await page.getByRole('button', { name: 'Approve…' }).click(); await page.waitForTimeout(200);
    check('ADDON-1: approving states exactly what gets billed', await page.getByRole('dialog').getByText(/KES 3,000 a month is added to the platform's invoices from the next renewal, plus a one-off KES 1,000 setup fee/).isVisible().catch(() => false));
    await page.getByLabel(/Note to the brand/).fill('Live now');
    await page.getByRole('button', { name: 'Approve and assign' }).click(); await page.waitForTimeout(400);
    const dec = bodies.find(([k]) => k === 'POST /addons/requests/9/decide');
    check('ADDON-1: the decision carries the owner’s note', !!dec && dec[1]?.decision === 'approve' && dec[1]?.note === 'Live now', JSON.stringify(dec?.[1]));
    await page.getByRole('button', { name: 'Decline…' }).click(); await page.waitForTimeout(200);
    check('ADDON-1: declining needs a reason the brand will see', await page.getByRole('button', { name: 'Decline', exact: true }).isDisabled().catch(() => false));
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Catalog' }).click(); await page.waitForTimeout(300);
    check('ADDON-1: the catalog shows pricing model, setup fee and adoption', await page.getByText('Monthly', { exact: true }).first().isVisible().catch(() => false) && await page.getByText('KES 1,000').first().isVisible().catch(() => false));
    await page.getByRole('button', { name: 'Edit Pro chart' }).click(); await page.waitForTimeout(200);
    await page.getByRole('radio', { name: /Monthly/ }).click();
    await page.getByLabel('Price per month (KES)').fill('2,000'); await page.getByLabel('Setup fee (KES)').fill('500');
    check('ADDON-1: the editor previews what brands will see', await page.getByText('KES 2,000 / month').last().isVisible().catch(() => false));
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(400);
    const up = bodies.find(([k]) => k === 'PATCH /addons/catalog/chart/pro');
    check('ADDON-1: saving sends the pricing model, price and setup fee in cents', !!up && up[1]?.billingType === 'monthly' && up[1]?.priceCents === 200000 && up[1]?.setupFeeCents === 50000, JSON.stringify(up?.[1]));
    await page.getByRole('button', { name: 'Edit Classic chart' }).click(); await page.waitForTimeout(200);
    check('ADDON-1: a category default cannot be priced or hidden', await page.getByRole('radio', { name: /Monthly/ }).isDisabled().catch(() => false) && await page.getByRole('switch', { name: 'Offer to brands' }).isDisabled().catch(() => false));
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Brands' }).click(); await page.waitForTimeout(300);
    const row = await page.locator('tbody tr', { hasText: 'Tamu Traders' }).first().innerText().catch(() => '');
    check('ADDON-1: the brands tab shows what each brand uses and owns', /Pro chart/.test(row) && /Classic terminal/.test(row) && /Deriv UI/.test(row) && /1 request/.test(row), row);
    await ctx.close(); }

  // ADDON-1: platform admin — marketplace for its brand: request with a reason, switch to an owned system.
  { const { ctx, page, bodies } = await session(browser, { token: T.pa, me: ME.pa });
    await open(page, '/platform/addons');
    check('UI-F platform admin: /platform/addons is an overview that links to each brand\'s Add-ons tab (one marketplace, on the brand)',
      await page.getByRole('list', { name: "Your brands' add-ons" }).getByRole('link', { name: /Manage add-ons/ }).first().getAttribute('href').then((h) => h === `/platform/clients/${SITE}?tab=addons`).catch(() => false));
    await open(page, `/platform/clients/${SITE}?tab=addons`);
    check('ADDON-1: the marketplace shows each add-on with its price and state', await page.locator('[data-addon="chart:area"]').getByText('Requested', { exact: true }).isVisible().catch(() => false)
      && await page.locator('[data-addon="trade_ui:deriv"]').getByText('Owned', { exact: true }).isVisible().catch(() => false));
    await page.locator('[data-addon="trade_ui:deriv"]').getByRole('button', { name: 'Use this' }).click(); await page.waitForTimeout(400);
    const act = bodies.find(([k]) => k === 'POST /addons/activate');
    check('ADDON-1: a brand switches to a system it owns without asking', !!act && act[1]?.category === 'trade_ui' && act[1]?.key === 'deriv' && act[1]?.site === SITE, JSON.stringify(act?.[1]));
    await page.locator('[data-addon="chart:pro"]').getByRole('button', { name: /Request/ }).click(); await page.waitForTimeout(200);
    check('ADDON-1: requesting shows the price and what happens if approved', await page.getByRole('dialog').getByText(/KES 5,000 is added once to the platform's next invoice/).isVisible().catch(() => false));
    await page.getByLabel(/Why do you want it/).fill('Traders want candles');
    await page.getByRole('button', { name: 'Send request' }).click(); await page.waitForTimeout(400);
    const rq = bodies.find(([k]) => k === 'POST /addons/request');
    check('ADDON-1: the request carries the brand and the reason', !!rq && rq[1]?.site === SITE && rq[1]?.key === 'pro' && rq[1]?.note === 'Traders want candles', JSON.stringify(rq?.[1]));
    await page.locator('[data-addon="chart:area"]').getByRole('button', { name: 'Withdraw request' }).click(); await page.waitForTimeout(400);
    check('ADDON-1: an open request can be withdrawn', bodies.some(([k]) => k === 'POST /addons/requests/9/cancel'), bodies.map(([k]) => k).join('|'));
    const hist = await page.getByRole('list', { name: 'Add-on requests' }).innerText().catch(() => '');
    check('ADDON-1: request history shows status and the reason', /Waiting for review/.test(hist) && /Players asked/.test(hist), hist.slice(0, 200));
    await ctx.close(); }
  { const { ctx, page } = await session(browser, { token: T.pa, me: ME.pa, viewport: { width: 390, height: 844 } });
    await open(page, '/platform/addons');
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    check('ADDON-1: the add-ons page fits a phone', w <= 392, String(w));
    await ctx.close(); }

  // UI-F #32: the owner's brand back office picks a platform first, then its brands.
  { const PICK_SITES = { sites: [
      { ...SITE_ROW, platformId: PLATFORM },
      { ...SITE_ROW, siteId: 'site-kilo', slug: 'kilo', name: 'Kilo Bets', primaryDomain: 'kilo.test', platformId: OTHER_PLATFORM },
      { ...SITE_ROW, siteId: 'site-old', slug: 'old', name: 'Old Brand', primaryDomain: null, status: 'archived', platformId: PLATFORM },
    ] };
    const { ctx, page } = await session(browser, { token: T.owner, me: ME.owner, fixtures: { '/platform/sites': PICK_SITES } });
    await open(page, `/admin?platform=${OTHER_PLATFORM}`);
    const plats = await page.getByRole('navigation', { name: 'Platforms' }).innerText().catch(() => '');
    check('UI-F picker: platforms are listed with their brand counts', /Alpha Platform\s*1/.test(plats) && /Beta Platform\s*1/.test(plats), plats);
    const brands = () => page.getByRole('list', { name: 'Brands' }).innerText().catch(() => '');
    check('UI-F picker: ?platform= opens that platform and lists only its brands', /Kilo Bets/.test(await brands()) && !/Tamu Traders/.test(await brands()));
    await page.getByLabel('Search brands').fill('tamu'); await page.waitForTimeout(200);
    check('UI-F picker: a search with no match here says which platform has it', await page.getByRole('button', { name: 'Alpha Platform (1)' }).isVisible().catch(() => false));
    await page.getByRole('button', { name: 'Alpha Platform (1)' }).click(); await page.waitForTimeout(200);
    check('UI-F picker: jumping to that platform shows the brand', /Tamu Traders/.test(await brands()) && page.url().includes(`platform=${PLATFORM}`), page.url());
    await page.getByLabel('Search brands').fill(''); await page.waitForTimeout(150);
    check('UI-F picker: archived brands are hidden by default', !/Old Brand/.test(await brands()));
    await page.getByLabel(/Show archived/).check(); await page.waitForTimeout(150);
    check('UI-F picker: …and shown on request', /Old Brand/.test(await brands()));
    check('UI-F picker: every brand opens with one clear action', (await page.getByRole('list', { name: 'Brands' }).getByRole('button', { name: 'Open back office' }).count()) === 2);
    await open(page, '/admin');
    check('UI-F picker: the last platform is remembered on this device', /Tamu Traders/.test(await brands()) && !/Kilo Bets/.test(await brands()));
    await ctx.close(); }
  { const { ctx, page } = await session(browser, { token: T.owner, me: ME.owner, viewport: { width: 390, height: 844 } });
    await open(page, '/admin');
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    check('UI-F picker: on a phone the platform is a select and the page fits', await page.getByLabel('Platform', { exact: true }).isVisible().catch(() => false) && w <= 392, String(w));
    await ctx.close(); }

  // UI-D: Gateways as one list incl. M-Pesa, with an in-place "offered to players" switch and plain language.
  { const { ctx, page } = await session(browser, { token: T.owner, me: ME.owner });
    await open(page, '/platform/payments');
    const list = await page.getByRole('list', { name: 'Gateways' }).innerText().catch(() => '');
    check('UI-D: Gateways lists M-Pesa first, with the other gateways', list.indexOf('M-Pesa (Daraja)') >= 0 && list.indexOf('M-Pesa (Daraja)') < list.indexOf('Mega Pay'), list.slice(0, 120));
    check('UI-D: no developer jargon in the gateway list (HMAC, Basic Auth)', !/HMAC|Basic Auth/.test(list));
    check('UI-F: the gateway list shows state only — switching happens on the gateway page (one place)', (await page.getByRole('list', { name: 'Gateways' }).getByRole('switch').count()) === 0
      && (await page.getByRole('list', { name: 'Gateways' }).locator('a[href="/platform/payments/megapay"]').count()) > 0);
    await ctx.close(); }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
