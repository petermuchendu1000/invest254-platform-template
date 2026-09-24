import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandAdminNav, consoleNav, currentHref } from './nav';

const hrefs = (g: ReturnType<typeof consoleNav>) => g.flatMap((x) => x.items.map((i) => i.href));

test('UI-A: every tier has unique routes and labelled groups after the first', () => {
  for (const groups of [brandAdminNav('admin'), consoleNav(false), consoleNav(true)]) {
    const h = hrefs(groups);
    assert.equal(new Set(h).size, h.length, 'no route listed twice');
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    assert.equal(new Set(labels).size, labels.length, 'no label listed twice');
    groups.slice(1).forEach((g) => assert.ok(g.label, `group ${g.id} has a label`));
  }
});

test('UI-A: a platform admin never gets a System-only destination; the owner gets them all', () => {
  const systemOnly = ['/platform/platforms', '/platform/payments', '/platform/config', '/platform/logs', '/platform/engine', '/admin'];
  const pa = hrefs(consoleNav(false));
  systemOnly.forEach((h) => assert.ok(!pa.includes(h), `PA must not see ${h}`));
  const owner = hrefs(consoleNav(true));
  systemOnly.forEach((h) => assert.ok(owner.includes(h), `owner sees ${h}`));
  assert.ok(pa.includes('/platform/audit') && owner.includes('/platform/audit') && !pa.includes('/platform/activity'), 'UI-F: one audit log for both tiers');
  assert.ok(!owner.includes('/platform/mpesa'), 'UI-F: M-Pesa lives under Gateways (no second nav entry)');
  assert.ok(pa.includes('/platform/addons') && owner.includes('/platform/addons'), 'ADDON-1: both tiers manage add-ons');
});

test('UI-A: exactly one current item — the most specific match', () => {
  const owner = consoleNav(true);
  assert.equal(currentHref(owner, '/platform'), '/platform');
  assert.equal(currentHref(owner, '/platform/clients/abc'), '/platform', 'a brand page belongs to Overview');
  assert.equal(currentHref(owner, '/platform/payments/mpesa'), '/platform/payments');
  assert.equal(currentHref(owner, '/platform/mpesa'), '/platform/payments', 'the M-Pesa page belongs to Gateways');
  assert.equal(currentHref(owner, '/platform/payment-accounts'), '/platform/payment-accounts', 'no prefix bleed between siblings');
  assert.equal(currentHref(owner, '/admin'), '/admin');
  const brand = brandAdminNav('admin');
  assert.equal(currentHref(brand, '/admin/users/u1'), '/admin/users');
  assert.equal(currentHref(brand, '/admin'), '/admin');
  assert.equal(currentHref(brand, '/admin/unknown'), null);
  assert.equal(currentHref(brand, '/admin/identity'), '/admin/identity', 'ACCT-1: identity checks has its own entry');
});
