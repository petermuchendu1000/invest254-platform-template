/**
 * Bootstrap or promote a platform operator (docs/21 Step 5). Registers a phone+password account
 * (or resets its password if it already exists) under a brand, sets its role, and verifies login,
 * using the app's own AuthService so the scrypt hash and JWT claims match production exactly.
 *
 * Run: node --import tsx scripts/make_operator.ts <phone> <password> [role] [siteId] [username]
 *   role default: platform_superadmin ; siteId default: the primary brand (00000000-...-0001)
 * Needs: DATABASE_URL. Never logs the password.
 */
import { Pool } from 'pg';
import { AuthService, PgIdentityRepository, type Querier } from '@invest254/engine';
import { normalizeMsisdn } from '@invest254/shared';

const DEFAULT_SITE = '00000000-0000-0000-0000-000000000001';

async function main() {
  const [, , phone, password, roleArg, siteArg, usernameArg] = process.argv;
  if (!phone || !password) throw new Error('usage: make_operator.ts <phone> <password> [role] [siteId] [username]');
  const role = roleArg || 'platform_superadmin';
  const siteId = siteArg || DEFAULT_SITE;
  const username = usernameArg || 'platformowner';

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = pool as unknown as Querier;
  const repo = new PgIdentityRepository(q);
  const auth = new AuthService(repo, { jwtSecret: 'operator-bootstrap-secret-of-sufficient-length-123456', allowUnverifiedPasswordReset: true });

  const norm = normalizeMsisdn(phone);
  let userId: string | null = null;

  try {
    const s = await auth.register({ phone, username, password, siteId });
    userId = s.userId;
    console.log(`registered new account ${userId} (normalized phone ${norm}, site ${siteId})`);
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`register skipped (${msg}); resetting password for the existing account`);
    await auth.resetPassword(phone, password);
    const r = await q.query('select id from profiles where phone = $1 and site_id = $2', [norm, siteId]);
    userId = r.rows.length ? String(r.rows[0].id) : null;
  }
  if (!userId) throw new Error('could not resolve the account user id');

  await q.query('update profiles set role = $1 where id = $2', [role, userId]);
  const check = await q.query('select username, phone, role, status, site_id from profiles where id = $1', [userId]);
  const row = check.rows[0] as Record<string, unknown>;
  console.log(`profile: user=${row.username} phone=${row.phone} role=${row.role} status=${row.status} site=${row.site_id}`);

  // Verify login mints a token carrying the new role.
  const session = await auth.login({ phone, password, siteId });
  const payload = JSON.parse(Buffer.from(session.token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  console.log(`login OK -> token role='${payload.role}' sub=${String(payload.sub).slice(0, 8)} site=${payload.site ?? '(none)'}`);
  console.log(`\n${row.role === role ? 'SUCCESS' : 'WARN'}: ${row.phone} is now '${role}'.`);

  await pool.end();
}

main().catch((e) => { console.error('MAKE_OPERATOR ERROR:', (e as Error).message); process.exit(1); });
