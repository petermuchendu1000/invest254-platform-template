import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgo, formatDate, formatDateTime, formatNumber } from './format';

const NOW = Date.UTC(2026, 8, 23, 18, 0, 0); // 23 Sep 2026 21:00 EAT

test('UI-B: formatAgo never produces "now ago" and reads naturally', () => {
  assert.equal(formatAgo(NOW - 1_000, NOW), 'just now');
  assert.equal(formatAgo(NOW - 30_000, NOW), '30s ago');
  assert.equal(formatAgo(NOW - 5 * 60_000, NOW), '5m ago');
  assert.equal(formatAgo(NOW - 3 * 3600_000, NOW), '3h ago');
  assert.equal(formatAgo(NOW - 2 * 86400_000, NOW), '2d ago');
  assert.ok(!formatAgo(NOW, NOW).includes('now ago'));
  // Past a week, a date is more useful than "23d ago".
  assert.equal(formatAgo(NOW - 23 * 86400_000, NOW), formatDate(NOW - 23 * 86400_000));
  // A clock skew (future timestamp) is not "-5m".
  assert.equal(formatAgo(NOW + 60_000, NOW), 'just now');
});

test('UI-B: dates are pinned to one Kenyan format, independent of the browser locale', () => {
  assert.match(formatDate(NOW), /^2[34] Sept? 2026$/);
  assert.match(formatDateTime(NOW), /^2[34] Sept? 2026, \d{2}:\d{2}$/);
  assert.match(formatDate(NOW), /^\d{1,2} [A-Z][a-z]{2,3} \d{4}$/, 'no US-style 9/23/2026');
});

test('UI-B: numbers use Kenyan grouping regardless of the browser', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(0), '0');
});
