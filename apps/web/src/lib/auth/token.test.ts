import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleFromToken, actorFromToken, siteFromToken } from './token.js';

const jwt = (p: object) => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`;

test('UI-3: an impersonation token exposes its actor + brand; the authorised role stays the token role', () => {
  const t = jwt({ sub: 'u1', role: 'admin', site: 'site-9', act: { sub: 'u1', role: 'platform_superadmin', brand: 'Tamu' } });
  assert.equal(roleFromToken(t), 'admin');
  assert.equal(siteFromToken(t), 'site-9');
  assert.deepEqual(actorFromToken(t), { sub: 'u1', role: 'platform_superadmin', brand: 'Tamu' });
});

test('UI-3: ordinary / malformed tokens have no actor', () => {
  assert.equal(actorFromToken(jwt({ sub: 'u1', role: 'admin', site: 's' })), null);
  assert.equal(actorFromToken(jwt({ sub: 'u1', role: 'admin', act: { role: 'x' } })), null, 'act without sub');
  assert.equal(actorFromToken(jwt({ sub: 'u1', role: 'admin', act: 'nope' })), null);
  assert.equal(actorFromToken('garbage'), null);
  assert.equal(actorFromToken(null), null);
  assert.equal(siteFromToken(jwt({ role: 'admin' })), null);
});
